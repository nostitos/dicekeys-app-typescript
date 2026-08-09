#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  commandEnvironment,
  readJson,
  recipesPath,
  repositoryRoot,
  runNpm,
} from "./lib/build-contract.mjs";
import { normalizeLocalSourceBuiltReferences } from "./lib/normalize-sbom.mjs";

const sbomRoots = [".", "common", "web", "electron", "electron-forge", "vendor/build-tools"];
const buildReleaseSource = await readFile(join(repositoryRoot, "scripts", "build-release"), "utf8");
const metadataSource = await readFile(
  join(repositoryRoot, "scripts", "generate-release-metadata.mjs"),
  "utf8",
);

if (!buildReleaseSource.includes(`for root in ${sbomRoots.join(" ")}; do`)) {
  throw new Error("build-release must generate SBOMs for exactly the six committed npm roots");
}
if (
  !metadataSource.includes(
    `const sbomRoots = [${sbomRoots.map((root) => `"${root}"`).join(", ")}];`,
  )
) {
  throw new Error("release provenance must enumerate the same six npm SBOM roots");
}

const releaseSbomCommands = [
  ...buildReleaseSource
    .split(/\r?\n/)
    .filter((line) => /\bnpm_cli\b.*\bsbom\b/.test(line)),
  ...metadataSource
    .split(/\r?\n/)
    .filter((line) => /run-npm\.mjs.*\bsbom\b/.test(line)),
];
if (releaseSbomCommands.length !== 2) {
  throw new Error(`expected two release SBOM command templates; found ${releaseSbomCommands.length}`);
}
for (const command of releaseSbomCommands) {
  if (!/(?:^|\s)--package-lock-only(?:\s|$|`)/.test(command)) {
    throw new Error(`release SBOM command may inspect a mutable installed tree: ${command.trim()}`);
  }
}

const recipes = await readJson(recipesPath);
const environment = await commandEnvironment({ offline: true });
let webSbom;
for (const root of sbomRoots) {
  const raw = runNpm(
    [
      "--prefix",
      root,
      "sbom",
      "--package-lock-only",
      "--sbom-format",
      "cyclonedx",
      "--sbom-type",
      "application",
    ],
    { capture: true, env: environment },
  );
  const sbom = JSON.parse(raw);
  const lock = await readJson(join(repositoryRoot, root, "package-lock.json"));
  normalizeLocalSourceBuiltReferences({
    sbom,
    checkoutRoot: repositoryRoot,
    recipes: recipes.packages,
  });
  if (
    sbom.bomFormat !== "CycloneDX" ||
    sbom.metadata?.component?.name !== lock.name ||
    sbom.metadata?.component?.version !== lock.version
  ) {
    throw new Error(`lock-only SBOM did not preserve the ${root} root lock identity`);
  }
  if (root === "web") webSbom = sbom;
}
const webLock = await readJson(join(repositoryRoot, "web", "package-lock.json"));
for (const recipe of recipes.packages) {
  const component = webSbom.components?.find(
    (candidate) => candidate.name === recipe.name && candidate.version === recipe.version,
  );
  const locked = webLock.packages?.[`node_modules/${recipe.name}`];
  const properties = new Map(
    (component?.properties ?? []).map((property) => [property.name, property.value]),
  );
  const expectedIntegrityHex = Buffer.from(
    String(locked?.integrity ?? "").replace(/^sha512-/, ""),
    "base64",
  ).toString("hex");
  if (
    !component ||
    locked?.version !== recipe.version ||
    !component.externalReferences?.some(
      (reference) => reference.url === `urn:sha256:${recipe.artifact.sha256}`,
    ) ||
    !component.hashes?.some(
      (hash) => hash.alg === "SHA-512" && hash.content === expectedIntegrityHex,
    ) ||
    properties.get("dicekeys:source-commit") !== recipe.commit ||
    properties.get("dicekeys:artifact-sha256") !== recipe.artifact.sha256 ||
    properties.get("dicekeys:package-tree-sha256") !== recipe.artifact.packageTreeSha256
  ) {
    throw new Error(`lock-only SBOM lost audited source-built identity for ${recipe.name}`);
  }
}

console.log("release SBOMs use committed locks and preserve audited vendor artifact identities");
