#!/usr/bin/env node
import {
  authoritativeBuildPathEnvironment,
  cacheRoot,
  canonicalizeAuthoritativeBuildPathEnvironment,
  emptyGlobalNpmrc,
  emptyUserNpmrc,
  isAllowedBuildEnvironmentKey,
  isAuthoritativeNpmEnvironmentKey,
  isHostileBuildEnvironmentKey,
  isSensitiveEnvironmentKey,
  isCanonicalRuntimeEnvironmentEntry,
  isExpectedBuildPath,
  isWindowsRuntimeEnvironmentKey,
  runNpm,
} from "./lib/build-contract.mjs";
import { join } from "node:path";

// Git Bash cannot unset the parenthesized CommonProgramFiles name, and MSYS
// recreates MSYSTEM when it starts a native Node process. Accept only the
// pinned runner values at this boundary, then remove them before any child run.
for (const [key, value] of Object.entries(process.env).filter(([name]) =>
  isWindowsRuntimeEnvironmentKey(name),
)) {
  if (!isCanonicalRuntimeEnvironmentEntry(key, value)) {
    throw new Error(`noncanonical Windows runtime-created environment survived: ${key}`);
  }
  delete process.env[key];
}
const survivingWindowsRuntimeKeys = Object.keys(process.env).filter((key) =>
  isWindowsRuntimeEnvironmentKey(key),
);
if (survivingWindowsRuntimeKeys.length) {
  throw new Error(
    `could not remove Windows runtime-created environment: ${survivingWindowsRuntimeKeys.join(", ")}`,
  );
}

const unexpectedEnvironmentKeys = Object.keys(process.env)
  .filter((key) => !isAllowedBuildEnvironmentKey(key))
  .sort();
if (unexpectedEnvironmentKeys.length) {
  throw new Error(
    `non-allowlisted environment survived sanitization: ${unexpectedEnvironmentKeys.join(", ")}`,
  );
}
for (const [key, value] of Object.entries(process.env)) {
  if (key.toUpperCase() === "UV_USE_IO_URING" && !isCanonicalRuntimeEnvironmentEntry(key, value)) {
    throw new Error(`noncanonical runtime-created environment survived: ${key}=${value}`);
  }
}

const surviving = Object.keys(process.env)
  .filter(
    (key) =>
      isSensitiveEnvironmentKey(key) &&
      !(key.toUpperCase() === "CSC_IDENTITY_AUTO_DISCOVERY" && process.env[key] === "false"),
  )
  .concat(
    Object.keys(process.env).filter(
      (key) =>
        isHostileBuildEnvironmentKey(key) &&
        !(key === "npm_config_ignore_scripts" && process.env[key] === "false"),
    ),
  )
  .sort();
if (surviving.length) {
  throw new Error(`credential or signing environment survived sanitization: ${surviving.join(", ")}`);
}
canonicalizeAuthoritativeBuildPathEnvironment(process.env);
if (process.env.CSC_IDENTITY_AUTO_DISCOVERY !== "false") {
  throw new Error("CSC_IDENTITY_AUTO_DISCOVERY must be forced to false");
}
if (
  process.env.npm_config_ignore_scripts !== "false" ||
  process.env.CI !== "true" ||
  process.env.NO_UPDATE_NOTIFIER !== "1"
) {
  throw new Error("lifecycle/update controls were not forced to the audited values");
}

const expectedEnvironment = {
  npm_config_userconfig: emptyUserNpmrc,
  npm_config_globalconfig: emptyGlobalNpmrc,
  npm_config_registry: "https://registry.npmjs.org/",
  npm_config_cache: join(cacheRoot, "npm"),
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  npm_config_ignore_scripts: "false",
  ...(process.env.DICEKEYS_BUILD_OFFLINE === "true" ? { npm_config_offline: "true" } : {}),
};
if (!/^(?:true|false)$/.test(process.env.DICEKEYS_BUILD_OFFLINE ?? "")) {
  throw new Error("DICEKEYS_BUILD_OFFLINE must authoritatively describe the npm mode");
}
for (const key of Object.keys(process.env).filter((name) => /^NPM_CONFIG_/i.test(name))) {
  if (!(key in expectedEnvironment) || process.env[key] !== expectedEnvironment[key]) {
    throw new Error(`conflicting authoritative npm environment survived: ${key}`);
  }
}
for (const [key, expected] of Object.entries(expectedEnvironment)) {
  if (process.env[key] !== expected) {
    throw new Error(`authoritative npm environment differs: ${key}=${process.env[key] ?? "missing"}`);
  }
}
const npmConfiguration = JSON.parse(
  runNpm(["config", "list", "--json"], { capture: true, env: process.env }),
);
const expectedNpmConfiguration = {
  userconfig: emptyUserNpmrc,
  globalconfig: emptyGlobalNpmrc,
  registry: "https://registry.npmjs.org/",
  cache: join(cacheRoot, "npm"),
  audit: false,
  fund: false,
  "update-notifier": false,
  "ignore-scripts": false,
  offline: process.env.DICEKEYS_BUILD_OFFLINE === "true",
};
const npmPathConfiguration = {
  userconfig: authoritativeBuildPathEnvironment.npm_config_userconfig,
  globalconfig: authoritativeBuildPathEnvironment.npm_config_globalconfig,
  cache: authoritativeBuildPathEnvironment.npm_config_cache,
};
for (const [key, expected] of Object.entries(expectedNpmConfiguration)) {
  const matches =
    key in npmPathConfiguration
      ? isExpectedBuildPath(npmConfiguration[key], npmPathConfiguration[key])
      : npmConfiguration[key] === expected;
  if (!matches) {
    throw new Error(
      `npm config precedence differs for ${key}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(npmConfiguration[key])}`,
    );
  }
}

console.log("credential and signing environment sanitized");
