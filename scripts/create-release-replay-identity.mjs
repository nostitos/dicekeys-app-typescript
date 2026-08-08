#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { createReleaseReplayIdentity } from "./lib/release-replay.mjs";

const [releaseDirectory, outputPath] = process.argv.slice(2);
if (!releaseDirectory || !outputPath) {
  throw new Error(
    "usage: create-release-replay-identity.mjs <release-directory> <output.json>",
  );
}
const identity = await createReleaseReplayIdentity(releaseDirectory);
await writeFile(outputPath, `${JSON.stringify(identity, null, 2)}\n`);
console.log(
  `captured ${identity.checksumEntryCount} checksum-bound files for ${identity.acquisitionMode}`,
);
