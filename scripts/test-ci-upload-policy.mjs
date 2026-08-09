#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repositoryRoot } from "./lib/build-contract.mjs";

const workflowPath = join(repositoryRoot, ".github", "workflows", "ci.js.yml");
const lines = (await readFile(workflowPath, "utf8")).split(/\r?\n/);
const uploadIndex = lines.findIndex((line) => line.includes("uses: actions/upload-artifact@"));
if (uploadIndex < 0) throw new Error("CI workflow has no pinned evidence upload step");
let blockEnd = lines.length;
for (let index = uploadIndex + 1; index < lines.length; index += 1) {
  if (/^\s{6}- name:/.test(lines[index])) {
    blockEnd = index;
    break;
  }
}
const uploadBlock = lines.slice(uploadIndex, blockEnd).join("\n");
const expectedPaths = [
  "release-artifacts/*.json",
  "release-artifacts/sbom/*.json",
  "release-artifacts/SHA256SUMS",
];
for (const expected of expectedPaths) {
  if (!uploadBlock.includes(expected)) throw new Error(`CI evidence upload omits ${expected}`);
}
if (
  /path:\s*release-artifacts\/?\s*$/m.test(uploadBlock) ||
  /(?:\.tar|\.zip|electron\/out|dist\/web)/i.test(uploadBlock)
) {
  throw new Error("CI upload may redistribute an ineligible web or desktop binary artifact");
}
const configuredPaths = uploadBlock
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith("release-artifacts/"));
if (JSON.stringify(configuredPaths) !== JSON.stringify(expectedPaths)) {
  throw new Error(`CI upload path set is not the evidence-only allowlist: ${configuredPaths.join(", ")}`);
}

console.log("CI upload policy permits only non-binary ineligible evaluation evidence");
