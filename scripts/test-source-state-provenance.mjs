#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repositoryRoot } from "./lib/build-contract.mjs";

const orchestration = await readFile(join(repositoryRoot, "scripts", "build-release"), "utf8");
const capture = orchestration.indexOf('source_state_before="$(node scripts/tracked-state.mjs)"');
const cleanGate = orchestration.indexOf("node scripts/verify-source-cleanliness.mjs");
const exported = orchestration.indexOf(
  'export DICEKEYS_BUILD_RELEASE_SOURCE_STATE_SHA256="$source_state_before"',
);
const metadata = orchestration.indexOf("node scripts/generate-release-metadata.mjs release-artifacts");
if (cleanGate < 0 || capture <= cleanGate || exported <= capture || metadata <= exported) {
  throw new Error("build-release does not export its initial source-state hash before metadata generation");
}

const metadataSource = await readFile(
  join(repositoryRoot, "scripts", "generate-release-metadata.mjs"),
  "utf8",
);
for (const required of [
  "DICEKEYS_BUILD_RELEASE_SOURCE_STATE_SHA256",
  "currentSourceStateSha256 !== sourceStateSha256",
  "stateSha256: sourceStateSha256",
  "inspectSourceCleanliness",
  "cleanliness: sourceCleanliness",
]) {
  if (!metadataSource.includes(required)) {
    throw new Error(`release metadata source-state contract is missing: ${required}`);
  }
}

console.log("build-release exports, revalidates, and records its initial source-state hash");
