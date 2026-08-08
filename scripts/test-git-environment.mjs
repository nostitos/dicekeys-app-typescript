#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cacheRoot,
  initializeBuildCache,
  repositoryRoot,
  runGit,
  sanitizedGitEnvironment,
} from "./lib/build-contract.mjs";

await initializeBuildCache();
const fixtureRoot = await mkdtemp(join(cacheRoot, "test-results", "git-environment-"));

const rawGit = (root, args) => {
  const completed = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: join(fixtureRoot, "setup-home"), LC_ALL: "C" },
  });
  if (completed.error || completed.status !== 0) {
    throw new Error(`fixture git ${args.join(" ")} failed: ${completed.error?.message ?? completed.stderr}`);
  }
  return completed.stdout.trim();
};

const createRepository = async (name, content) => {
  const root = join(fixtureRoot, name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "identity.txt"), `${content}\n`);
  rawGit(root, ["init", "--quiet"]);
  rawGit(root, ["add", "identity.txt"]);
  rawGit(root, ["-c", "user.name=Build Contract", "-c", "user.email=build@example.invalid", "commit", "--quiet", "-m", name]);
  return root;
};

try {
  const target = await createRepository("target", "target");
  const hostile = await createRepository("hostile", "hostile");
  const expectedHead = rawGit(target, ["rev-parse", "HEAD"]);
  const hostileHead = rawGit(hostile, ["rev-parse", "HEAD"]);
  if (expectedHead === hostileHead) throw new Error("Git injection fixture commits unexpectedly match");

  const sentinels = {
    GIT_DIR: join(hostile, ".git"),
    GIT_WORK_TREE: hostile,
    GIT_INDEX_FILE: join(hostile, ".git", "index"),
    GIT_OBJECT_DIRECTORY: join(hostile, ".git", "objects"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "true",
    GIT_EXTERNAL_DIFF: join(hostile, "malicious-diff"),
    AWS_SECRET_ACCESS_KEY: "must-not-survive",
    NODE_OPTIONS: "--require=/tmp/must-not-survive.js",
  };
  Object.assign(process.env, sentinels);

  if (runGit(["rev-parse", "HEAD"], { cwd: target }) !== expectedHead) {
    throw new Error("sanitized Git wrapper followed an ambient repository override");
  }
  const sanitized = sanitizedGitEnvironment();
  for (const key of Object.keys(sentinels)) {
    if (key in sanitized) throw new Error(`sanitized Git environment retained ${key}`);
  }
  if (
    sanitized.GIT_CONFIG_GLOBAL !== (process.platform === "win32" ? "NUL" : "/dev/null") ||
    sanitized.GIT_CONFIG_NOSYSTEM !== "1" ||
    sanitized.GIT_OPTIONAL_LOCKS !== "0" ||
    sanitized.GIT_TERMINAL_PROMPT !== "0"
  ) {
    throw new Error("sanitized Git wrapper did not force its noninteractive configuration");
  }

  for (const relativePath of [
    "scripts/build-release",
    "scripts/check",
    "scripts/generate-release-metadata.mjs",
    "scripts/tracked-state.mjs",
  ]) {
    const source = await readFile(join(repositoryRoot, relativePath), "utf8");
    if (/\bgit\s+(?:status|show|rev-parse)\b/.test(source) || /run\(\s*["']git["']/.test(source)) {
      throw new Error(`${relativePath} bypasses the sanitized Git wrapper`);
    }
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: false });
}

console.log("Git environment injection regression passed through the centralized sanitized wrapper");
