#!/usr/bin/env node
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cacheRoot, initializeBuildCache, repositoryRoot } from "./lib/build-contract.mjs";
import {
  createDeterministicTar,
  extractionComparisonEntries,
  isSafeArchiveEntryPath,
  isSafeArchiveSymlinkTarget,
} from "./lib/deterministic-tar.mjs";

if (
  !isSafeArchiveEntryPath("desktop/Frameworks/App", "desktop") ||
  isSafeArchiveEntryPath("desktop/../evil", "desktop") ||
  isSafeArchiveEntryPath("desktop\\..\\evil", "desktop") ||
  isSafeArchiveEntryPath("/desktop/evil", "desktop") ||
  isSafeArchiveEntryPath("C:\\desktop\\evil", "desktop") ||
  !isSafeArchiveSymlinkTarget(
    "desktop/Foo.framework/Versions/Current",
    "A",
    "desktop",
  ) ||
  isSafeArchiveSymlinkTarget("desktop/link", "/etc/passwd", "desktop") ||
  isSafeArchiveSymlinkTarget("desktop/link", "../../etc/passwd", "desktop") ||
  isSafeArchiveSymlinkTarget("desktop/link", "C:\\Windows\\System32", "desktop") ||
  isSafeArchiveSymlinkTarget("desktop/link", "..\\..\\Windows\\System32", "desktop") ||
  isSafeArchiveSymlinkTarget("desktop/link", "\\Windows\\System32", "desktop") ||
  isSafeArchiveSymlinkTarget("desktop/link", "folder\\target", "desktop")
) {
  throw new Error("desktop archive symlink containment policy is incorrect");
}
if (
  JSON.stringify(extractionComparisonEntries([{ path: "x", mode: "0755" }], "win32")) !==
    JSON.stringify([{ path: "x" }]) ||
  JSON.stringify(extractionComparisonEntries([{ path: "x", mode: "0755" }], "darwin")) !==
    JSON.stringify([{ path: "x", mode: "0755" }])
) {
  throw new Error("desktop extraction comparison does not normalize Windows-only mode synthesis");
}

await initializeBuildCache();
const testRoot = await mkdtemp(join(cacheRoot, "test-results", "deterministic-tar-"));
const source = join(testRoot, "source");
const archive = join(testRoot, "desktop.tar");
const manifest = join(testRoot, "manifest.json");
const symlinks = join(testRoot, "symlinks.json");
const assertion = join(testRoot, "assertion.json");
const epoch = 946684800;
const verify = (candidate) =>
  spawnSync(
    process.execPath,
    [
      join(repositoryRoot, "scripts", "verify-desktop-archive.mjs"),
      candidate,
      source,
      manifest,
      assertion,
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, SOURCE_DATE_EPOCH: String(epoch) },
      encoding: "utf8",
    },
  );

try {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(source));
  const executable = join(source, "run-me");
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);
  await createDeterministicTar({
    source,
    output: archive,
    manifestPath: manifest,
    symlinkManifestPath: symlinks,
    prefix: "desktop-test",
    epoch,
  });
  const originalUmask = process.platform === "win32" ? null : process.umask(0o077);
  const canonicalVerification = verify(archive);
  if (originalUmask !== null) process.umask(originalUmask);
  if (canonicalVerification.status !== 0) {
    throw new Error(
      `canonical deterministic tar did not verify under hostile umask:\n${canonicalVerification.stdout}${canonicalVerification.stderr}`,
    );
  }
  const symlinkEvidence = JSON.parse(await readFile(symlinks, "utf8"));
  const archiveAssertion = JSON.parse(await readFile(assertion, "utf8"));
  if (symlinkEvidence.archive !== "desktop.tar" || symlinkEvidence.archive !== archiveAssertion.archive) {
    throw new Error("desktop archive sidecars do not share a flattened-download-relative identity");
  }

  const canonical = await readFile(archive);
  const mutatedMtime = Buffer.from(canonical);
  const mtime = `${(epoch + 1).toString(8).padStart(11, "0")}\0`;
  mutatedMtime.write(mtime, 136, 12, "ascii");
  mutatedMtime.fill(0x20, 148, 156);
  const checksum = mutatedMtime.subarray(0, 512).reduce((sum, value) => sum + value, 0);
  mutatedMtime.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const mutatedMtimePath = join(testRoot, "mutated-mtime.tar");
  await writeFile(mutatedMtimePath, mutatedMtime);
  if (verify(mutatedMtimePath).status === 0) {
    throw new Error("desktop tar verifier accepted a rechecksummed mutated mtime");
  }

  const extraZeroPath = join(testRoot, "extra-zero.tar");
  await writeFile(extraZeroPath, Buffer.concat([canonical, Buffer.alloc(512)]));
  if (verify(extraZeroPath).status === 0) {
    throw new Error("desktop tar verifier accepted an extra zero block");
  }
} finally {
  await rm(testRoot, { recursive: true, force: true });
}

console.log("desktop tar verifier rejects mutated canonical headers and extra terminator blocks");
