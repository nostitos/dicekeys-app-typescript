#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) throw new Error("usage: verify-jest-result.mjs <jest-result.json>");
const result = JSON.parse(await readFile(path, "utf8"));
if (!result.success || result.numFailedTestSuites !== 0 || result.numFailedTests !== 0) {
  throw new Error("Jest result reports a failure");
}
if (result.numTotalTestSuites !== 23 || result.numTotalTests !== 1998) {
  throw new Error(
    `unexpected Jest coverage: expected 23 suites/1998 tests, found ${result.numTotalTestSuites} suites/${result.numTotalTests} tests`,
  );
}
if (
  result.numPassedTestSuites !== 23 ||
  result.numPendingTestSuites !== 0 ||
  result.numPassedTests !== 1998 ||
  result.numPendingTests !== 0 ||
  result.numTodoTests !== 0
) {
  throw new Error(
    `Jest result contains skipped/todo work: passedSuites=${result.numPassedTestSuites}, pendingSuites=${result.numPendingTestSuites}, passedTests=${result.numPassedTests}, pendingTests=${result.numPendingTests}, todoTests=${result.numTodoTests}`,
  );
}
console.log("Jest count verified: all 23 suites and all 1998 tests passed with no skipped/todo work");
