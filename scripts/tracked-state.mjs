#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRoot, runGitBytes, sha256, sha256File } from "./lib/build-contract.mjs";
import { committedIgnoreArguments } from "./lib/source-cleanliness.mjs";

const nulPaths = (bytes) =>
  bytes
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();

export const computeSourceState = async (root = repositoryRoot) => {
  const resolvedRoot = resolve(root);
  const digest = createHash("sha256");
  const update = (label, bytes) => {
    const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8");
    digest.update(`${label}\0${value.length}\0`);
    digest.update(value);
    digest.update("\0");
  };

  const gitBytes = (args) => runGitBytes(args, { cwd: resolvedRoot });
  update("head", gitBytes(["rev-parse", "--verify", "HEAD"]));
  update(
    "status",
    gitBytes(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  update(
    "unstaged-diff",
    gitBytes(["diff", "--no-ext-diff", "--binary", "--"]),
  );
  update(
    "staged-diff",
    gitBytes(["diff", "--cached", "--no-ext-diff", "--binary", "--"]),
  );
  update("index-stage", gitBytes(["ls-files", "--stage", "-z"]));
  update("index-flags", gitBytes(["ls-files", "-v", "-z"]));

  const trackedPaths = nulPaths(gitBytes(["ls-files", "-z"]));
  for (const trackedPath of trackedPaths) {
    const absolutePath = join(resolvedRoot, trackedPath);
    try {
      const info = await lstat(absolutePath);
      const mode = (info.mode & 0o7777).toString(8).padStart(4, "0");
      if (info.isFile()) {
        update(
          "tracked-file",
          `${trackedPath}\0${mode}\0${await sha256File(absolutePath)}`,
        );
      } else if (info.isSymbolicLink()) {
        update(
          "tracked-symlink",
          `${trackedPath}\0${mode}\0${sha256(Buffer.from(await readlink(absolutePath), "utf8"))}`,
        );
      } else if (info.isDirectory()) {
        update("tracked-directory", `${trackedPath}\0${mode}`);
      } else {
        update("tracked-unsupported", `${trackedPath}\0${mode}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      update("tracked-missing", trackedPath);
    }
  }

  const untrackedPaths = nulPaths(
    gitBytes(["ls-files", "--others", "-z", ...committedIgnoreArguments(resolvedRoot)]),
  );
  for (const untrackedPath of untrackedPaths) {
    const absolutePath = join(resolvedRoot, untrackedPath);
    const info = await lstat(absolutePath);
    const mode = (info.mode & 0o7777).toString(8).padStart(4, "0");
    if (info.isFile()) {
      update(
        "untracked-file",
        `${untrackedPath}\0${mode}\0${await sha256File(absolutePath)}`,
      );
    } else if (info.isSymbolicLink()) {
      update(
        "untracked-symlink",
        `${untrackedPath}\0${mode}\0${sha256(Buffer.from(await readlink(absolutePath), "utf8"))}`,
      );
    } else {
      throw new Error(`unsupported untracked source entry: ${untrackedPath}`);
    }
  }
  return digest.digest("hex");
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw new Error("tracked-state takes no arguments");
  console.log(await computeSourceState());
}
