import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repositoryRoot, runGit, runGitBytes } from "./build-contract.mjs";

const nulRecords = (bytes) =>
  bytes
    .toString("utf8")
    .split("\0")
    .filter(Boolean);

const parseIndexEntries = (bytes) => {
  const entries = new Map();
  for (const record of nulRecords(bytes)) {
    const separator = record.indexOf("\t");
    const metadata = record.slice(0, separator).split(" ");
    const path = record.slice(separator + 1);
    if (separator < 0 || metadata.length !== 3 || !path) {
      throw new Error(`cannot parse Git index entry: ${record}`);
    }
    const [mode, objectId, stage] = metadata;
    if (entries.has(path)) throw new Error(`Git index repeats path: ${path}`);
    entries.set(path, { mode, objectId, stage });
  }
  return entries;
};

const parseHeadEntries = (bytes) => {
  const entries = new Map();
  for (const record of nulRecords(bytes)) {
    const separator = record.indexOf("\t");
    const metadata = record.slice(0, separator).split(" ");
    const path = record.slice(separator + 1);
    if (separator < 0 || metadata.length !== 3 || !path) {
      throw new Error(`cannot parse Git HEAD entry: ${record}`);
    }
    const [mode, type, objectId] = metadata;
    if (type !== "blob" && type !== "commit") {
      throw new Error(`unsupported Git HEAD object type for ${path}: ${type}`);
    }
    if (entries.has(path)) throw new Error(`Git HEAD repeats path: ${path}`);
    entries.set(path, { mode, objectId, type });
  }
  return entries;
};

const blobObjectId = (bytes, objectFormat) =>
  createHash(objectFormat)
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");

export const committedIgnoreArguments = (root = repositoryRoot) => {
  const resolvedRoot = resolve(root);
  const ignorePaths = nulRecords(
    runGitBytes(["ls-tree", "-r", "--name-only", "-z", "HEAD"], { cwd: resolvedRoot }),
  ).filter((path) => path === ".gitignore" || path.endsWith("/.gitignore"));
  const unsupportedNested = ignorePaths.filter((path) => path !== ".gitignore");
  if (unsupportedNested.length) {
    throw new Error(
      `nested committed .gitignore rules require an audited path-relative parser: ${unsupportedNested.join(", ")}`,
    );
  }
  if (!ignorePaths.includes(".gitignore")) return [];
  const contents = runGitBytes(["show", "HEAD:.gitignore"], { cwd: resolvedRoot })
    .toString("utf8")
    .replace(/^\uFEFF/, "");
  return contents
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => `--exclude=${line}`);
};

export const inspectSourceCleanliness = async (root = repositoryRoot) => {
  const resolvedRoot = resolve(root);
  const issues = [];
  const objectFormat = runGit(["rev-parse", "--show-object-format"], { cwd: resolvedRoot });
  if (!new Set(["sha1", "sha256"]).has(objectFormat)) {
    throw new Error(`unsupported Git object format: ${objectFormat}`);
  }
  const indexEntries = parseIndexEntries(
    runGitBytes(["ls-files", "--stage", "-z"], { cwd: resolvedRoot }),
  );
  const headEntries = parseHeadEntries(
    runGitBytes(["ls-tree", "-r", "-z", "--full-tree", "HEAD"], { cwd: resolvedRoot }),
  );
  const indexFlags = new Map();
  for (const record of nulRecords(runGitBytes(["ls-files", "-v", "-z"], { cwd: resolvedRoot }))) {
    const tag = record.slice(0, 1);
    const path = record.slice(2);
    indexFlags.set(path, tag);
    if (tag === "S") issues.push({ kind: "skip-worktree", path });
    else if (tag === tag.toLowerCase() && /[a-z]/.test(tag)) {
      issues.push({ kind: "assume-unchanged", path });
    } else if (tag !== "H") {
      issues.push({ kind: "unexpected-index-state", path, tag });
    }
  }

  for (const path of [...new Set([...headEntries.keys(), ...indexEntries.keys()])].sort()) {
    const head = headEntries.get(path);
    const index = indexEntries.get(path);
    if (!head || !index || head.mode !== index.mode || head.objectId !== index.objectId || index.stage !== "0") {
      issues.push({
        kind: "index-differs-from-head",
        path,
        head: head ? { mode: head.mode, objectId: head.objectId } : null,
        index: index ? { mode: index.mode, objectId: index.objectId, stage: index.stage } : null,
      });
    }
  }

  // POSIX mode bits are observable directly even when a hostile/local Git
  // config says core.filemode=false. Native Windows does not expose a stable
  // executable bit, so type/content remain bound there and index↔HEAD mode is
  // still compared above.
  const compareExecutableMode = process.platform !== "win32";
  for (const [path, index] of [...indexEntries.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    if (index.stage !== "0") continue;
    const absolutePath = join(resolvedRoot, ...path.split("/"));
    let info;
    try {
      info = await lstat(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        issues.push({ kind: "tracked-path-missing", path });
        continue;
      }
      throw error;
    }
    let bytes;
    if (index.mode === "120000") {
      if (!info.isSymbolicLink()) {
        issues.push({ kind: "tracked-type-mismatch", path, expectedMode: index.mode });
        continue;
      }
      bytes = Buffer.from(await readlink(absolutePath), "utf8");
    } else if (index.mode === "100644" || index.mode === "100755") {
      if (!info.isFile() || info.isSymbolicLink()) {
        issues.push({ kind: "tracked-type-mismatch", path, expectedMode: index.mode });
        continue;
      }
      bytes = await readFile(absolutePath);
      if (compareExecutableMode) {
        const workingMode = info.mode & 0o111 ? "100755" : "100644";
        if (workingMode !== index.mode) {
          issues.push({ kind: "tracked-mode-mismatch", path, indexMode: index.mode, workingMode });
        }
      }
    } else if (index.mode === "160000") {
      issues.push({ kind: "unsupported-gitlink", path });
      continue;
    } else {
      issues.push({ kind: "unsupported-index-mode", path, mode: index.mode });
      continue;
    }
    const workingObjectId = blobObjectId(bytes, objectFormat);
    if (workingObjectId !== index.objectId) {
      issues.push({
        kind: "tracked-content-mismatch",
        path,
        indexObjectId: index.objectId,
        workingObjectId,
      });
    }
  }

  const untrackedPaths = nulRecords(
    runGitBytes(
      ["ls-files", "--others", "-z", ...committedIgnoreArguments(resolvedRoot)],
      { cwd: resolvedRoot },
    ),
  ).sort();
  for (const path of untrackedPaths) issues.push({ kind: "untracked-path", path });
  const untrackedIgnoreFiles = untrackedPaths.filter(
    (path) => path === ".gitignore" || path.endsWith("/.gitignore"),
  );
  const trackedIssueCount = issues.filter((issue) => issue.kind !== "untracked-path").length;
  return {
    schemaVersion: 1,
    clean: issues.length === 0,
    dirtyTrackedTree: trackedIssueCount > 0,
    dirtySourceTree: issues.length > 0,
    objectFormat,
    executableModeCompared: compareExecutableMode,
    headEntryCount: headEntries.size,
    indexEntryCount: indexEntries.size,
    indexFlagEntryCount: indexFlags.size,
    untrackedPathCount: untrackedPaths.length,
    untrackedIgnoreFileCount: untrackedIgnoreFiles.length,
    issues,
  };
};
