#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cacheRoot, initializeBuildCache, repositoryRoot } from "./lib/build-contract.mjs";

await initializeBuildCache();
const root = await mkdtemp(join(cacheRoot, "test-results", "jest-policy-"));
const resultPath = join(root, "jest.json");
const verifier = join(repositoryRoot, "scripts", "verify-jest-result.mjs");
const invoke = () => spawnSync(process.execPath, [verifier, resultPath], { encoding: "utf8" });
const baseline = {
  success: true,
  numFailedTestSuites: 0,
  numFailedTests: 0,
  numTotalTestSuites: 19,
  numPassedTestSuites: 19,
  numPendingTestSuites: 0,
  numTotalTests: 1843,
  numPassedTests: 1843,
  numPendingTests: 0,
  numTodoTests: 0,
};

try {
  await writeFile(resultPath, `${JSON.stringify(baseline)}\n`);
  if (invoke().status !== 0) throw new Error("complete Jest fixture did not verify");
  for (const mutation of [
    { numPassedTests: 1842, numPendingTests: 1 },
    { numPassedTests: 1842, numTodoTests: 1 },
    { numPassedTestSuites: 18, numPendingTestSuites: 1 },
  ]) {
    await writeFile(resultPath, `${JSON.stringify({ ...baseline, ...mutation })}\n`);
    if (invoke().status === 0) {
      throw new Error(`Jest policy accepted skipped/todo fixture: ${JSON.stringify(mutation)}`);
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Jest policy rejects skipped tests, todo tests, and pending suites");
