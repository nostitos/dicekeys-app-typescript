#!/usr/bin/env node
if (process.platform !== "win32") process.umask(0o022);
import { existsSync } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
  assertPathInside,
  assertNoSymlinkPath,
  buildToolsDirectory,
  commandEnvironment,
  normalizedTreeHash,
  packageTreeHash,
  isUniqueRegularFile,
  publishVerifiedBytes,
  publishVerifiedFile,
  readJson,
  recipesPath,
  repositoryRoot,
  requireToolchain,
  run,
  runNpm,
  sha256File,
  sha512FileIntegrity,
  vendorArtifactsDirectory,
  vendorCacheRoot,
  vendorDownloadsDirectory,
  verifyPackageArtifact,
} from "./lib/build-contract.mjs";

const argumentsSet = new Set(process.argv.slice(2));
const offline = argumentsSet.delete("--offline");
const discover = argumentsSet.delete("--discover");
const rebuild = argumentsSet.delete("--rebuild");
if (argumentsSet.size) throw new Error(`unknown arguments: ${[...argumentsSet].join(" ")}`);

requireToolchain();
const document = await readJson(recipesPath);
const recipes = document.packages;
const env = await commandEnvironment({ offline });

await assertNoSymlinkPath(vendorCacheRoot);
await mkdir(vendorDownloadsDirectory, { recursive: true });
await mkdir(vendorArtifactsDirectory, { recursive: true });

const downloadSource = async (recipe) => {
  const archivePath = join(vendorDownloadsDirectory, `${recipe.id}-${recipe.commit}.tar.gz`);
  const sourceMatches = async () =>
    (await isUniqueRegularFile(archivePath)) &&
    (await sha256File(archivePath)) === recipe.sourceArchive.sha256;
  if (!(await sourceMatches())) {
    if (offline) {
      throw new Error(`offline acquisition cache is missing or unsafe: ${basename(archivePath)}`);
    }
    const response = await fetch(recipe.sourceArchive.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`source download failed (${response.status}): ${recipe.sourceArchive.url}`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    const maximumSourceBytes = 25 * 1024 * 1024;
    if (declaredLength > maximumSourceBytes) {
      throw new Error(`source archive exceeds 25 MiB limit: ${recipe.sourceArchive.url}`);
    }
    const downloaded = Buffer.from(await response.arrayBuffer());
    if (downloaded.byteLength > maximumSourceBytes) {
      throw new Error(`source archive exceeds 25 MiB limit: ${recipe.sourceArchive.url}`);
    }
    await publishVerifiedBytes(
      downloaded,
      archivePath,
      async (path) => (await sha256File(path)) === recipe.sourceArchive.sha256,
    );
  }
  const actual = await sha256File(archivePath);
  if (actual !== recipe.sourceArchive.sha256) {
    throw new Error(`source archive hash mismatch for ${recipe.id}: expected ${recipe.sourceArchive.sha256}, found ${actual}`);
  }
  return archivePath;
};

const sourceArchives = new Map();
for (const recipe of recipes) sourceArchives.set(recipe.id, await downloadSource(recipe));

runNpm(["ci", "--ignore-scripts", ...(offline ? ["--offline"] : [])], {
  cwd: buildToolsDirectory,
  env,
});

const artifactMatchesRecipe = async (recipe, artifactPath) => {
  if (!(await isUniqueRegularFile(artifactPath))) return false;
  return (await verifyPackageArtifact(artifactPath, recipe.artifact)).matches;
};

if (!rebuild && !discover) {
  let allPresent = true;
  for (const recipe of recipes) {
    const path = join(vendorArtifactsDirectory, recipe.artifact.filename);
    if (!(await artifactMatchesRecipe(recipe, path))) allPresent = false;
  }
  if (allPresent) {
    console.log("verified four pinned source-built replacement packages");
    process.exit(0);
  }
  if (offline) throw new Error("offline vendor cache is missing or invalid; acquire it once with ./scripts/bootstrap");
}

if (offline) throw new Error("offline mode cannot regenerate source-built packages");

const workRoot = await mkdtemp(join(vendorCacheRoot, "work-"));
assertPathInside(workRoot, vendorCacheRoot);

const stageRecipe = async (recipe, runRoot) => {
  const sourceRoot = join(runRoot, recipe.id);
  await mkdir(sourceRoot, { recursive: true });
  run("tar", ["-xzf", sourceArchives.get(recipe.id), "-C", sourceRoot, "--strip-components=1"]);
  await rm(join(sourceRoot, ".npmrc"), { force: true });

  const packagePath = join(sourceRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  delete packageJson.publishConfig;
  if (packageJson.scripts) delete packageJson.scripts.prepare;
  if (recipe.id === "api" || recipe.id === "seeded") packageJson.license = "MIT";
  if (recipe.id === "seeded" || recipe.id === "read") {
    packageJson.dependencies["@dicekeys/webasm-module-memory-helper"] = "1.0.6";
  }
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  if (recipe.id === "seeded" || recipe.id === "read") {
    await writeFile(
      join(sourceRoot, "tsconfig.vendor.json"),
      `${JSON.stringify({ extends: "./tsconfig.json", include: ["src/**/*"], exclude: ["src/tests/**/*"] }, null, 2)}\n`,
    );
  }

  // This assertion and hash intentionally run after every tracked staging transform
  // and before node_modules or generated dist files exist. Do not move this block.
  const stagedPackage = JSON.parse(await readFile(packagePath, "utf8"));
  if (stagedPackage.publishConfig || stagedPackage.scripts?.prepare) {
    throw new Error(`${recipe.id} staging transform left registry or prepare metadata behind`);
  }
  if (
    (recipe.id === "seeded" || recipe.id === "read") &&
    stagedPackage.dependencies?.["@dicekeys/webasm-module-memory-helper"] !== "1.0.6"
  ) {
    throw new Error(`${recipe.id} staging transform did not pin helper 1.0.6`);
  }
  if (
    (recipe.id === "seeded" || recipe.id === "read") &&
    !existsSync(join(sourceRoot, "tsconfig.vendor.json"))
  ) {
    throw new Error(`${recipe.id} staging transform did not write tsconfig.vendor.json`);
  }
  if (recipe.typescriptNewLine !== "lf") {
    throw new Error(`${recipe.id} vendor recipe must bind TypeScript output to LF`);
  }
  const stagedSourceTreeSha256 = await normalizedTreeHash(sourceRoot);
  if (!discover && recipe.stagedSourceTreeSha256 !== stagedSourceTreeSha256) {
    throw new Error(
      `${recipe.id} staged source tree mismatch: expected ${recipe.stagedSourceTreeSha256}, found ${stagedSourceTreeSha256}`,
    );
  }

  const nodeModules = join(sourceRoot, "node_modules");
  const typesDirectory = join(nodeModules, "@types");
  await mkdir(typesDirectory, { recursive: true });
  await cp(join(buildToolsDirectory, "node_modules", recipe.nodeTypes), join(typesDirectory, "node"), {
    recursive: true,
  });
  if (recipe.emscriptenTypes) {
    await cp(
      join(buildToolsDirectory, "node_modules", recipe.emscriptenTypes),
      join(typesDirectory, "emscripten"),
      { recursive: true },
    );
  }

  if (recipe.id === "seeded" || recipe.id === "read") {
    const helperRecipe = recipes.find((candidate) => candidate.id === "helper");
    const helperArtifact = join(runRoot, "artifacts", helperRecipe.artifact.filename);
    const helperExtract = join(runRoot, `${recipe.id}-helper-extract`);
    await mkdir(helperExtract, { recursive: true });
    run("tar", ["-xzf", helperArtifact, "-C", helperExtract]);
    const helperTarget = join(nodeModules, "@dicekeys", "webasm-module-memory-helper");
    await mkdir(dirname(helperTarget), { recursive: true });
    await cp(join(helperExtract, "package"), helperTarget, { recursive: true });
  }

  const compiler = join(buildToolsDirectory, "node_modules", recipe.compiler, "bin", "tsc");
  const config = recipe.id === "seeded" || recipe.id === "read" ? "tsconfig.vendor.json" : "tsconfig.json";
  run(process.execPath, [compiler, "-p", config, "--newLine", recipe.typescriptNewLine], {
    cwd: sourceRoot,
    env,
  });

  if (recipe.copyGeneratedPrefix) {
    const sourceEntries = await import("node:fs/promises").then(({ readdir }) => readdir(join(sourceRoot, "src")));
    await mkdir(join(sourceRoot, "dist"), { recursive: true });
    for (const name of sourceEntries.filter((entry) => entry.startsWith(recipe.copyGeneratedPrefix))) {
      await copyFile(join(sourceRoot, "src", name), join(sourceRoot, "dist", name));
    }
  }

  const artifactsDirectory = join(runRoot, "artifacts");
  await mkdir(artifactsDirectory, { recursive: true });
  runNpm(["pack", "--ignore-scripts", "--pack-destination", artifactsDirectory, "--loglevel=error"], {
    cwd: sourceRoot,
    env: { ...env, npm_config_ignore_scripts: "true" },
  });
  const artifactPath = join(artifactsDirectory, recipe.artifact.filename);
  if (!existsSync(artifactPath)) throw new Error(`npm pack did not create ${artifactPath}`);
  return { artifactPath, stagedSourceTreeSha256 };
};

const buildRun = async (runName) => {
  const runRoot = join(workRoot, runName);
  await mkdir(join(runRoot, "artifacts"), { recursive: true });
  const output = new Map();
  for (const id of ["helper", "api", "seeded", "read"]) {
    const recipe = recipes.find((candidate) => candidate.id === id);
    output.set(id, await stageRecipe(recipe, runRoot));
  }
  return output;
};

const first = await buildRun("run-one");
const second = await buildRun("run-two");
const discovered = {};
for (const recipe of recipes) {
  const firstResult = first.get(recipe.id);
  const secondResult = second.get(recipe.id);
  const firstPath = firstResult.artifactPath;
  const secondPath = secondResult.artifactPath;
  const firstHash = await sha256File(firstPath);
  const secondHash = await sha256File(secondPath);
  const firstTree = await packageTreeHash(firstPath);
  const secondTree = await packageTreeHash(secondPath);
  if (
    firstHash !== secondHash ||
    firstTree !== secondTree ||
    firstResult.stagedSourceTreeSha256 !== secondResult.stagedSourceTreeSha256
  ) {
    throw new Error(`two clean ${recipe.id} source builds were not deterministic`);
  }
  discovered[recipe.id] = {
    stagedSourceTreeSha256: secondResult.stagedSourceTreeSha256,
    sha256: secondHash,
    integrity: await sha512FileIntegrity(secondPath),
    packageTreeSha256: secondTree,
  };
  if (!discover) {
    for (const [field, actual] of Object.entries(discovered[recipe.id])) {
      if (field === "stagedSourceTreeSha256") continue;
      if (recipe.artifact[field] !== actual) {
        throw new Error(`${recipe.id} ${field} mismatch: expected ${recipe.artifact[field]}, found ${actual}`);
      }
    }
  }
  const publicationIdentity = discover
    ? {
        sha256: discovered[recipe.id].sha256,
        integrity: discovered[recipe.id].integrity,
        packageTreeSha256: discovered[recipe.id].packageTreeSha256,
      }
    : recipe.artifact;
  await publishVerifiedFile(
    secondPath,
    join(vendorArtifactsDirectory, recipe.artifact.filename),
    async (path) => (await verifyPackageArtifact(path, publicationIdentity)).matches,
  );
}

if (discover) console.log(JSON.stringify(discovered, null, 2));
else console.log("two clean builds matched for all four source-built replacement packages");

// workRoot was created empty by this process and contains only verified pinned
// source extraction/build outputs. It is not a preexisting user-controlled tree.
await rm(workRoot, { recursive: true, force: false });
