#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repositoryRoot } from "./lib/build-contract.mjs";

const testRoot = await mkdtemp(join(tmpdir(), "dicekeys-cache-safety-root-"));
const externalRoot = await mkdtemp(join(tmpdir(), "dicekeys-cache-safety-external-"));
const externalSentinel = join(externalRoot, "sentinel.txt");
const sentinelContents = "must not be truncated or removed\n";
const invokeInitializer = () =>
  spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import {initializeBuildCache} from './scripts/lib/build-contract.mjs'; await initializeBuildCache(process.argv[1]);",
      testRoot,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

try {
  await writeFile(externalSentinel, sentinelContents);
  await symlink(externalRoot, join(testRoot, ".cache"), "dir");
  const cacheSymlinkResult = invokeInitializer();
  if (cacheSymlinkResult.status === 0 || !/symlink ancestor/.test(cacheSymlinkResult.stderr)) {
    throw new Error("cache initializer did not reject a symlinked .cache ancestor");
  }
  if ((await readFile(externalSentinel, "utf8")) !== sentinelContents) {
    throw new Error("symlinked .cache test modified the external sentinel");
  }

  await unlink(join(testRoot, ".cache"));
  await mkdir(join(testRoot, ".cache"));
  await symlink(externalSentinel, join(testRoot, ".cache", "npmrc-user-empty"));
  const npmrcSymlinkResult = invokeInitializer();
  if (npmrcSymlinkResult.status === 0 || !/symlink ancestor/.test(npmrcSymlinkResult.stderr)) {
    throw new Error("cache initializer did not reject a symlinked npmrc target");
  }
  if ((await readFile(externalSentinel, "utf8")) !== sentinelContents) {
    throw new Error("symlinked npmrc test truncated the external sentinel");
  }
} finally {
  const cacheDirectory = join(testRoot, ".cache");
  const npmrcSymlink = join(cacheDirectory, "npmrc-user-empty");
  if (existsSync(npmrcSymlink)) await unlink(npmrcSymlink);
  await rm(testRoot, { recursive: true, force: true });
  await rm(externalRoot, { recursive: true, force: true });
}

console.log("cache initializer rejected symlinked cache/npmrc targets and preserved external data");
