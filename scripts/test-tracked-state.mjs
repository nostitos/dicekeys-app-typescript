#!/usr/bin/env node
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cacheRoot, initializeBuildCache } from "./lib/build-contract.mjs";
import { computeSourceState } from "./tracked-state.mjs";

await initializeBuildCache();
const parent = await mkdtemp(join(cacheRoot, "test-results", "source-state-"));
const repository = join(parent, "repository");
const git = (args) => {
  const completed = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  if (completed.error || completed.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${completed.stderr ?? completed.error?.message}`);
  }
};

try {
  await mkdir(repository);
  git(["init", "-q"]);
  git(["config", "user.name", "Build Contract Test"]);
  git(["config", "user.email", "build-contract@example.invalid"]);
  const tracked = join(repository, "tracked.txt");
  await writeFile(tracked, "original\n");
  git(["add", "tracked.txt"]);
  git(["commit", "-q", "-m", "initial"]);
  const baseline = await computeSourceState(repository);

  git(["update-index", "--assume-unchanged", "tracked.txt"]);
  await writeFile(tracked, "modified while assume-unchanged\n");
  if ((await computeSourceState(repository)) === baseline) {
    throw new Error("source-state digest missed assume-unchanged working-tree content");
  }

  git(["update-index", "--no-assume-unchanged", "tracked.txt"]);
  await writeFile(tracked, "original\n");
  if ((await computeSourceState(repository)) !== baseline) {
    throw new Error("source-state digest did not return to baseline after exact restoration");
  }

  await writeFile(tracked, "staged\n");
  git(["add", "tracked.txt"]);
  if ((await computeSourceState(repository)) === baseline) {
    throw new Error("source-state digest missed staged content");
  }

  git(["commit", "-q", "-m", "second"]);
  if ((await computeSourceState(repository)) === baseline) {
    throw new Error("source-state digest missed a HEAD transition");
  }

  const untracked = join(repository, "untracked.txt");
  await writeFile(untracked, "one\n");
  const firstUntracked = await computeSourceState(repository);
  await writeFile(untracked, "two\n");
  if ((await computeSourceState(repository)) === firstUntracked) {
    throw new Error("source-state digest missed untracked content mutation");
  }
} finally {
  await rm(parent, { recursive: true, force: true });
}

console.log("source-state digest binds HEAD, index flags/content, and tracked/untracked working bytes");
