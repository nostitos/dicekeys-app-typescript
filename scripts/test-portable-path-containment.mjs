#!/usr/bin/env node
import { win32 } from "node:path";
import { relativePathInside } from "./lib/build-contract.mjs";

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

console.log("portable path containment binds Windows archive identities and rejects escapes");
