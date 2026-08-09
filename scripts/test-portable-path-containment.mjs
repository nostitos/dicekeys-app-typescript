#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import {
  cacheRoot,
  extractRepositoryTar,
  initializeBuildCache,
  portableTarPathArgument,
  relativePathInside,
  repositoryRoot,
} from "./lib/build-contract.mjs";

const repository = "C:\\work\\DiceKeys";
const archive = "C:\\work\\DiceKeys\\release-artifacts\\desktop.tar";
const archiveIdentity = relativePathInside(archive, repository, win32);
if (archiveIdentity !== "release-artifacts/desktop.tar") {
  throw new Error(`Windows in-repository archive identity is not portable: ${archiveIdentity}`);
}
for (const outside of [
  "C:\\work\\DiceKeys-other\\desktop.tar",
  "C:\\work\\outside\\desktop.tar",
  "D:\\work\\DiceKeys\\release-artifacts\\desktop.tar",
  repository,
]) {
  if (relativePathInside(outside, repository, win32) !== null) {
    throw new Error(`Windows path containment accepted an outside/root path: ${outside}`);
  }
}

const windowsArchive = "C:\\work\\DiceKeys\\.cache\\vendor\\archive.tgz";
const windowsDestination = "C:\\work\\DiceKeys\\.cache\\vendor\\extract";
if (
  portableTarPathArgument(windowsArchive, repository, win32) !==
    ".cache/vendor/archive.tgz" ||
  portableTarPathArgument(windowsDestination, repository, win32) !==
    ".cache/vendor/extract"
) {
  throw new Error("Windows tar paths did not serialize to repository-relative forward slashes");
}
for (const unsafe of [
  "archive.tgz",
  repository,
  "C:\\work\\DiceKeys-other\\archive.tgz",
  "D:\\work\\DiceKeys\\archive.tgz",
  "C:\\work\\DiceKeys\\.cache\\vendor\\stage\\..\\archive.tgz",
  "C:\\work\\DiceKeys\\.cache\\vendor\\bad:name.tgz",
  "C:\\work\\DiceKeys\\.cache\\vendor\\line\nbreak.tgz",
]) {
  let rejected = false;
  try {
    portableTarPathArgument(unsafe, repository, win32);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`portable tar path accepted unsafe Windows input: ${unsafe}`);
}

await initializeBuildCache();
const testRoot = await mkdtemp(join(cacheRoot, "test-results", "portable-tar-"));
try {
  const archivePath = join(testRoot, "archive.tgz");
  const destinationDirectory = join(testRoot, "extract");
  await writeFile(archivePath, "fixture archive bytes\n");
  await mkdir(destinationDirectory);
  const invocations = [];
  const runFunction = (command, args, options) => {
    invocations.push({ command, args, options });
  };
  await extractRepositoryTar(
    {
      archivePath,
      destinationDirectory,
      mode: "gzip",
      stripComponents: 1,
    },
    { runFunction },
  );
  await extractRepositoryTar(
    {
      archivePath,
      destinationDirectory,
      mode: "preserve-permissions",
    },
    { runFunction },
  );
  const expectedFlags = ["-xzf", "-xpf"];
  for (const [index, invocation] of invocations.entries()) {
    if (invocation.command !== "tar" || invocation.options.cwd !== repositoryRoot) {
      throw new Error("portable tar wrapper did not use tar from the controlled repository cwd");
    }
    if (invocation.args[0] !== expectedFlags[index] || invocation.args[2] !== "-C") {
      throw new Error("portable tar wrapper changed the audited extraction flags");
    }
    for (const pathArgument of [invocation.args[1], invocation.args[3]]) {
      if (
        pathArgument.startsWith("/") ||
        pathArgument.includes("\\") ||
        pathArgument.includes(":") ||
        pathArgument.split("/").some((component) => !component || component === "..")
      ) {
        throw new Error(`portable tar wrapper emitted an unsafe path argument: ${pathArgument}`);
      }
    }
  }
  if (
    invocations[0].args.at(-1) !== "--strip-components=1" ||
    invocations[1].args.length !== 4
  ) {
    throw new Error("portable tar wrapper did not preserve strip-components behavior exactly");
  }

  const nonEmptyDestination = join(testRoot, "nonempty");
  await mkdir(nonEmptyDestination);
  await writeFile(join(nonEmptyDestination, "sentinel"), "must remain untouched\n");
  let nonEmptyRejected = false;
  try {
    await extractRepositoryTar(
      { archivePath, destinationDirectory: nonEmptyDestination, mode: "gzip" },
      { runFunction },
    );
  } catch {
    nonEmptyRejected = true;
  }
  if (!nonEmptyRejected || invocations.length !== 2) {
    throw new Error("portable tar wrapper reached tar with a nonempty destination");
  }
} finally {
  await rm(testRoot, { recursive: true, force: true });
}

console.log("portable path and tar invocation containment reject Windows drive and path escapes");
