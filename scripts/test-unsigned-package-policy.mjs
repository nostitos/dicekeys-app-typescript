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

for (const [key, value] of Object.entries({
  CSC_LINK: "sentinel-signing",
  cSc_KeY_pAsSwOrD: "sentinel-signing-password",
  WIN_CSC_LINK: "sentinel-windows-signing",
  NPM_TOKEN: "sentinel-npm-token",
  nPm_ToKeN: "sentinel-mixed-npm-token",
  ELECTRON_MIRROR: "https://invalid.example/",
  eLeCtRoN_Override_Dist_Path: "/tmp/hostile-electron",
  NPM_CONFIG_OFFLINE: "false",
  nPm_CoNfIg_OfFlInE: "false",
  NPM_CONFIG_SCRIPT_SHELL: "/tmp/hostile-shell",
  nPm_CoNfIg_ScRiPt_ShElL: "/tmp/hostile-mixed-shell",
})) {
  process.env[key] = value;
}
process.env.DICEKEYS_BUILD_OFFLINE = "true";
const require = createRequire(import.meta.url);
const config = require(join(repositoryRoot, "electron", "electron-builder.unsigned.js"));
for (const exclusion of requiredUnsignedExclusions) {
  if (!config.files.includes(exclusion)) throw new Error(`unsigned builder config lacks ${exclusion}`);
}
const environmentEntries = Object.entries(process.env);
const expectedNpmEnvironment = {
  npm_config_userconfig: join(repositoryRoot, ".cache", "npmrc-user-empty"),
  npm_config_globalconfig: join(repositoryRoot, ".cache", "npmrc-global-empty"),
  npm_config_registry: "https://registry.npmjs.org/",
  npm_config_cache: join(repositoryRoot, ".cache", "npm"),
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  npm_config_ignore_scripts: "false",
  npm_config_offline: "true",
};
const npmEnvironmentEntries = environmentEntries.filter(([key]) => /^NPM_CONFIG_/i.test(key));
if (npmEnvironmentEntries.length !== Object.keys(expectedNpmEnvironment).length) {
  throw new Error("unsigned builder config did not scrub dotenv/signing override sentinels");
}
for (const [expectedKey, expectedValue] of Object.entries(expectedNpmEnvironment)) {
  const matchingEntries = npmEnvironmentEntries.filter(
    ([key]) => key.toLowerCase() === expectedKey,
  );
  if (
    matchingEntries.length !== 1 ||
    matchingEntries[0][0] !== expectedKey ||
    matchingEntries[0][1] !== expectedValue
  ) {
    throw new Error(`unsigned builder config did not force canonical ${expectedKey}`);
  }
}
const offlineEntries = npmEnvironmentEntries.filter(
  ([key]) => key.toLowerCase() === "npm_config_offline",
);
if (
  offlineEntries.length !== 1 ||
  offlineEntries[0][0] !== "npm_config_offline" ||
  offlineEntries[0][1] !== "true"
) {
  throw new Error("unsigned builder config did not emit exactly one canonical lowercase offline entry");
}
const forbiddenNonNpmEnvironment = environmentEntries.filter(([key, value]) => {
  if (key === "CSC_IDENTITY_AUTO_DISCOVERY" && value === "false") return false;
  return [
    /^(?:NODE_AUTH_TOKEN|NPM_TOKEN|GH_TOKEN|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN)$/i,
    /^(?:ELECTRON_SKIP_BINARY_DOWNLOAD|ELECTRON_OVERRIDE_DIST_PATH|ELECTRON_USE_REMOTE_CHECKSUMS|ELECTRON_MIRROR|ELECTRON_NIGHTLY_MIRROR|ELECTRON_CUSTOM_DIR|ELECTRON_CUSTOM_FILENAME|ELECTRON_CUSTOM_VERSION|FORCE_NO_CACHE)$/i,
    /^(?:CSC_|WIN_CSC_|APPLE_(?:ID|APP|TEAM|API|KEYCHAIN)|AC_(?:USERNAME|PASSWORD|PROVIDER)|SIGNING_|SIGNTOOL_)/i,
    /^(?:MACOS|WINDOWS|WIN)_.*(?:CERT|SIGN|P12|PFX|KEY)/i,
  ].some((pattern) => pattern.test(key));
});
const signingDiscoveryEntries = environmentEntries.filter(
  ([key]) => key.toUpperCase() === "CSC_IDENTITY_AUTO_DISCOVERY",
);
if (
  forbiddenNonNpmEnvironment.length ||
  signingDiscoveryEntries.length !== 1 ||
  signingDiscoveryEntries[0][0] !== "CSC_IDENTITY_AUTO_DISCOVERY" ||
  signingDiscoveryEntries[0][1] !== "false"
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
