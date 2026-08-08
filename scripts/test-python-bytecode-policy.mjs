#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cacheRoot, initializeBuildCache } from "./lib/build-contract.mjs";

await initializeBuildCache();
const pythonCandidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
const python = pythonCandidates.find((candidate) => {
  const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
});
if (!python) throw new Error(`no Python interpreter found in ${pythonCandidates.join(", ")}`);
const testRoot = await mkdtemp(join(cacheRoot, "test-results", "python-bytecode-"));
const tests = join(testRoot, "tests");

const findBytecode = async (directory) => {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === "__pycache__" || /\.(?:pyc|pyo)$/i.test(entry.name)) found.push(path);
    if (entry.isDirectory()) found.push(...(await findBytecode(path)));
  }
  return found;
};

try {
  await mkdir(tests);
  await writeFile(
    join(tests, "test_no_bytecode.py"),
    "import unittest\n\nclass NoBytecodeTest(unittest.TestCase):\n    def test_true(self):\n        self.assertTrue(True)\n",
  );
  const completed = spawnSync(
    python,
    ["-B", "-m", "unittest", "discover", "-s", tests, "-p", "test_*.py"],
    {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      encoding: "utf8",
    },
  );
  if (completed.error || completed.status !== 0) {
    throw new Error(
      `Python no-bytecode regression failed to execute: ${completed.error?.message ?? ""}\n${completed.stdout ?? ""}${completed.stderr ?? ""}`,
    );
  }
  const bytecode = await findBytecode(testRoot);
  if (bytecode.length) throw new Error(`Python -B regression created bytecode: ${bytecode.join(", ")}`);
} finally {
  if (existsSync(testRoot)) await rm(testRoot, { recursive: true, force: true });
}

console.log("Python unittest policy creates no __pycache__, .pyc, or .pyo files");
