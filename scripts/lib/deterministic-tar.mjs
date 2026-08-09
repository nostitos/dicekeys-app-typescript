import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import {
  assertNoSymlinkPath,
  filesystemManifestEntries,
  filesystemManifestHash,
  normalizedTreeHash,
  relativePathInside,
  repositoryRoot,
} from "./build-contract.mjs";

const putString = (buffer, offset, length, value) => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`tar field exceeds ${length} bytes: ${value}`);
  bytes.copy(buffer, offset);
};
const putOctal = (buffer, offset, length, value) => {
  const octal = value.toString(8);
  if (octal.length > length - 1) throw new Error(`tar numeric field overflow: ${value}`);
  putString(buffer, offset, length, `${octal.padStart(length - 1, "0")}\0`);
};
const splitUstarPath = (path) => {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const slashIndexes = [...path.matchAll(/\//g)].map((match) => match.index).reverse();
  for (const index of slashIndexes) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`path does not fit deterministic ustar header: ${path}`);
};
const createHeader = (entry, epoch) => {
  const header = Buffer.alloc(512);
  const tarPath = entry.type === "directory" ? `${entry.path}/` : entry.path;
  const { name, prefix } = splitUstarPath(tarPath);
  putString(header, 0, 100, name);
  putOctal(header, 100, 8, Number.parseInt(entry.mode, 8));
  putOctal(header, 108, 8, 0);
  putOctal(header, 116, 8, 0);
  putOctal(header, 124, 12, entry.type === "file" ? entry.size : 0);
  putOctal(header, 136, 12, epoch);
  header.fill(0x20, 148, 156);
  putString(
    header,
    156,
    1,
    entry.type === "directory" ? "5" : entry.type === "symbolic-link" ? "2" : "0",
  );
  if (entry.type === "symbolic-link") putString(header, 157, 100, entry.target);
  putString(header, 257, 6, "ustar\0");
  putString(header, 263, 2, "00");
  putString(header, 265, 32, "root");
  putString(header, 297, 32, "root");
  putOctal(header, 329, 8, 0);
  putOctal(header, 337, 8, 0);
  putString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  putString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
};

export const isSafeArchiveEntryPath = (entryPath, archiveRoot) => {
  const safePath = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !posix.isAbsolute(value) &&
    !/^[A-Za-z]:/.test(value) &&
    value.split("/").every((component) => component && component !== "." && component !== "..");
  return (
    safePath(archiveRoot) &&
    safePath(entryPath) &&
    (entryPath === archiveRoot || entryPath.startsWith(`${archiveRoot}/`))
  );
};

export const isSafeArchiveSymlinkTarget = (entryPath, target, archiveRoot) => {
  if (
    !isSafeArchiveEntryPath(entryPath, archiveRoot) ||
    typeof target !== "string" ||
    !target ||
    target.includes("\0") ||
    target.includes("\\") ||
    posix.isAbsolute(target) ||
    /^[A-Za-z]:[\\/]/.test(target) ||
    target.startsWith("\\\\")
  ) {
    return false;
  }
  const normalizedRoot = posix.resolve("/", archiveRoot);
  const resolvedTarget = posix.resolve("/", posix.dirname(entryPath), target);
  return (
    resolvedTarget === normalizedRoot ||
    relativePathInside(resolvedTarget, normalizedRoot, posix) !== null
  );
};

export const extractionComparisonEntries = (entries, platform = process.platform) =>
  platform === "win32"
    ? entries.map(({ mode: _mode, ...entry }) => entry)
    : entries;

export const createDeterministicTar = async ({
  source,
  output,
  manifestPath,
  symlinkManifestPath,
  prefix,
  epoch,
}) => {
  const resolvedSource = resolve(source);
  const resolvedOutput = resolve(output);
  const resolvedManifest = resolve(manifestPath);
  const resolvedSymlinkManifest = resolve(symlinkManifestPath);
  if (
    !isSafeArchiveEntryPath(prefix, prefix)
  ) {
    throw new Error(`unsafe archive prefix: ${prefix}`);
  }
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new Error("SOURCE_DATE_EPOCH must be nonnegative integer seconds");
  }
  if (!existsSync(resolvedSource)) throw new Error(`desktop package source does not exist: ${resolvedSource}`);
  for (const target of [resolvedOutput, resolvedManifest, resolvedSymlinkManifest]) {
    if (relativePathInside(target, repositoryRoot) !== null) await assertNoSymlinkPath(target);
    await mkdir(dirname(target), { recursive: true });
  }

  const entries = [
    { mode: "0755", path: prefix, type: "directory" },
    ...(await filesystemManifestEntries(resolvedSource, prefix)),
  ];
  for (const entry of entries) {
    if (!isSafeArchiveEntryPath(entry.path, prefix)) {
      throw new Error(`unsafe desktop archive entry path: ${entry.path}`);
    }
  }
  for (const entry of entries.filter((candidate) => candidate.type === "symbolic-link")) {
    if (!isSafeArchiveSymlinkTarget(entry.path, entry.target, prefix)) {
      throw new Error(`archive symlink escapes ${prefix}: ${entry.path} -> ${entry.target}`);
    }
  }
  const partialPath = `${resolvedOutput}.partial`;
  await rm(partialPath, { force: true });
  const archive = await open(partialPath, "w", 0o644);
  const writeAll = async (buffer) => {
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await archive.write(buffer, offset, buffer.length - offset);
      if (!bytesWritten) throw new Error("short write while creating deterministic tar");
      offset += bytesWritten;
    }
  };
  try {
    for (const entry of entries) {
      await writeAll(createHeader(entry, epoch));
      if (entry.type !== "file") continue;
      const relativePath = entry.path.slice(prefix.length + 1);
      const data = await readFile(join(resolvedSource, ...relativePath.split("/")));
      await writeAll(data);
      const padding = (512 - (data.length % 512)) % 512;
      if (padding) await writeAll(Buffer.alloc(padding));
    }
    await writeAll(Buffer.alloc(1024));
  } finally {
    await archive.close();
  }
  await rename(partialPath, resolvedOutput);

  const manifest = {
    schemaVersion: 1,
    archiveFormat: "ustar",
    archiveRoot: prefix,
    sourceDateEpoch: epoch,
    sourceTreeSha256: await normalizedTreeHash(resolvedSource),
    sourceLayoutSha256: filesystemManifestHash(entries),
    entries,
  };
  await writeFile(resolvedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  const symlinks = entries
    .filter((entry) => entry.type === "symbolic-link")
    .map(({ path, target, type }) => ({ path, target, type }));
  const evidenceRelativeArchive = relativePathInside(resolvedOutput, dirname(resolvedSymlinkManifest));
  if (evidenceRelativeArchive === null) {
    throw new Error("desktop archive must be inside the symlink-manifest evidence directory");
  }
  const archiveIdentity = evidenceRelativeArchive;
  await writeFile(
    resolvedSymlinkManifest,
    `${JSON.stringify({ schemaVersion: 1, archive: archiveIdentity, entries: symlinks }, null, 2)}\n`,
    { mode: 0o644 },
  );
  return { entries, manifest };
};
