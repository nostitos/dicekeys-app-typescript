#!/usr/bin/env node
import { assertReleaseReplayIdentity } from "./lib/release-replay.mjs";

const identity = {
  schemaVersion: 1,
  sourceCommit: "a".repeat(40),
  sourceStateSha256: "b".repeat(64),
  releaseEligible: false,
  checksumEntryCount: 3,
  normalizedProvenanceSha256: "c".repeat(64),
  files: [
    { path: "dependency-inventory.json", sha256: "d".repeat(64) },
    { path: "provenance.json", sha256: "e".repeat(64) },
    { path: "sbom/root.cdx.json", sha256: "f".repeat(64) },
  ],
};
assertReleaseReplayIdentity(
  { ...identity, acquisitionMode: "online-acquisition-allowed" },
  { ...identity, acquisitionMode: "cache-enforced-replay" },
);
for (const mutation of [
  { sourceStateSha256: "0".repeat(64) },
  { normalizedProvenanceSha256: "1".repeat(64) },
  {
    files: identity.files.map((entry, index) =>
      index === 2 ? { ...entry, sha256: "2".repeat(64) } : entry,
    ),
  },
]) {
  let rejected = false;
  try {
    assertReleaseReplayIdentity(
      { ...identity, acquisitionMode: "online-acquisition-allowed" },
      { ...identity, ...mutation, acquisitionMode: "cache-enforced-replay" },
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`release replay comparison accepted mutation ${JSON.stringify(mutation)}`);
}

console.log("release replay comparison rejects normalized provenance and checksum-bound evidence drift");
