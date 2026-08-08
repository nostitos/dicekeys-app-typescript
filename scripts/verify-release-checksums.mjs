#!/usr/bin/env node
import { existsSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  filesystemManifestHash,
  readJson,
  repositoryRoot,
  sha256File,
} from "./lib/build-contract.mjs";
import {
  isSafeArchiveEntryPath,
  isSafeArchiveSymlinkTarget,
} from "./lib/deterministic-tar.mjs";

const releaseDirectory = resolve(process.argv[2] ?? join(repositoryRoot, "release-artifacts"));
const releaseDirectoryInfo = await lstat(releaseDirectory);
if (!releaseDirectoryInfo.isDirectory() || releaseDirectoryInfo.isSymbolicLink()) {
  throw new Error(`release artifact root is not a real directory: ${releaseDirectory}`);
}
const checksumPath = join(releaseDirectory, "SHA256SUMS");
const checksumInfo = await lstat(checksumPath);
if (!checksumInfo.isFile() || checksumInfo.isSymbolicLink() || checksumInfo.nlink !== 1) {
  throw new Error(`SHA256SUMS is not a unique regular file: ${checksumPath}`);
}
const symlinkManifestPath = join(releaseDirectory, "symlink-manifest.json");
const desktopManifestPath = join(releaseDirectory, "desktop-archive-manifest.json");
const desktopAssertionPath = join(releaseDirectory, "desktop-archive-assertions.json");
const provenancePath = join(releaseDirectory, "provenance.json");
for (const path of [checksumPath, symlinkManifestPath, desktopManifestPath, desktopAssertionPath, provenancePath]) {
  if (!existsSync(path)) throw new Error(`release checksum evidence is incomplete: ${path}`);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`release checksum evidence is not a unique regular file: ${path}`);
  }
}

const checksumLines = (await readFile(checksumPath, "utf8")).split("\n").filter(Boolean);
const seenPaths = new Set();
for (const line of checksumLines) {
  const match = line.match(/^([0-9a-f]{64})  (.+)$/);
  if (!match) throw new Error(`invalid SHA256SUMS line: ${line}`);
  const [, expected, relativePath] = match;
  if (
    isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((component) => component === ".." || !component)
  ) {
    throw new Error(`unsafe SHA256SUMS path: ${relativePath}`);
  }
  if (seenPaths.has(relativePath)) throw new Error(`duplicate SHA256SUMS path: ${relativePath}`);
  const absolutePath = resolve(releaseDirectory, ...relativePath.split("/"));
  if (
    absolutePath === releaseDirectory ||
    !`${absolutePath}${sep}`.startsWith(`${releaseDirectory}${sep}`)
  ) {
    throw new Error(`SHA256SUMS path escapes release-artifacts: ${relativePath}`);
  }
  seenPaths.add(relativePath);
  const info = await lstat(absolutePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`SHA256SUMS entry is not a regular file: ${relativePath}`);
  }
  const actual = await sha256File(absolutePath);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${relativePath}: expected ${expected}, found ${actual}`);
  }
}

const actualRegularPaths = [];
const walkRegularFiles = async (root) => {
  for (const name of (await readdir(root)).sort()) {
    if (root === releaseDirectory && name === "SHA256SUMS") continue;
    const path = join(root, name);
    const info = await lstat(path);
    if (info.isDirectory()) await walkRegularFiles(path);
    else if (info.isFile() && !info.isSymbolicLink()) {
      actualRegularPaths.push(relative(releaseDirectory, path).split(sep).join("/"));
    } else {
      throw new Error(`release-artifacts contains unsupported non-regular entry: ${path}`);
    }
  }
};
await walkRegularFiles(releaseDirectory);
actualRegularPaths.sort();
const listedPaths = [...seenPaths].sort();
if (JSON.stringify(actualRegularPaths) !== JSON.stringify(listedPaths)) {
  const missing = actualRegularPaths.filter((path) => !seenPaths.has(path));
  const extra = listedPaths.filter((path) => !actualRegularPaths.includes(path));
  throw new Error(
    `SHA256SUMS file set is incomplete: unlisted=${missing.join(", ")} missing=${extra.join(", ")}`,
  );
}

const symlinkManifest = await readJson(symlinkManifestPath);
const desktopManifest = await readJson(desktopManifestPath);
const desktopAssertions = await readJson(desktopAssertionPath);
const provenance = await readJson(provenancePath);
const archivedSymlinks = desktopManifest.entries
  .filter((entry) => entry.type === "symbolic-link")
  .map(({ path, target, type }) => ({ path, target, type }));
const manifestPaths = new Set();
for (const entry of desktopManifest.entries) {
  if (!isSafeArchiveEntryPath(entry.path, desktopManifest.archiveRoot)) {
    throw new Error(`desktop archive manifest has unsafe entry path: ${entry.path}`);
  }
  if (manifestPaths.has(entry.path)) {
    throw new Error(`desktop archive manifest repeats entry path: ${entry.path}`);
  }
  manifestPaths.add(entry.path);
}
if (
  symlinkManifest.schemaVersion !== 1 ||
  symlinkManifest.archive !== desktopAssertions.archive ||
  JSON.stringify(symlinkManifest.entries) !== JSON.stringify(archivedSymlinks) ||
  desktopAssertions.passed !== true ||
  desktopAssertions.extractedAndCompared !== true ||
  desktopAssertions.archiveModesBound !== true ||
  desktopAssertions.extractedSymlinkLayoutCompared !== true ||
  desktopAssertions.extractedModesCompared !== (provenance.toolchain?.platform !== "win32") ||
  desktopAssertions.archiveTreeSha256 !== desktopManifest.sourceTreeSha256 ||
  desktopAssertions.archiveLayoutSha256 !== desktopManifest.sourceLayoutSha256 ||
  desktopAssertions.entryCount !== desktopManifest.entries.length ||
  desktopManifest.sourceLayoutSha256 !== filesystemManifestHash(desktopManifest.entries) ||
  desktopManifest.sourceDateEpoch !== provenance.source?.sourceDateEpoch
) {
  throw new Error("desktop archive symlink/assertion evidence is inconsistent");
}
for (const entry of archivedSymlinks) {
  if (!isSafeArchiveSymlinkTarget(entry.path, entry.target, desktopManifest.archiveRoot)) {
    throw new Error(`desktop archive symlink escapes its root: ${entry.path} -> ${entry.target}`);
  }
}
if (
  !desktopAssertions.archive ||
  isAbsolute(desktopAssertions.archive) ||
  desktopAssertions.archive.includes("\\") ||
  desktopAssertions.archive.split("/").some((component) => !component || component === "..")
) {
  throw new Error(`unsafe desktop archive assertion path: ${desktopAssertions.archive}`);
}
const assertedArchivePath = resolve(releaseDirectory, ...desktopAssertions.archive.split("/"));
if (desktopAssertions.archiveSha256 !== (await sha256File(assertedArchivePath))) {
  throw new Error("desktop archive assertion SHA-256 differs from the distributable archive");
}
for (const requiredPath of [symlinkManifestPath, desktopManifestPath, desktopAssertionPath]) {
  const relativePath = relative(releaseDirectory, requiredPath).split(sep).join("/");
  if (!seenPaths.has(relativePath)) throw new Error(`SHA256SUMS does not bind ${relativePath}`);
}
if (!seenPaths.has(desktopAssertions.archive)) {
  throw new Error(`SHA256SUMS does not bind desktop archive ${desktopAssertions.archive}`);
}

console.log(
  `verified complete set of ${checksumLines.length} regular files and ${archivedSymlinks.length} archived symlinks`,
);
