#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  cacheRoot,
  packageTreeHash,
  electronRuntimeDirectory,
  normalizedTreeHash,
  readJson,
  recipesPath,
  repositoryRoot,
  requireToolchain,
  sha256File,
  sha512FileIntegrity,
  vendorArtifactsDirectory,
  verifyPackageArtifact,
} from "./lib/build-contract.mjs";

const mode = process.argv[2] ?? "--preinstall";
if (!["--preinstall", "--postinstall", "--artifacts", "--lock-digest"].includes(mode)) {
  throw new Error(`unknown verification mode: ${mode}`);
}

requireToolchain();

const manifestPaths = [
  "package.json",
  "package-lock.json",
  "common/package.json",
  "common/package-lock.json",
  "common/.npmrc",
  "web/package.json",
  "web/package-lock.json",
  "electron/package.json",
  "electron/package-lock.json",
  "electron/electron-builder.unsigned.js",
  "electron-forge/package.json",
  "electron-forge/package-lock.json",
  "vendor/build-tools/package.json",
  "vendor/build-tools/package-lock.json",
  "vendor/build-tools/.npmrc",
  "vendor/recipes/packages.json",
  "vendor/recipes/install-script-allowlist.json",
  ".github/workflows/ci.js.yml",
  ".gitattributes",
  ".npmrc",
  "web/.npmrc",
  "electron/.npmrc",
  "electron-forge/.npmrc",
];

if (mode === "--lock-digest") {
  const digest = createHash("sha256");
  for (const path of manifestPaths.sort()) {
    digest.update(`${path}\0`);
    digest.update(await readFile(join(repositoryRoot, path)));
    digest.update("\0");
  }
  console.log(digest.digest("hex"));
  process.exit(0);
}

const recipesDocument = await readJson(recipesPath);
const recipes = new Map(recipesDocument.packages.map((recipe) => [recipe.name, recipe]));
if (recipesDocument.artifactPolicy.releaseEligible !== false) {
  throw new Error("source-built artifact policy must remain releaseEligible:false");
}
const requiredReleaseBlockerIds = [
  "electron-unsupported",
  "keytar-prebuild-unverified",
  "license-helper-text",
  "license-repository-scanner",
  "permissive-entitlements",
  "signing-notarization-out-of-scope",
  "wasm-toolchain-unpinned",
];
const actualReleaseBlockerIds = (recipesDocument.releaseBlockers ?? [])
  .map((blocker) => blocker.id)
  .sort();
if (JSON.stringify(actualReleaseBlockerIds) !== JSON.stringify(requiredReleaseBlockerIds)) {
  throw new Error(
    `release blocker IDs differ: expected ${requiredReleaseBlockerIds.join(", ")}; found ${actualReleaseBlockerIds.join(", ")}`,
  );
}
if (
  recipesDocument.releaseBlockers.some(
    (blocker) => typeof blocker.description !== "string" || blocker.description.length < 10,
  )
) {
  throw new Error("every release blocker must have a durable description");
}
const helperRecipe = recipes.get("@dicekeys/webasm-module-memory-helper");
const readRecipe = recipes.get("@dicekeys/read-dicekey-js");
const requiredCoverage = [
  [helperRecipe?.license?.releaseBlockerIds, ["license-helper-text"], "helper package"],
  [readRecipe?.license?.releaseBlockerIds, ["license-repository-scanner"], "read package"],
  [
    recipesDocument.nestedSourceInputs?.seededCryptoCpp?.releaseBlockerIds,
    ["wasm-toolchain-unpinned"],
    "seeded WASM input",
  ],
  [
    recipesDocument.nestedSourceInputs?.scannerCpp?.releaseBlockerIds,
    ["license-repository-scanner", "wasm-toolchain-unpinned"],
    "scanner input",
  ],
  [
    recipesDocument.externalNativeInputs?.keytar?.releaseBlockerIds,
    ["keytar-prebuild-unverified"],
    "keytar input",
  ],
  [
    recipesDocument.externalNativeInputs?.electron?.releaseBlockerIds,
    ["electron-unsupported", "permissive-entitlements", "signing-notarization-out-of-scope"],
    "Electron input",
  ],
];
for (const [actual, expected, label] of requiredCoverage) {
  if (JSON.stringify([...(actual ?? [])].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} release blocker coverage differs from the required IDs`);
  }
}
for (const recipe of recipes.values()) {
  if (recipe.typescriptNewLine !== "lf") {
    throw new Error(`${recipe.id} does not force TypeScript LF output`);
  }
  const blockerIds = recipe.license?.releaseBlockerIds ?? [];
  if (Boolean(recipe.license?.releaseBlocker) !== (blockerIds.length > 0)) {
    throw new Error(`${recipe.id} license releaseBlocker flag and blocker IDs disagree`);
  }
}
if (JSON.stringify(recipesDocument).includes("TO_BE_FROZEN")) {
  throw new Error("vendor recipe contains an unfrozen value");
}

const rootManifest = await readJson(join(repositoryRoot, "package.json"));
for (const [name, expected] of Object.entries({
  bootstrap: "bash ./scripts/bootstrap",
  check: "bash ./scripts/check",
  "build-release": "bash ./scripts/build-release",
  "lint:diagnostic": "bash ./scripts/lint-diagnostic",
})) {
  if (rootManifest.scripts?.[name] !== expected) {
    throw new Error(`root npm script ${name} is not explicit Bash and Windows-portable`);
  }
}
const electronManifest = await readJson(join(repositoryRoot, "electron", "package.json"));
for (const name of ["pack", "pack:unsigned"]) {
  if (electronManifest.scripts?.[name] !== "node ../scripts/package-unsigned.mjs") {
    throw new Error(`electron npm script ${name} must use the cross-platform Node unsigned wrapper`);
  }
}
const unsignedBuilderConfigSource = await readFile(
  join(repositoryRoot, "electron", "electron-builder.unsigned.js"),
  "utf8",
);
if (!/\bsignAndEditExecutable:\s*false\b/.test(unsignedBuilderConfigSource)) {
  throw new Error("unsigned Electron Builder config must disable Windows sign/edit tooling");
}

for (const npmrcPath of [
  ".npmrc",
  "common/.npmrc",
  "web/.npmrc",
  "electron/.npmrc",
  "electron-forge/.npmrc",
  "vendor/build-tools/.npmrc",
]) {
  const text = await readFile(join(repositoryRoot, npmrcPath), "utf8");
  if (!text.includes("registry=https://registry.npmjs.org/")) {
    throw new Error(`${npmrcPath} does not select the public npm registry`);
  }
  if (/npm\.pkg\.github\.com|auth|token/i.test(text)) {
    throw new Error(`${npmrcPath} contains private-registry or credential configuration`);
  }
}

const lockPaths = [
  "package-lock.json",
  "common/package-lock.json",
  "web/package-lock.json",
  "electron/package-lock.json",
  "electron-forge/package-lock.json",
  "vendor/build-tools/package-lock.json",
];
const allowlist = await readJson(join(repositoryRoot, "vendor/recipes/install-script-allowlist.json"));

for (const lockPath of lockPaths) {
  const lock = await readJson(join(repositoryRoot, lockPath));
  if (lock.lockfileVersion !== 3) throw new Error(`${lockPath} is not lockfileVersion 3`);
  const packagePath = lockPath.replace(/package-lock\.json$/, "package.json");
  const manifest = await readJson(join(repositoryRoot, packagePath));
  const rootEntry = lock.packages?.[""];
  if (!rootEntry) throw new Error(`${lockPath} has no root package entry`);
  if (manifest.name !== rootEntry.name || manifest.version !== rootEntry.version) {
    throw new Error(`${packagePath} and ${lockPath} root metadata differ`);
  }
  if (manifest.packageManager !== "npm@10.9.8" || manifest.engines?.node !== "22.23.2") {
    throw new Error(`${packagePath} does not pin the Phase 2 toolchain`);
  }

  for (const [packageKey, entry] of Object.entries(lock.packages ?? {})) {
    if (entry.resolved) {
      const allowed =
        entry.resolved.startsWith("https://registry.npmjs.org/") ||
        entry.resolved.startsWith("file:../.cache/vendor/artifacts/");
      if (!allowed) throw new Error(`${lockPath}:${packageKey} has disallowed source ${entry.resolved}`);
      if (entry.resolved.startsWith("https://") && !entry.integrity) {
        throw new Error(`${lockPath}:${packageKey} has no registry integrity`);
      }
    }
  }

  const actualInstallScripts = Object.entries(lock.packages ?? {})
    .filter(([, entry]) => entry.hasInstallScript === true)
    .map(([key]) => key)
    .sort();
  const expectedInstallScripts = [...(allowlist.roots[lockPath] ?? [])].sort();
  if (JSON.stringify(actualInstallScripts) !== JSON.stringify(expectedInstallScripts)) {
    throw new Error(
      `${lockPath} install-script set changed:\nexpected ${expectedInstallScripts.join(", ")}\nfound ${actualInstallScripts.join(", ")}`,
    );
  }

  for (const [sectionName, section] of [
    ["dependencies", manifest.dependencies ?? {}],
    ["devDependencies", manifest.devDependencies ?? {}],
  ]) {
    for (const [name, specification] of Object.entries(section)) {
      const entry = lock.packages[`node_modules/${name}`];
      if (!entry) throw new Error(`${packagePath} ${sectionName}.${name} is missing from its lock`);
      if (specification.startsWith("file:")) {
        if (entry.resolved !== specification) {
          throw new Error(`${packagePath} ${name} local source differs from lock`);
        }
      } else if (specification.startsWith("npm:")) {
        const exactAliasVersion = specification.match(/@([0-9]+\.[0-9]+\.[0-9][^/]*)$/)?.[1];
        if (entry.version !== exactAliasVersion) throw new Error(`${packagePath} alias ${name} is not exact`);
      } else if (specification !== entry.version) {
        throw new Error(`${packagePath} ${name} is not pinned to locked version ${entry.version}`);
      }
    }
  }

  for (const [packageKey, entry] of Object.entries(lock.packages ?? {})) {
    if (!packageKey.startsWith("node_modules/@dicekeys/")) continue;
    const packageName = packageKey.slice("node_modules/".length);
    const recipe = recipes.get(packageName);
    if (!recipe) throw new Error(`${lockPath} has unapproved DiceKeys package ${packageName}`);
    const expectedResolution = `file:../.cache/vendor/artifacts/${recipe.artifact.filename}`;
    if (entry.resolved !== expectedResolution) {
      throw new Error(`${lockPath} ${packageName} must resolve to ${expectedResolution}`);
    }
    if (entry.integrity !== recipe.artifact.integrity) {
      throw new Error(`${lockPath} ${packageName} integrity differs from source-built recipe`);
    }
    if (mode === "--postinstall") {
      const lockDirectory = lockPath === "package-lock.json" ? repositoryRoot : join(repositoryRoot, lockPath, "..");
      const installedPath = join(lockDirectory, "node_modules", ...packageName.split("/"));
      if (!existsSync(installedPath)) throw new Error(`${lockPath} did not install ${packageName}`);
      const installedTree = await normalizedTreeHash(installedPath);
      if (installedTree !== recipe.artifact.packageTreeSha256) {
        throw new Error(
          `${lockPath} installed ${packageName} tree mismatch: expected ${recipe.artifact.packageTreeSha256}, found ${installedTree}`,
        );
      }
    }
  }
}

for (const [path, expected] of [
  ["package.json", "UNLICENSED"],
  ["common/package.json", "UNLICENSED"],
  ["web/package.json", "UNLICENSED"],
  ["electron/package.json", "UNLICENSED"],
  ["electron-forge/package.json", "UNLICENSED"],
  ["vendor/build-tools/package.json", "UNLICENSED"],
]) {
  if ((await readJson(join(repositoryRoot, path))).license !== expected) {
    throw new Error(`${path} must keep the unresolved repository license visible as UNLICENSED`);
  }
}

if (mode === "--artifacts" || mode === "--postinstall") {
  for (const recipe of recipes.values()) {
    const artifactPath = join(vendorArtifactsDirectory, recipe.artifact.filename);
    if (!existsSync(artifactPath)) throw new Error(`missing source-built artifact ${recipe.artifact.filename}`);
    const verification = await verifyPackageArtifact(artifactPath, recipe.artifact);
    if (!verification.matches) {
      throw new Error(
        `${recipe.id} source-built artifact mismatch during ${verification.phase}: ${JSON.stringify(verification.actual)}`,
      );
    }
  }

  const electron = recipesDocument.externalNativeInputs?.electron;
  const host = `${process.platform}-${process.arch}`;
  const electronArchiveSha256 = electron?.platformZipSha256?.[host];
  if (!electronArchiveSha256) {
    throw new Error(`Electron ${electron?.version ?? "unknown"} has no audited host archive for ${host}`);
  }
  const electronArchive = join(
    electronRuntimeDirectory,
    `electron-v${electron.version}-${process.platform}-${process.arch}.zip`,
  );
  if (!existsSync(electronArchive)) throw new Error(`missing audited Electron host archive for ${host}`);
  const actualElectronArchiveSha256 = await sha256File(electronArchive);
  if (actualElectronArchiveSha256 !== electronArchiveSha256) {
    throw new Error(
      `Electron host archive mismatch: expected ${electronArchiveSha256}, found ${actualElectronArchiveSha256}`,
    );
  }
  const electronGetCacheArchive = join(
    cacheRoot,
    "electron",
    electron.electronGetCacheDirectory,
    `electron-v${electron.version}-${process.platform}-${process.arch}.zip`,
  );
  if (!existsSync(electronGetCacheArchive)) {
    throw new Error(`missing seeded @electron/get host cache archive for ${host}`);
  }
  const actualElectronGetCacheSha256 = await sha256File(electronGetCacheArchive);
  if (actualElectronGetCacheSha256 !== electronArchiveSha256) {
    throw new Error(
      `@electron/get host cache mismatch: expected ${electronArchiveSha256}, found ${actualElectronGetCacheSha256}`,
    );
  }
}

if (mode === "--postinstall") {
  const electronChecksumsPath = join(repositoryRoot, "electron", "node_modules", "electron", "checksums.json");
  if (!existsSync(electronChecksumsPath)) throw new Error("Electron install is missing checksums.json");
  const expectedChecksumsSha256 = recipesDocument.externalNativeInputs?.electron?.checksumsJsonSha256;
  const actualChecksumsSha256 = await sha256File(electronChecksumsPath);
  if (actualChecksumsSha256 !== expectedChecksumsSha256) {
    throw new Error(
      `Electron checksums.json mismatch: expected ${expectedChecksumsSha256}, found ${actualChecksumsSha256}`,
    );
  }

  const electronPackageRoot = join(repositoryRoot, "electron", "node_modules", "electron");
  const electronDistRoot = join(electronPackageRoot, "dist");
  const electronRelativeExecutable = (await readFile(join(electronPackageRoot, "path.txt"), "utf8")).trim();
  if (
    !electronRelativeExecutable ||
    resolve(electronDistRoot, electronRelativeExecutable) === electronDistRoot ||
    !`${resolve(electronDistRoot, electronRelativeExecutable)}${sep}`.startsWith(`${resolve(electronDistRoot)}${sep}`)
  ) {
    throw new Error(`Electron path.txt has an unsafe executable path: ${electronRelativeExecutable}`);
  }
  const electronExecutable = resolve(electronDistRoot, electronRelativeExecutable);
  const electronExecutableInfo = await lstat(electronExecutable);
  if (!electronExecutableInfo.isFile() || electronExecutableInfo.size === 0) {
    throw new Error(`Electron host executable is missing or empty: ${electronExecutable}`);
  }
  if (process.platform !== "win32" && (electronExecutableInfo.mode & 0o111) === 0) {
    throw new Error(`Electron host executable has no execute mode: ${electronExecutable}`);
  }
  const installedElectronVersion = (await readFile(join(electronDistRoot, "version"), "utf8")).trim();
  if (installedElectronVersion !== recipesDocument.externalNativeInputs.electron.version) {
    throw new Error(
      `installed Electron version mismatch: expected ${recipesDocument.externalNativeInputs.electron.version}, found ${installedElectronVersion}`,
    );
  }

  const keytarBinding = join(
    repositoryRoot,
    "electron",
    "node_modules",
    "keytar",
    "build",
    "Release",
    "keytar.node",
  );
  const keytarBindingInfo = await lstat(keytarBinding);
  if (!keytarBindingInfo.isFile() || keytarBindingInfo.size === 0) {
    throw new Error(`keytar host native binding is missing or empty: ${keytarBinding}`);
  }
}

console.log(`build contract verified (${mode.slice(2)})`);
