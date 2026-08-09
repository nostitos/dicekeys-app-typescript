#!/usr/bin/env node
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeLocalSourceBuiltReferences } from "./lib/normalize-sbom.mjs";
import { readJson, recipesPath } from "./lib/build-contract.mjs";

const recipes = (await readJson(recipesPath)).packages;
const recipe = recipes.find((candidate) => candidate.id === "api");
const makeSbom = (checkoutRoot) => ({
  bomFormat: "CycloneDX",
  metadata: {
    component: {
      "bom-ref": "dicekeys-app-build@1.0.0",
      name: checkoutRoot.split(/[\\/]/).filter(Boolean).at(-1),
      type: "application",
      version: "1.0.0",
    },
  },
  components: [
    {
      "bom-ref": `${recipe.name}@${recipe.version}`,
      name: recipe.name,
      version: recipe.version,
      type: "library",
      externalReferences: [
        {
          type: "distribution",
          url: pathToFileURL(
            join(checkoutRoot, ".cache", "vendor", "artifacts", recipe.artifact.filename),
          ).href,
        },
      ],
    },
  ],
});

const firstRoot = join("/", "private", "tmp", "dicekeys-checkout-one");
const secondRoot = join("/", "private", "tmp", "different", "dicekeys-checkout-two");
const first = normalizeLocalSourceBuiltReferences({
  sbom: makeSbom(firstRoot),
  checkoutRoot: firstRoot,
  recipes,
});
const second = normalizeLocalSourceBuiltReferences({
  sbom: makeSbom(secondRoot),
  checkoutRoot: secondRoot,
  recipes,
});
if (JSON.stringify(first) !== JSON.stringify(second)) {
  throw new Error("SBOM normalization varies by checkout path");
}
if (JSON.stringify(first).includes(firstRoot) || JSON.stringify(second).includes(secondRoot)) {
  throw new Error("SBOM normalization leaked a checkout path");
}

const invalid = makeSbom(firstRoot);
invalid.components[0].externalReferences[0].url = pathToFileURL(
  join(firstRoot, ".cache", "vendor", "artifacts", "wrong.tgz"),
).href;
let rejectedInvalidPath = false;
try {
  normalizeLocalSourceBuiltReferences({ sbom: invalid, checkoutRoot: firstRoot, recipes });
} catch (error) {
  rejectedInvalidPath = /does not map/.test(String(error));
}
if (!rejectedInvalidPath) throw new Error("SBOM normalization accepted an unexpected local artifact");

console.log("SBOM normalization is checkout-independent and rejects unexpected local artifacts");
