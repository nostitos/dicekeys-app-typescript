#!/usr/bin/env node
import { resolve } from "node:path";
import { initializeBuildCache, repositoryRoot, safeRemoveTree } from "./lib/build-contract.mjs";

const allowedTargets = new Set(
  ["release-artifacts", "electron/out/unsigned"].map((path) =>
    resolve(repositoryRoot, path),
  ),
);
const targets = process.argv.slice(2).map((path) => resolve(repositoryRoot, path));
if (!targets.length) throw new Error("safe-clean requires at least one explicit target");
await initializeBuildCache();
for (const target of targets) {
  if (!allowedTargets.has(target)) throw new Error(`safe-clean target is not allowlisted: ${target}`);
  const quarantinePath = await safeRemoveTree(target);
  if (quarantinePath) {
    console.log(`quarantined without recursive deletion: ${target} -> ${quarantinePath}`);
  } else {
    console.log(`cleanup target absent: ${target}`);
  }
}
