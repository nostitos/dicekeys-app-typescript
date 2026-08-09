#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cacheRoot,
  initializeBuildCache,
  isUniqueRegularFile,
  publishVerifiedBytes,
  sha256File,
} from "./lib/build-contract.mjs";

await initializeBuildCache();
// Keep the hardlink sentinel on the cache filesystem. /tmp is commonly a
// separate mount in containers, where a hardlink fixture would fail with EXDEV.
const externalRoot = await mkdtemp(
  join(cacheRoot, "test-results", "cache-publication-external-"),
);
const externalSentinel = join(externalRoot, "sentinel.bin");
const externalContents = Buffer.from("external data must survive\n");
const publishedContents = Buffer.from("verified cache publication\n");
const expectedPublishedHash = createHash("sha256").update(publishedContents).digest("hex");
const verify = async (path) => (await sha256File(path)) === expectedPublishedHash;

const exercise = async (parent, label) => {
  const testRoot = await mkdtemp(join(parent, `publication-${label}-`));
  try {
    for (const kind of ["symlink", "hardlink"]) {
      const finalPath = join(testRoot, `final-${kind}`);
      if (kind === "symlink") await symlink(externalSentinel, finalPath, "file");
      else await link(externalSentinel, finalPath);
      await publishVerifiedBytes(publishedContents, finalPath, verify);
      if (!(await isUniqueRegularFile(finalPath)) || !(await verify(finalPath))) {
        throw new Error(`${label} publication did not replace unsafe final ${kind}`);
      }
      if (!(await readFile(externalSentinel)).equals(externalContents)) {
        throw new Error(`${label} final ${kind} publication modified external data`);
      }

      const partialTarget = join(testRoot, `partial-${kind}`);
      const legacyPartial = `${partialTarget}.partial`;
      if (kind === "symlink") await symlink(externalSentinel, legacyPartial, "file");
      else await link(externalSentinel, legacyPartial);
      await publishVerifiedBytes(publishedContents, partialTarget, verify);
      if (!(await readFile(externalSentinel)).equals(externalContents)) {
        throw new Error(`${label} legacy partial ${kind} modified external data`);
      }
      if (!existsSync(legacyPartial)) {
        throw new Error(`${label} publication unexpectedly followed/removed fixed partial ${kind}`);
      }
      await unlink(legacyPartial);
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
};

try {
  await writeFile(externalSentinel, externalContents);
  await exercise(join(cacheRoot, "native-inputs", "electron"), "native");
  await exercise(join(cacheRoot, "vendor", "artifacts"), "vendor");
} finally {
  await rm(externalRoot, { recursive: true, force: true });
}

console.log("native/vendor cache publication replaced unsafe final links and ignored fixed partial links");
