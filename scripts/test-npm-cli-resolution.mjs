#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  repositoryRoot,
  resolveNpmCli,
  requiredNpmVersion,
  runNpm,
} from "./lib/build-contract.mjs";

const originalLower = process.env.npm_execpath;
const originalUpper = process.env.NPM_EXECPATH;
process.env.npm_execpath = "/tmp/untrusted/npm-cli.js";
process.env.NPM_EXECPATH = "/tmp/also-untrusted/npm-cli.js";
const npmCli = resolveNpmCli();
if (!existsSync(npmCli) || !npmCli.endsWith("npm-cli.js")) {
  throw new Error("npm CLI resolver did not find the bundled npm-cli.js");
}
if (runNpm(["--version"], { capture: true }) !== requiredNpmVersion) {
  throw new Error("bundled npm CLI version differs from the Phase 2 contract");
}
if (originalLower === undefined) delete process.env.npm_execpath;
else process.env.npm_execpath = originalLower;
if (originalUpper === undefined) delete process.env.NPM_EXECPATH;
else process.env.NPM_EXECPATH = originalUpper;

const wrapper = spawnSync(
  process.execPath,
  [join(repositoryRoot, "scripts", "run-npm.mjs"), "--version"],
  { cwd: repositoryRoot, encoding: "utf8" },
);
if (wrapper.error || wrapper.status !== 0 || wrapper.stdout.trim() !== requiredNpmVersion) {
  throw new Error(`npm wrapper did not execute the bundled CLI: ${wrapper.stdout}${wrapper.stderr}`);
}
for (const script of ["bootstrap", "check", "build-release", "lint-diagnostic", "lib/build-contract.sh"]) {
  const source = await readFile(join(repositoryRoot, "scripts", script), "utf8");
  if (/^\s*(?:if\s+)?npm(?:\s|$)/m.test(source)) {
    throw new Error(`${script} invokes bare npm instead of the validated npm-cli wrapper`);
  }
}
for (const manifestPath of ["web/package.json", "electron/package.json"]) {
  const source = await readFile(join(repositoryRoot, manifestPath), "utf8");
  if (/\bnpm\s+run\b/.test(source)) {
    throw new Error(`${manifestPath} contains a nested bare npm invocation`);
  }
}

console.log(`resolved bundled npm CLI without shell dispatch: ${npmCli}`);
