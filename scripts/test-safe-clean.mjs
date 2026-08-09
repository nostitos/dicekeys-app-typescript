#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheRoot, repositoryRoot, safeRemoveTree } from "./lib/build-contract.mjs";

await mkdir(cacheRoot, { recursive: true });
const repositoryTestRoot = await mkdtemp(join(cacheRoot, "safe-clean-test-"));
const externalTestRoot = await mkdtemp(join(tmpdir(), "dicekeys-safe-clean-external-"));
const externalVictim = join(externalTestRoot, "victim");
const symlinkAncestor = join(repositoryTestRoot, "redirect");
try {
  const quarantineRoot = join(repositoryTestRoot, "quarantine");
  await mkdir(quarantineRoot);
  await mkdir(externalVictim);
  await writeFile(join(externalVictim, "must-survive.txt"), "outside repository\n");
  await symlink(externalTestRoot, symlinkAncestor, "dir");
  let refused = false;
  try {
    await safeRemoveTree(join(symlinkAncestor, "victim"), repositoryRoot, { quarantineRoot });
  } catch (error) {
    refused = /symlink ancestor/.test(String(error));
  }
  if (!refused) throw new Error("safe cleanup did not reject a symlink ancestor");
  if (!existsSync(join(externalVictim, "must-survive.txt"))) {
    throw new Error("safe cleanup escaped the repository and deleted the external sentinel");
  }

  const repeatTarget = join(repositoryTestRoot, "repeatable-target");
  const retainedQuarantines = [];
  for (let run = 1; run <= 3; run += 1) {
    await mkdir(repeatTarget);
    await writeFile(join(repeatTarget, "run.txt"), `run ${run}\n`);
    const retained = await safeRemoveTree(repeatTarget, repositoryRoot, { quarantineRoot });
    retainedQuarantines.push(retained);
    if (existsSync(repeatTarget) || !existsSync(join(retained, "run.txt"))) {
      throw new Error(`safe cleanup did not retain repeatable run ${run}`);
    }
  }
  if (new Set(retainedQuarantines).size !== 3) {
    throw new Error("three cleanup runs did not reserve unique quarantine destinations");
  }

  const collisionTarget = join(repositoryTestRoot, "collision-target");
  await mkdir(collisionTarget);
  await writeFile(join(collisionTarget, "sentinel.txt"), "collision retry\n");
  await mkdir(
    join(quarantineRoot, `collision-target.${process.pid}.${Buffer.alloc(16, 0).toString("hex")}`),
  );
  let collisionAttempt = 0;
  const collisionRetained = await safeRemoveTree(collisionTarget, repositoryRoot, {
    quarantineRoot,
    randomBytesFunction: () => Buffer.alloc(16, collisionAttempt++),
  });
  if (collisionAttempt !== 2 || !existsSync(join(collisionRetained, "sentinel.txt"))) {
    throw new Error("safe cleanup did not retry an exclusively occupied quarantine reservation");
  }

  const directChildTarget = join(repositoryTestRoot, "direct-child");
  await mkdir(directChildTarget);
  await writeFile(join(directChildTarget, "remove-me.txt"), "direct child\n");
  const directChildQuarantine = await safeRemoveTree(directChildTarget, repositoryTestRoot, {
    quarantineRoot,
  });
  if (existsSync(directChildTarget)) {
    throw new Error("safe cleanup did not quarantine a target directly below its containment root");
  }
  if (!existsSync(join(directChildQuarantine, "remove-me.txt"))) {
    throw new Error("direct-child quarantine content was removed");
  }

  const mountLikeTarget = join(repositoryTestRoot, "mount-like");
  await mkdir(mountLikeTarget);
  await writeFile(join(mountLikeTarget, "must-survive.txt"), "mounted content\n");
  let mountRefused = false;
  try {
    await safeRemoveTree(mountLikeTarget, repositoryRoot, {
      quarantineRoot,
      renameFunction: async () => {
        const error = new Error("simulated mount point cannot be renamed");
        error.code = "EBUSY";
        throw error;
      },
    });
  } catch (error) {
    mountRefused = error?.code === "EBUSY";
  }
  if (!mountRefused) {
    throw new Error("safe cleanup did not fail closed while quarantining a mount-like target");
  }
  if (!existsSync(join(mountLikeTarget, "must-survive.txt"))) {
    throw new Error("safe cleanup modified a target whose atomic quarantine rename failed");
  }

  const nestedMountLikeTarget = join(repositoryTestRoot, "nested-mount-like");
  const nestedSentinel = join(nestedMountLikeTarget, "mounted", "external-sentinel.txt");
  await mkdir(join(nestedMountLikeTarget, "mounted"), { recursive: true });
  await writeFile(nestedSentinel, "nested external content must never be traversed\n");
  const nestedQuarantine = await safeRemoveTree(nestedMountLikeTarget, repositoryRoot, {
    quarantineRoot,
  });
  if (!existsSync(join(nestedQuarantine, "mounted", "external-sentinel.txt"))) {
    throw new Error("safe cleanup traversed a simulated nested mount after quarantine");
  }
} finally {
  if (existsSync(symlinkAncestor)) await unlink(symlinkAncestor);
  await rm(repositoryTestRoot, { recursive: true, force: true });
  await rm(externalTestRoot, { recursive: true, force: true });
}

console.log("safe cleanup is three-run repeatable, retains unique quarantines, and never traverses nested mount content");
