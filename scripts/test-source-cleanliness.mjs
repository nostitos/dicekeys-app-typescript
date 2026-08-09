#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cacheRoot,
  initializeBuildCache,
} from "./lib/build-contract.mjs";
import { inspectSourceCleanliness } from "./lib/source-cleanliness.mjs";

await initializeBuildCache();
const fixture = await mkdtemp(join(cacheRoot, "test-results", "source-cleanliness-"));
const git = (args) => {
  const completed = spawnSync("git", ["-C", fixture, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: join(fixture, "setup-home"), LC_ALL: "C" },
  });
  if (completed.error || completed.status !== 0) {
    throw new Error(`fixture git ${args.join(" ")} failed: ${completed.error?.message ?? completed.stderr}`);
  }
  return completed.stdout.trim();
};
const expectIssue = async (kind, expectedPath = null) => {
  const audit = await inspectSourceCleanliness(fixture);
  if (
    audit.clean ||
    !audit.issues.some(
      (issue) => issue.kind === kind && (expectedPath === null || issue.path === expectedPath),
    )
  ) {
    throw new Error(`source cleanliness audit did not report ${kind}: ${JSON.stringify(audit.issues)}`);
  }
};

try {
  await mkdir(join(fixture, "setup-home"));
  const trackedPath = join(fixture, "tracked.txt");
  const trackedIgnorePath = join(fixture, ".gitignore");
  await writeFile(trackedPath, "original\n", { mode: 0o644 });
  await writeFile(trackedIgnorePath, "allowed-output/\n");
  git(["init", "--quiet"]);
  git(["add", "tracked.txt", ".gitignore"]);
  git(["-c", "user.name=Build Contract", "-c", "user.email=build@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  if (!(await inspectSourceCleanliness(fixture)).clean) {
    throw new Error("fresh source-cleanliness fixture is not clean");
  }

  git(["update-index", "--assume-unchanged", "tracked.txt"]);
  await writeFile(trackedPath, "hidden assume-unchanged mutation\n");
  await expectIssue("assume-unchanged");
  await expectIssue("tracked-content-mismatch");
  git(["update-index", "--no-assume-unchanged", "tracked.txt"]);
  await writeFile(trackedPath, "original\n");

  git(["update-index", "--skip-worktree", "tracked.txt"]);
  await writeFile(trackedPath, "hidden skip-worktree mutation\n");
  await expectIssue("skip-worktree");
  await expectIssue("tracked-content-mismatch");
  git(["update-index", "--no-skip-worktree", "tracked.txt"]);
  await writeFile(trackedPath, "original\n");

  await writeFile(trackedPath, "ordinary working mutation\n");
  await expectIssue("tracked-content-mismatch");
  await writeFile(trackedPath, "original\n");

  await writeFile(trackedPath, "staged mutation\n");
  git(["add", "tracked.txt"]);
  await expectIssue("index-differs-from-head");
  git(["restore", "--staged", "tracked.txt"]);
  await writeFile(trackedPath, "original\n");

  if (process.platform !== "win32") {
    git(["config", "core.filemode", "false"]);
    await chmod(trackedPath, 0o755);
    await expectIssue("tracked-mode-mismatch");
    await chmod(trackedPath, 0o644);
  }

  const untrackedPath = join(fixture, "untracked.txt");
  await writeFile(untrackedPath, "untracked\n");
  await expectIssue("untracked-path", "untracked.txt");
  await unlink(untrackedPath);

  const localExcludePath = join(fixture, ".git", "info", "exclude");
  const originalLocalExclude = await readFile(localExcludePath);
  const locallyHiddenPath = join(fixture, "injected-local-exclude.ts");
  await writeFile(localExcludePath, "injected-local-exclude.ts\n");
  await writeFile(locallyHiddenPath, "export const injected = true;\n");
  await expectIssue("untracked-path", "injected-local-exclude.ts");
  await unlink(locallyHiddenPath);
  await writeFile(localExcludePath, originalLocalExclude);

  const trackedIgnoreHiddenPath = join(fixture, "injected-tracked-ignore.ts");
  await writeFile(trackedIgnorePath, "allowed-output/\ninjected-tracked-ignore.ts\n");
  await writeFile(trackedIgnoreHiddenPath, "export const injected = true;\n");
  const trackedIgnoreAudit = await inspectSourceCleanliness(fixture);
  if (
    !trackedIgnoreAudit.issues.some(
      (issue) => issue.kind === "tracked-content-mismatch" && issue.path === ".gitignore",
    ) ||
    !trackedIgnoreAudit.issues.some(
      (issue) => issue.kind === "untracked-path" && issue.path === "injected-tracked-ignore.ts",
    )
  ) {
    throw new Error("source cleanliness did not use committed ignore rules for hidden source");
  }
  await unlink(trackedIgnoreHiddenPath);
  await writeFile(trackedIgnorePath, "allowed-output/\n");

  const globalExcludePath = join(fixture, "setup-home", "global-excludes");
  const globallyHiddenPath = join(fixture, "injected-global-exclude.ts");
  await writeFile(globalExcludePath, "injected-global-exclude.ts\n");
  git(["config", "core.excludesFile", globalExcludePath]);
  await writeFile(globallyHiddenPath, "export const injected = true;\n");
  await expectIssue("untracked-path", "injected-global-exclude.ts");
  await unlink(globallyHiddenPath);
  git(["config", "--unset", "core.excludesFile"]);

  const hiddenDirectory = join(fixture, "hidden-source");
  await mkdir(hiddenDirectory);
  await writeFile(join(hiddenDirectory, ".gitignore"), "*\n");
  await writeFile(join(hiddenDirectory, "injected.ts"), "export const hidden = true;\n");
  await expectIssue("untracked-path", "hidden-source/.gitignore");
  await expectIssue("untracked-path", "hidden-source/injected.ts");
} finally {
  await rm(fixture, { recursive: true, force: false });
}

console.log("source cleanliness rejects hidden index flags, local/global excludes, ignore-rule drift, bytes, modes, and untracked source");
