#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, link, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  cacheRoot,
  filesystemManifestHash,
  initializeBuildCache,
  repositoryRoot,
} from "./lib/build-contract.mjs";

await initializeBuildCache();
const testRoot = await mkdtemp(join(cacheRoot, "test-results", "checksum-completeness-"));
const writeJson = (name, value) => writeFile(join(testRoot, name), `${JSON.stringify(value)}\n`);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runVerifier = () =>
  spawnSync(process.execPath, [join(repositoryRoot, "scripts", "verify-release-checksums.mjs"), testRoot], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
const writeChecksums = async (paths) => {
  const lines = [];
  for (const name of paths) {
    const bytes = await import("node:fs/promises").then(({ readFile }) => readFile(join(testRoot, name)));
    lines.push(`${digest(bytes)}  ${name}\n`);
  }
  await writeFile(join(testRoot, "SHA256SUMS"), lines.join(""));
};

try {
  await writeFile(join(testRoot, "desktop.tar"), "archive\n");
  const layoutSha256 = filesystemManifestHash([]);
  await writeJson("desktop-archive-manifest.json", {
    schemaVersion: 1,
    sourceDateEpoch: 946684800,
    sourceTreeSha256: digest(Buffer.from("tree")),
    sourceLayoutSha256: layoutSha256,
    entries: [],
  });
  const archivePath = "desktop.tar";
  await writeJson("desktop-archive-assertions.json", {
    archive: archivePath,
    archiveSha256: digest(Buffer.from("archive\n")),
    archiveTreeSha256: digest(Buffer.from("tree")),
    archiveLayoutSha256: layoutSha256,
    entryCount: 0,
    extractedAndCompared: true,
    archiveModesBound: true,
    extractedModesCompared: process.platform !== "win32",
    extractedSymlinkLayoutCompared: true,
    passed: true,
  });
  await writeJson("symlink-manifest.json", { schemaVersion: 1, archive: archivePath, entries: [] });
  await writeJson("provenance.json", {
    source: { sourceDateEpoch: 946684800 },
    toolchain: { platform: process.platform },
  });
  await writeFile(join(testRoot, "data.txt"), "bound\n");
  const baseline = [
    "data.txt",
    "desktop-archive-assertions.json",
    "desktop-archive-manifest.json",
    "desktop.tar",
    "provenance.json",
    "symlink-manifest.json",
  ];
  await writeChecksums(baseline);
  if (runVerifier().status !== 0) throw new Error("complete checksum fixture did not verify");

  const downloadParent = await mkdtemp(join(cacheRoot, "test-results", "flattened-download-"));
  const downloadRoot = join(downloadParent, "downloaded-artifact");
  try {
    await cp(testRoot, downloadRoot, { recursive: true });
    const flattened = spawnSync(
      process.execPath,
      [join(repositoryRoot, "scripts", "verify-release-checksums.mjs"), downloadRoot],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    if (flattened.status !== 0) {
      throw new Error(`flattened upload-artifact layout did not verify:\n${flattened.stdout}${flattened.stderr}`);
    }
  } finally {
    await rm(downloadParent, { recursive: true, force: true });
  }

  await writeFile(join(testRoot, "unlisted.txt"), "extra\n");
  if (runVerifier().status === 0) throw new Error("checksum verifier accepted an unlisted extra file");
  await unlink(join(testRoot, "unlisted.txt"));

  await unlink(join(testRoot, "data.txt"));
  if (runVerifier().status === 0) throw new Error("checksum verifier accepted a missing listed file");
  await writeFile(join(testRoot, "data.txt"), "bound\n");
  await writeChecksums(baseline);

  if (process.platform !== "win32") {
    const symlinkParent = await mkdtemp(join(cacheRoot, "test-results", "checksum-root-link-"));
    const symlinkRoot = join(symlinkParent, "release-link");
    try {
      await symlink(testRoot, symlinkRoot, "dir");
      const linked = spawnSync(
        process.execPath,
        [join(repositoryRoot, "scripts", "verify-release-checksums.mjs"), symlinkRoot],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      if (linked.status === 0) throw new Error("checksum verifier accepted a symlinked release root");
    } finally {
      await unlink(symlinkRoot).catch(() => {});
      await rm(symlinkParent, { recursive: true, force: true });
    }

    const checksumLinkParent = await mkdtemp(join(cacheRoot, "test-results", "checksum-file-link-"));
    const externalChecksum = join(checksumLinkParent, "external-SHA256SUMS");
    const checksumContents = await readFile(join(testRoot, "SHA256SUMS"));
    try {
      await writeFile(externalChecksum, checksumContents);
      await unlink(join(testRoot, "SHA256SUMS"));
      await symlink(externalChecksum, join(testRoot, "SHA256SUMS"), "file");
      if (runVerifier().status === 0) {
        throw new Error("checksum verifier accepted a symlinked SHA256SUMS file");
      }
      if (!(await readFile(externalChecksum)).equals(checksumContents)) {
        throw new Error("checksum verifier modified an external SHA256SUMS target");
      }
    } finally {
      await unlink(join(testRoot, "SHA256SUMS")).catch(() => {});
      await writeFile(join(testRoot, "SHA256SUMS"), checksumContents);
      await rm(checksumLinkParent, { recursive: true, force: true });
    }

    const manifestLinkParent = await mkdtemp(join(cacheRoot, "test-results", "manifest-hardlink-"));
    const externalManifest = join(manifestLinkParent, "desktop-archive-manifest.json");
    const manifestPath = join(testRoot, "desktop-archive-manifest.json");
    const manifestContents = await readFile(manifestPath);
    try {
      await writeFile(externalManifest, manifestContents);
      await unlink(manifestPath);
      await link(externalManifest, manifestPath);
      if (runVerifier().status === 0) {
        throw new Error("checksum verifier accepted a hardlinked archive manifest");
      }
      if (!(await readFile(externalManifest)).equals(manifestContents)) {
        throw new Error("checksum verifier modified an external archive manifest inode");
      }
    } finally {
      await unlink(manifestPath).catch(() => {});
      await writeFile(manifestPath, manifestContents);
      await rm(manifestLinkParent, { recursive: true, force: true });
    }
  }

  const escapeLine = `${digest(Buffer.from("escape\n"))}  ../escape.txt\n`;
  await writeFile(join(testRoot, "SHA256SUMS"), escapeLine);
  if (runVerifier().status === 0) throw new Error("checksum verifier accepted a path traversal entry");
} finally {
  await rm(testRoot, { recursive: true, force: true });
}

console.log("checksum verifier rejects extra, missing, and path-traversal entries");
