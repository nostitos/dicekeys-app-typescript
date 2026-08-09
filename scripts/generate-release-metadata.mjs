#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  filesystemManifestHash,
  normalizedTreeHash,
  readJson,
  relativePathInside,
  recipesPath,
  repositoryRoot,
  requiredNodeVersion,
  requiredNpmVersion,
  run,
  runGit,
  sha256File,
} from "./lib/build-contract.mjs";
import { normalizeLocalSourceBuiltReferences } from "./lib/normalize-sbom.mjs";
import {
  isSafeArchiveEntryPath,
  isSafeArchiveSymlinkTarget,
} from "./lib/deterministic-tar.mjs";
import { inspectSourceCleanliness } from "./lib/source-cleanliness.mjs";

const releaseDirectory = resolve(process.argv[2] ?? join(repositoryRoot, "release-artifacts"));
const epoch = Number(process.env.SOURCE_DATE_EPOCH);
if (!Number.isInteger(epoch)) throw new Error("SOURCE_DATE_EPOCH must be set");
const timestamp = new Date(epoch * 1000).toISOString();
const recipes = await readJson(recipesPath);
const offlineReplay = process.env.DICEKEYS_BUILD_RELEASE_OFFLINE === "true";
const dirtyEvaluationOverride =
  process.env.DICEKEYS_BUILD_RELEASE_ALLOW_DIRTY_EVALUATION === "true";
const buildReleaseInvocation = [
  "./scripts/build-release",
  ...(offlineReplay ? ["--offline"] : []),
  ...(dirtyEvaluationOverride ? ["--allow-dirty-evaluation"] : []),
].join(" ");

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
};
const deterministicUuid = (seed) => {
  const bytes = Buffer.from(createHash("sha256").update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const sbomDirectory = join(releaseDirectory, "sbom");
const inventoryComponents = [];
for (const name of (await readdir(sbomDirectory)).filter((entry) => entry.endsWith(".raw.cdx.json")).sort()) {
  const rawPath = join(sbomDirectory, name);
  const sbom = JSON.parse(await readFile(rawPath, "utf8"));
  delete sbom.serialNumber;
  if (sbom.metadata) delete sbom.metadata.timestamp;
  normalizeLocalSourceBuiltReferences({
    sbom,
    checkoutRoot: repositoryRoot,
    recipes: recipes.packages,
  });
  const stableSbomSeed = JSON.stringify(stable(sbom));
  sbom.metadata = { ...(sbom.metadata ?? {}), timestamp };
  sbom.serialNumber = `urn:uuid:${deterministicUuid(`${name}:${stableSbomSeed}`)}`;
  for (const component of sbom.components ?? []) {
    inventoryComponents.push({
      root: name.replace(".raw.cdx.json", ""),
      name: component.name,
      version: component.version ?? null,
      purl: component.purl ?? null,
      licenses: component.licenses ?? [],
    });
  }
  const normalizedPath = join(sbomDirectory, name.replace(".raw.cdx.json", ".cdx.json"));
  await writeFile(normalizedPath, `${JSON.stringify(stable(sbom), null, 2)}\n`);
  await rm(rawPath);
}

await writeFile(
  join(releaseDirectory, "dependency-inventory.json"),
  `${JSON.stringify(stable({
    releaseEligible: false,
    blockers: recipes.releaseBlockers,
    npmComponents: inventoryComponents,
    sourceBuiltReplacements: recipes.packages.map((recipe) => ({
      name: recipe.name,
      version: recipe.version,
      commit: recipe.commit,
      artifactSha256: recipe.artifact.sha256,
      packageTreeSha256: recipe.artifact.packageTreeSha256,
      license: recipe.license,
      publishedByteEquivalenceClaimed: false,
    })),
    externalNativeInputs: recipes.externalNativeInputs,
    nestedSourceInputs: recipes.nestedSourceInputs,
  }), null, 2)}\n`,
);

const commit = runGit(["rev-parse", "HEAD"]);
const sourceCleanliness = await inspectSourceCleanliness();
if (!sourceCleanliness.clean && !dirtyEvaluationOverride) {
  throw new Error("release source became dirty before provenance generation");
}
const packageAssertions = await readJson(join(releaseDirectory, "package-assertions.json"));
const desktopArchiveAssertions = await readJson(
  join(releaseDirectory, "desktop-archive-assertions.json"),
);
const desktopArchiveManifest = await readJson(join(releaseDirectory, "desktop-archive-manifest.json"));
const symlinkManifest = await readJson(join(releaseDirectory, "symlink-manifest.json"));
const sourceStateSha256 = process.env.DICEKEYS_BUILD_RELEASE_SOURCE_STATE_SHA256;
if (!/^[0-9a-f]{64}$/.test(sourceStateSha256 ?? "")) {
  throw new Error("build-release did not provide its initial source-state SHA-256");
}
const currentSourceStateSha256 = run(
  process.execPath,
  [join(repositoryRoot, "scripts", "tracked-state.mjs")],
  { capture: true },
);
if (currentSourceStateSha256 !== sourceStateSha256) {
  throw new Error("source state changed before release metadata generation");
}
const archiveRelativePath = desktopArchiveAssertions.archive;
if (
  !archiveRelativePath ||
  isAbsolute(archiveRelativePath) ||
  archiveRelativePath.includes("\\") ||
  archiveRelativePath.split("/").some((component) => !component || component === "..")
) {
  throw new Error(`unsafe desktop archive assertion path: ${archiveRelativePath}`);
}
const archivePath = resolve(releaseDirectory, ...archiveRelativePath.split("/"));
if (relativePathInside(archivePath, releaseDirectory) !== archiveRelativePath) {
  throw new Error(`desktop archive assertion path is not canonical: ${archiveRelativePath}`);
}
if (
  desktopArchiveAssertions.passed !== true ||
  desktopArchiveAssertions.extractedAndCompared !== true ||
  desktopArchiveAssertions.archiveModesBound !== true ||
  desktopArchiveAssertions.extractedSymlinkLayoutCompared !== true ||
  desktopArchiveAssertions.extractedModesCompared !== (process.platform !== "win32") ||
  desktopArchiveAssertions.archiveSha256 !== (await sha256File(archivePath)) ||
  desktopArchiveAssertions.archiveTreeSha256 !== desktopArchiveManifest.sourceTreeSha256 ||
  desktopArchiveAssertions.archiveLayoutSha256 !== desktopArchiveManifest.sourceLayoutSha256 ||
  desktopArchiveAssertions.entryCount !== desktopArchiveManifest.entries.length ||
  desktopArchiveManifest.sourceLayoutSha256 !== filesystemManifestHash(desktopArchiveManifest.entries) ||
  desktopArchiveManifest.sourceDateEpoch !== epoch ||
  symlinkManifest.archive !== archiveRelativePath ||
  JSON.stringify(symlinkManifest.entries) !==
    JSON.stringify(desktopArchiveManifest.entries.filter((entry) => entry.type === "symbolic-link").map(
      ({ path, target, type }) => ({ path, target, type }),
    ))
) {
  throw new Error("desktop archive assertion, tree manifest, and symlink manifest disagree");
}
const manifestPaths = new Set();
for (const entry of desktopArchiveManifest.entries) {
  if (!isSafeArchiveEntryPath(entry.path, desktopArchiveManifest.archiveRoot)) {
    throw new Error(`desktop archive manifest has unsafe entry path: ${entry.path}`);
  }
  if (manifestPaths.has(entry.path)) {
    throw new Error(`desktop archive manifest repeats entry path: ${entry.path}`);
  }
  manifestPaths.add(entry.path);
}
for (const entry of symlinkManifest.entries) {
  if (!isSafeArchiveSymlinkTarget(entry.path, entry.target, desktopArchiveManifest.archiveRoot)) {
    throw new Error(`desktop archive symlink evidence escapes its root: ${entry.path} -> ${entry.target}`);
  }
}
if (
  packageAssertions.passed !== true ||
  packageAssertions.applicationPublisherSigningApplied !== false
) {
  throw new Error("unsigned package assertion does not prove application publisher signing absent");
}
const commitShort = commit.slice(0, 12);
const acquisitionLabel = offlineReplay ? "cache-replay" : "online";
const webArchive = `release-artifacts/DiceKeys-web-${commitShort}-${acquisitionLabel}-UNSIGNED-EVALUATION.zip`;
const desktopArchiveCommandPath = `release-artifacts/${archiveRelativePath}`;
const sbomRoots = [".", "common", "web", "electron", "electron-forge", "vendor/build-tools"];
const provenance = {
  schemaVersion: 1,
  releaseEligible: false,
  artifactClass: "local unsigned evaluation output; not shippable",
  source: {
    commit,
    stateSha256: sourceStateSha256,
    dirtyTrackedTree: sourceCleanliness.dirtyTrackedTree,
    dirtySourceTree: sourceCleanliness.dirtySourceTree,
    cleanliness: sourceCleanliness,
    sourceDateEpoch: epoch,
  },
  toolchain: { node: requiredNodeVersion, npm: requiredNpmVersion, platform: process.platform, architecture: process.arch },
  orchestrationCommandSummary: [
    offlineReplay ? "./scripts/bootstrap --offline" : "./scripts/bootstrap",
    "./scripts/check",
    "node scripts/run-npm.mjs --prefix common run build",
    "node scripts/run-npm.mjs --prefix web run build-web",
    "node scripts/run-npm.mjs --prefix web run build-electron-html",
    "node scripts/run-npm.mjs --prefix electron run build",
    "node scripts/safe-clean.mjs release-artifacts electron/out/unsigned",
    "node scripts/run-npm.mjs --prefix electron run pack",
    "node scripts/assert-unsigned-package.mjs electron/out/unsigned release-artifacts/package-assertions.json",
    `node scripts/create-deterministic-tar.mjs ${packageAssertions.packagedContentRoot} ${desktopArchiveCommandPath} release-artifacts/desktop-archive-manifest.json release-artifacts/symlink-manifest.json ${desktopArchiveManifest.archiveRoot}`,
    `node scripts/verify-desktop-archive.mjs ${desktopArchiveCommandPath} ${packageAssertions.packagedContentRoot} release-artifacts/desktop-archive-manifest.json release-artifacts/desktop-archive-assertions.json`,
    `node scripts/create-deterministic-zip.mjs dist/web ${webArchive} web`,
    ...sbomRoots.map(
      (root) =>
        `node scripts/run-npm.mjs --prefix ${root} sbom --package-lock-only --sbom-format cyclonedx --sbom-type application`,
    ),
    "node scripts/generate-release-metadata.mjs release-artifacts",
  ],
  postMetadataVerificationCommand: "node scripts/verify-release-checksums.mjs release-artifacts",
  execution: {
    acquisitionMode: offlineReplay ? "cache-enforced-replay" : "online-acquisition-allowed",
    dirtyEvaluationOverride,
    invocation: buildReleaseInvocation,
  },
  offlineBoundary: recipes.buildEnvironment.offlineBoundary,
  blockers: recipes.releaseBlockers,
  webTreeSha256: await normalizedTreeHash(join(repositoryRoot, "dist", "web")),
  desktopTreeSha256: desktopArchiveAssertions.archiveTreeSha256,
  packageAssertions,
  desktopArchiveAssertions,
  sourceBuiltReplacementArtifactsIncluded: false,
  historicalPrivatePackageArtifactsUsed: false,
};
await writeFile(join(releaseDirectory, "provenance.json"), `${JSON.stringify(stable(provenance), null, 2)}\n`);

const checksumEntries = [];
const walkChecksums = async (root) => {
  for (const name of (await readdir(root)).sort()) {
    if (root === releaseDirectory && name === "SHA256SUMS") continue;
    const path = join(root, name);
    const info = await lstat(path);
    if (info.isDirectory()) await walkChecksums(path);
    else if (info.isFile()) checksumEntries.push({ path, hash: await sha256File(path) });
    else throw new Error(`release-artifacts contains unsupported non-regular entry: ${path}`);
  }
};
await walkChecksums(releaseDirectory);
checksumEntries.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(
  join(releaseDirectory, "SHA256SUMS"),
  checksumEntries.map(({ path, hash }) => `${hash}  ${relative(releaseDirectory, path).split(sep).join("/")}\n`).join(""),
);

console.log(
  `release metadata generated with ${checksumEntries.length} regular-file checksums and ${symlinkManifest.entries.length} archived symlink bindings; releaseEligible=false`,
);
