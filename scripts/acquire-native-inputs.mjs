#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { format as formatUrl, parse as parseUrl } from "node:url";
import {
  cacheRoot,
  electronRuntimeDirectory,
  assertNoSymlinkPath,
  initializeBuildCache,
  isUniqueRegularFile,
  publishVerifiedBytes,
  publishVerifiedFile,
  readJson,
  recipesPath,
  requireToolchain,
  sha256,
  sha256File,
} from "./lib/build-contract.mjs";

const argumentsSet = new Set(process.argv.slice(2));
const offline = argumentsSet.delete("--offline");
if (argumentsSet.size) throw new Error(`unknown arguments: ${[...argumentsSet].join(" ")}`);

requireToolchain();
await initializeBuildCache();
const recipes = await readJson(recipesPath);
const electron = recipes.externalNativeInputs?.electron;
if (!electron?.version || !electron?.downloadUrlTemplate || !electron?.platformZipSha256) {
  throw new Error("vendor recipe does not define the Electron runtime acquisition contract");
}

const host = `${process.platform}-${process.arch}`;
const expectedSha256 = electron.platformZipSha256[host];
if (!expectedSha256) {
  throw new Error(`Electron ${electron.version} has no audited host archive for ${host}`);
}

const filename = `electron-v${electron.version}-${process.platform}-${process.arch}.zip`;
const archivePath = join(electronRuntimeDirectory, filename);
const electronPackageCacheDirectory = join(cacheRoot, "electron");
const electronPackageCachePath = join(electronPackageCacheDirectory, filename);
const sourceUrl = electron.downloadUrlTemplate
  .replaceAll("{version}", electron.version)
  .replaceAll("{platform}", process.platform)
  .replaceAll("{arch}", process.arch);
const parsedSourceUrl = parseUrl(sourceUrl);
const { search: _search, hash: _hash, pathname, ...sourceUrlWithoutFile } = parsedSourceUrl;
const downloadDirectoryUrl = formatUrl({
  ...sourceUrlWithoutFile,
  pathname: dirname(pathname || "electron"),
});
const electronGetCacheDirectory = sha256(Buffer.from(downloadDirectoryUrl, "utf8"));
if (electronGetCacheDirectory !== electron.electronGetCacheDirectory) {
  throw new Error(
    `@electron/get cache formula mismatch: expected ${electron.electronGetCacheDirectory}, found ${electronGetCacheDirectory}`,
  );
}
const electronGetCachePath = join(
  electronPackageCacheDirectory,
  electronGetCacheDirectory,
  filename,
);

await mkdir(electronRuntimeDirectory, { recursive: true });

const matchesRecipe = async (path) =>
  (await isUniqueRegularFile(path)) && (await sha256File(path)) === expectedSha256;
const verifyElectronArchive = async (path) => (await sha256File(path)) === expectedSha256;

if (
  !(await matchesRecipe(archivePath)) &&
  ((await matchesRecipe(electronGetCachePath)) || (await matchesRecipe(electronPackageCachePath)))
) {
  await publishVerifiedFile(
    (await matchesRecipe(electronGetCachePath)) ? electronGetCachePath : electronPackageCachePath,
    archivePath,
    verifyElectronArchive,
  );
}

if (!(await matchesRecipe(archivePath))) {
  if (offline) {
    throw new Error(
      `offline acquisition cache is missing or invalid: ${basename(archivePath)}; run ./scripts/bootstrap online once`,
    );
  }

  const response = await fetch(sourceUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) throw new Error(`Electron runtime download failed (${response.status}): ${sourceUrl}`);

  const maximumArchiveBytes = 200 * 1024 * 1024;
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maximumArchiveBytes) {
    throw new Error(`Electron runtime archive exceeds 200 MiB limit: ${sourceUrl}`);
  }
  const downloaded = Buffer.from(await response.arrayBuffer());
  if (downloaded.byteLength > maximumArchiveBytes) {
    throw new Error(`Electron runtime archive exceeds 200 MiB limit: ${sourceUrl}`);
  }
  await publishVerifiedBytes(downloaded, archivePath, verifyElectronArchive);
}

if (!(await matchesRecipe(archivePath))) {
  const actualSha256 = existsSync(archivePath) ? await sha256File(archivePath) : "missing-or-unsafe";
  throw new Error(
    `Electron runtime hash mismatch for ${host}: expected ${expectedSha256}, found ${actualSha256}`,
  );
}

await mkdir(electronPackageCacheDirectory, { recursive: true });
if (!(await matchesRecipe(electronPackageCachePath))) {
  await publishVerifiedFile(archivePath, electronPackageCachePath, verifyElectronArchive);
}
await assertNoSymlinkPath(dirname(electronGetCachePath));
await mkdir(dirname(electronGetCachePath), { recursive: true });
if (!(await matchesRecipe(electronGetCachePath))) {
  await publishVerifiedFile(archivePath, electronGetCachePath, verifyElectronArchive);
}

console.log(`verified Electron ${electron.version} host archive for ${host}`);
