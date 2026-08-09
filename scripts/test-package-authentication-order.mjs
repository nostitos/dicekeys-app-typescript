#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, recipesPath, verifyPackageArtifact } from "./lib/build-contract.mjs";

const testRoot = await mkdtemp(join(tmpdir(), "dicekeys-package-auth-order-"));
try {
  const corruptArchive = join(testRoot, "corrupt.tgz");
  await writeFile(corruptArchive, "not a tar archive\n");
  const expected = (await readJson(recipesPath)).packages[0].artifact;
  let packageTreeReached = false;
  const result = await verifyPackageArtifact(corruptArchive, expected, {
    packageTreeHashFunction: async () => {
      packageTreeReached = true;
      throw new Error("package tree extraction must not run before digest authentication");
    },
  });
  if (result.matches || result.phase !== "compressed-digest" || packageTreeReached) {
    throw new Error("corrupt package bytes reached package-tree extraction before digest rejection");
  }
} finally {
  await rm(testRoot, { recursive: true, force: true });
}

console.log("package digest authentication rejects corrupt bytes before tar extraction");
