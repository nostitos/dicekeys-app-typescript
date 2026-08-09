#!/usr/bin/env node
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { repositoryRoot, run } from "./lib/build-contract.mjs";
import { isForbiddenPackagedPath } from "./lib/unsigned-package-policy.mjs";
import {
  assertExpectedMacMainExecutable,
  classifyMacCodeSigningResult,
  inspectUnsignedAuthenticode,
} from "./lib/unsigned-signing-proof.mjs";

const packageRoot = resolve(process.argv[2] ?? join(repositoryRoot, "electron", "out", "unsigned"));
const resultPath = resolve(process.argv[3] ?? join(repositoryRoot, "release-artifacts", "package-assertions.json"));
if (!existsSync(packageRoot)) throw new Error(`unsigned package root does not exist: ${packageRoot}`);

const files = [];
const asarFiles = [];
const walk = async (directory) => {
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isDirectory()) await walk(path);
    else if (info.isFile() || info.isSymbolicLink()) files.push(path);
  }
};
await walk(packageRoot);
const packagedDirectories = (await readdir(packageRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (packagedDirectories.length !== 1) {
  throw new Error(
    `unsigned package root must contain exactly one host package directory; found ${packagedDirectories.join(", ")}`,
  );
}
const packagedContentRoot = join(packageRoot, packagedDirectories[0]);
for (const path of files) {
  const normalized = relative(packageRoot, path).split(sep).join("/");
  if (isForbiddenPackagedPath(normalized)) throw new Error(`forbidden signing/config material in package: ${normalized}`);
  if (basename(path) === "app.asar") {
    const asarCli = join(repositoryRoot, "electron", "node_modules", "@electron", "asar", "bin", "asar.js");
    const listing = run(process.execPath, [asarCli, "list", path], { capture: true });
    for (const entry of listing.split("\n").map((value) => value.replace(/^\//, "")).filter(Boolean)) {
      asarFiles.push(entry);
      if (isForbiddenPackagedPath(entry)) throw new Error(`forbidden signing/config material in app.asar: ${entry}`);
    }
  }
}

let publisherSigningEvidence = { platform: process.platform, status: "not-applicable" };
if (process.platform === "darwin") {
  const applicationBundles = (await readdir(packagedContentRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => join(packagedContentRoot, entry.name));
  if (applicationBundles.length !== 1) {
    throw new Error(
      `macOS package must contain exactly one top-level application bundle; found ${applicationBundles.length}`,
    );
  }
  const mainExecutableDirectory = join(applicationBundles[0], "Contents", "MacOS");
  const mainExecutables = (await readdir(mainExecutableDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(mainExecutableDirectory, entry.name));
  if (mainExecutables.length !== 1) {
    throw new Error(
      `macOS application bundle must contain exactly one main executable; found ${mainExecutables.length}`,
    );
  }
  const expectedMainExecutable = relative(packagedContentRoot, mainExecutables[0])
    .split(sep)
    .join("/");
  const codeObjects = [];
  for (const path of files) {
    const info = await lstat(path);
    if (!info.isFile()) continue;
    const identified = spawnSync("file", ["-b", path], { encoding: "utf8" });
    if (identified.error || identified.status !== 0) {
      throw new Error(
        `file inspection failed for ${path}: ${identified.error?.message ?? ""}\n${identified.stdout ?? ""}${identified.stderr ?? ""}`,
      );
    }
    if (!/Mach-O/.test(identified.stdout ?? "")) continue;
    const completed = spawnSync("codesign", ["-d", "--verbose=4", path], { encoding: "utf8" });
    const relativePath = relative(packagedContentRoot, path).split(sep).join("/");
    let signing;
    try {
      signing = classifyMacCodeSigningResult(completed);
    } catch (error) {
      throw new Error(`macOS code-signing proof failed for ${relativePath}: ${error.message}`);
    }
    codeObjects.push({
      path: relativePath,
      codesignDisplayStatus: completed.status,
      ...signing,
    });
  }
  if (!codeObjects.length) throw new Error("macOS unsigned package has no Mach-O code objects");
  assertExpectedMacMainExecutable(codeObjects, expectedMainExecutable);
  publisherSigningEvidence = {
    platform: "darwin",
    status: "every detected Mach-O has a recognized ad-hoc or unsigned outcome and no publisher identity",
    expectedMainExecutable,
    executableCodeObjectCount: codeObjects.length,
    codeObjects,
  };
} else if (process.platform === "win32") {
  const topLevelExecutables = (await readdir(packagedContentRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"))
    .map((entry) => join(packagedContentRoot, entry.name));
  if (topLevelExecutables.length !== 1) {
    throw new Error(
      `Windows unsigned package must contain exactly one top-level application executable; found ${topLevelExecutables.length}`,
    );
  }
  const applicationExecutable = topLevelExecutables[0];
  const authenticode = inspectUnsignedAuthenticode({
    applicationExecutable,
    packagedContentRoot,
  });
  publisherSigningEvidence = {
    platform: "win32",
    status: "top-level application executable is not Authenticode signed",
    applicationExecutable: basename(applicationExecutable),
    authenticode,
    nestedThirdPartyBinariesInspected: false,
  };
}

const assertion = {
  schemaVersion: 1,
  passed: true,
  artifactClass: "local unsigned evaluation output",
  packagedContentRoot: relative(repositoryRoot, packagedContentRoot).split(sep).join("/"),
  fileCount: files.length,
  asarEntryCount: asarFiles.length,
  forbiddenMaterialAbsent: true,
  applicationPublisherSigningApplied: false,
  publisherSigningEvidence,
  provisioningProfileAbsent: true,
  notarizationAttempted: false,
  releaseEligible: false,
};
await mkdir(resolve(resultPath, ".."), { recursive: true });
await writeFile(resultPath, `${JSON.stringify(assertion, null, 2)}\n`);
console.log("unsigned package assertions passed: no credentials, profile, signing config, or Developer ID team");
