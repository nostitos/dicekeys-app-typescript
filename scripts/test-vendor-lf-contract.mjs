#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readJson, recipesPath, repositoryRoot } from "./lib/build-contract.mjs";

const recipes = (await readJson(recipesPath)).packages;
if (recipes.length !== 4 || recipes.some((recipe) => recipe.typescriptNewLine !== "lf")) {
  throw new Error("every vendor source recipe must explicitly bind TypeScript output to LF");
}
const builder = await readFile(join(repositoryRoot, "scripts", "build-vendor-packages.mjs"), "utf8");
if (!builder.includes('[compiler, "-p", config, "--newLine", recipe.typescriptNewLine]')) {
  throw new Error("vendor compiler invocation does not explicitly pass the recipe LF setting");
}

console.log("all vendor TypeScript compiler invocations are explicitly bound to LF output");
