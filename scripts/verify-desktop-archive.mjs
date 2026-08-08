#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assertNoSymlinkPath,
  filesystemManifestEntries,
  filesystemManifestHash,
  normalizedTreeHash,
  relativePathInside,
  readJson,
  repositoryRoot,
  run,
  sha256File,
} from "./lib/build-contract.mjs";
import {
  createDeterministicTar,
  extractionComparisonEntries,
  isSafeArchiveEntryPath,
  isSafeArchiveSymlinkTarget,
} from "./lib/deterministic-tar.mjs";

const [archiveArgument, sourceArgument, manifestArgument, assertionArgument] = process.argv.slice(2);
if (!archiveArgument || !sourceArgument || !manifestArgument || !assertionArgument) {
  throw new Error(
    "usage: verify-desktop-archive.mjs <archive.tar> <source> <manifest.json> <assertion.json>",
  );
}
const archivePath = resolve(archiveArgument);
const source = resolve(sourceArgument);
const manifestPath = resolve(manifestArgument);
const assertionPath = resolve(assertionArgument);
for (const path of [archivePath, source, manifestPath]) {
  if (!existsSync(path)) throw new Error(`desktop archive verification input is missing: ${path}`);
}
await assertNoSymlinkPath(assertionPath);

const manifest = await readJson(manifestPath);
if (manifest.schemaVersion !== 1 || manifest.archiveFormat !== "ustar") {
  throw new Error("unsupported desktop archive manifest");
}
const root = manifest.archiveRoot;
if (!root || root.startsWith("/") || root.split("/").some((part) => part === ".." || !part)) {
  throw new Error(`unsafe desktop archive root: ${root}`);
}

const archive = await readFile(archivePath);
const canonicalRoot = await mkdtemp(join(tmpdir(), "dicekeys-canonical-desktop-archive-"));
try {
  const canonicalArchivePath = join(canonicalRoot, "canonical.tar");
  await createDeterministicTar({
    source,
    output: canonicalArchivePath,
    manifestPath: join(canonicalRoot, "manifest.json"),
    symlinkManifestPath: join(canonicalRoot, "symlinks.json"),
    prefix: root,
    epoch: manifest.sourceDateEpoch,
  });
  const canonicalArchive = await readFile(canonicalArchivePath);
  if (!archive.equals(canonicalArchive)) {
    throw new Error("desktop archive bytes differ from a freshly regenerated canonical ustar");
  }
} finally {
  await rm(canonicalRoot, { recursive: true, force: true });
}
const readString = (buffer, offset, length) => {
  const field = buffer.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
};
const readOctal = (buffer, offset, length) => {
  const value = readString(buffer, offset, length).trim();
  return value ? Number.parseInt(value, 8) : 0;
};
const parsedEntries = [];
let offset = 0;
let zeroBlocks = 0;
while (offset + 512 <= archive.length) {
  const header = archive.subarray(offset, offset + 512);
  if (header.every((value) => value === 0)) {
    zeroBlocks += 1;
    offset += 512;
    if (zeroBlocks === 2) break;
    continue;
  }
  zeroBlocks = 0;
  const checksumHeader = Buffer.from(header);
  checksumHeader.fill(0x20, 148, 156);
  const expectedChecksum = readOctal(header, 148, 8);
  const actualChecksum = checksumHeader.reduce((sum, value) => sum + value, 0);
  if (expectedChecksum !== actualChecksum) throw new Error("desktop tar header checksum mismatch");
  if (readString(header, 257, 6) !== "ustar") throw new Error("desktop archive is not ustar");
  const name = readString(header, 0, 100);
  const prefix = readString(header, 345, 155);
  const tarPath = prefix ? `${prefix}/${name}` : name;
  const normalizedPath = tarPath.endsWith("/") ? tarPath.slice(0, -1) : tarPath;
  if (!isSafeArchiveEntryPath(normalizedPath, root)) {
    throw new Error(`desktop tar entry has unsafe path: ${normalizedPath}`);
  }
  const mode = readOctal(header, 100, 8).toString(8).padStart(4, "0");
  const size = readOctal(header, 124, 12);
  const typeFlag = readString(header, 156, 1) || "0";
  offset += 512;
  const content = archive.subarray(offset, offset + size);
  if (content.length !== size) throw new Error(`truncated desktop tar entry: ${normalizedPath}`);
  if (typeFlag === "5") {
    parsedEntries.push({ mode, path: normalizedPath, type: "directory" });
  } else if (typeFlag === "2") {
    const target = readString(header, 157, 100);
    if (!isSafeArchiveSymlinkTarget(normalizedPath, target, root)) {
      throw new Error(`desktop tar symlink escapes its archive root: ${normalizedPath} -> ${target}`);
    }
    parsedEntries.push({
      mode,
      path: normalizedPath,
      target,
      type: "symbolic-link",
    });
  } else if (typeFlag === "0") {
    parsedEntries.push({
      mode,
      path: normalizedPath,
      sha256: createHash("sha256").update(content).digest("hex"),
      size,
      type: "file",
    });
  } else {
    throw new Error(`unsupported desktop tar entry type ${typeFlag}: ${normalizedPath}`);
  }
  offset += size + ((512 - (size % 512)) % 512);
}
if (zeroBlocks !== 2 || archive.subarray(offset).some((value) => value !== 0)) {
  throw new Error("desktop tar has no deterministic two-block terminator");
}
if (JSON.stringify(parsedEntries) !== JSON.stringify(manifest.entries)) {
  throw new Error("desktop tar headers/content differ from desktop-archive-manifest.json");
}

const sourceEntries = [
  { mode: "0755", path: root, type: "directory" },
  ...(await filesystemManifestEntries(source, root)),
];
if (JSON.stringify(sourceEntries) !== JSON.stringify(manifest.entries)) {
  throw new Error("desktop archive manifest differs from packaged source modes, links, or files");
}

const extractionRoot = await mkdtemp(join(tmpdir(), "dicekeys-desktop-archive-"));
try {
  run("tar", ["-xpf", archivePath, "-C", extractionRoot]);
  const extractedRoot = join(extractionRoot, root);
  const extractedInfo = await lstat(extractedRoot);
  if (!extractedInfo.isDirectory() || extractedInfo.isSymbolicLink()) {
    throw new Error("desktop archive did not extract to a real root directory");
  }
  const sourceTreeSha256 = await normalizedTreeHash(source);
  const extractedTreeSha256 = await normalizedTreeHash(extractedRoot);
  if (sourceTreeSha256 !== extractedTreeSha256 || sourceTreeSha256 !== manifest.sourceTreeSha256) {
    throw new Error("extracted desktop archive tree differs from packaged source tree");
  }
  const extractedEntries = [
    { mode: "0755", path: root, type: "directory" },
    ...(await filesystemManifestEntries(extractedRoot, root)),
  ];
  if (
    JSON.stringify(extractionComparisonEntries(extractedEntries)) !==
    JSON.stringify(extractionComparisonEntries(manifest.entries))
  ) {
    throw new Error("extracted desktop archive did not preserve modes or symlink layout");
  }
  if (filesystemManifestHash(parsedEntries) !== manifest.sourceLayoutSha256) {
    throw new Error("desktop archive layout hash differs from its manifest");
  }

  await writeFile(
    assertionPath,
    `${JSON.stringify({
      schemaVersion: 1,
      archive:
        relativePathInside(archivePath, dirname(assertionPath)) ??
        (() => {
          throw new Error("desktop archive must be inside its distributable evidence directory");
        })(),
      archiveSha256: await sha256File(archivePath),
      archiveTreeSha256: extractedTreeSha256,
      archiveLayoutSha256: manifest.sourceLayoutSha256,
      entryCount: parsedEntries.length,
      extractedAndCompared: true,
      archiveModesBound: true,
      extractedModesCompared: process.platform !== "win32",
      extractedSymlinkLayoutCompared: true,
      passed: true,
      releaseEligible: false,
    }, null, 2)}\n`,
    { mode: 0o644 },
  );
} finally {
  await rm(extractionRoot, { recursive: true, force: true });
}

console.log(`verified deterministic desktop archive extraction and ${parsedEntries.length} entries`);
