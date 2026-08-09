#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { assertReleaseReplayIdentity } from "./lib/release-replay.mjs";

const [onlinePath, replayPath] = process.argv.slice(2);
if (!onlinePath || !replayPath) {
  throw new Error("usage: compare-release-replay.mjs <online-provenance.json> <replay-provenance.json>");
}
const online = JSON.parse(await readFile(onlinePath, "utf8"));
const replay = JSON.parse(await readFile(replayPath, "utf8"));
assertReleaseReplayIdentity(online, replay);
console.log("online and cache-replay checksum-bound release evidence matches");
