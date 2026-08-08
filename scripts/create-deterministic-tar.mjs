#!/usr/bin/env node
if (process.platform !== "win32") process.umask(0o022);
import { createDeterministicTar } from "./lib/deterministic-tar.mjs";

const [source, output, manifestPath, symlinkManifestPath, prefix] = process.argv.slice(2);
if (!source || !output || !manifestPath || !symlinkManifestPath || !prefix) {
  throw new Error(
    "usage: create-deterministic-tar.mjs <source> <output.tar> <manifest.json> <symlink-manifest.json> <prefix>",
  );
}
const epoch = Number(process.env.SOURCE_DATE_EPOCH);
const { entries } = await createDeterministicTar({
  source,
  output,
  manifestPath,
  symlinkManifestPath,
  prefix,
  epoch,
});
console.log(`wrote deterministic ustar desktop archive with ${entries.length} entries`);
