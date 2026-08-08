#!/usr/bin/env node
import { createRequire } from "node:module";
import { join } from "node:path";
import { repositoryRoot } from "./lib/build-contract.mjs";
import {
  isForbiddenPackagedPath,
  requiredUnsignedExclusions,
} from "./lib/unsigned-package-policy.mjs";

for (const name of [
  ".npmrc",
  "electron-builder.env",
  "nested/.env.production",
  "signing/id.pem",
  "signing/key.p8",
  "signing/private.key",
  "signing/cert.crt",
  "signing/cert.cer",
  "signing/cert.p12",
  "signing/cert.pfx",
  "signing/app.mobileprovision",
  "signing/app.provisionprofile",
]) {
  if (!isForbiddenPackagedPath(name)) throw new Error(`unsigned package policy permits ${name}`);
}

process.env.CSC_LINK = "sentinel";
process.env.NPM_TOKEN = "sentinel";
process.env.ELECTRON_MIRROR = "https://invalid.example/";
process.env.NPM_CONFIG_OFFLINE = "true";
process.env.NPM_CONFIG_SCRIPT_SHELL = "/tmp/hostile-shell";
process.env.DICEKEYS_BUILD_OFFLINE = "true";
const require = createRequire(import.meta.url);
const config = require(join(repositoryRoot, "electron", "electron-builder.unsigned.js"));
for (const exclusion of requiredUnsignedExclusions) {
  if (!config.files.includes(exclusion)) throw new Error(`unsigned builder config lacks ${exclusion}`);
}
if (
  process.env.CSC_LINK ||
  process.env.NPM_TOKEN ||
  process.env.ELECTRON_MIRROR ||
  process.env.NPM_CONFIG_OFFLINE ||
  process.env.NPM_CONFIG_SCRIPT_SHELL ||
  process.env.npm_config_offline !== "true" ||
  process.env.CSC_IDENTITY_AUTO_DISCOVERY !== "false"
) {
  throw new Error("unsigned builder config did not scrub dotenv/signing override sentinels");
}
if (
  config.npmRebuild !== false ||
  config.nodeGypRebuild !== false ||
  config.buildDependenciesFromSource !== false
) {
  throw new Error("unsigned builder config must reuse the freshly bootstrapped, verified host native binding");
}

console.log("unsigned config and package scanner reject credential, package-manager, and signing files");
