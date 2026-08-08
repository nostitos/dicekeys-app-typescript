#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  cacheRoot,
  commandEnvironment,
  emptyGlobalNpmrc,
  emptyUserNpmrc,
  isAllowedBuildEnvironmentKey,
  isCanonicalRuntimeEnvironmentEntry,
  isHostileBuildEnvironmentKey,
  isSensitiveEnvironmentKey,
  repositoryRoot,
} from "./lib/build-contract.mjs";

const sentinels = {
  NPM_CONFIG_TOKEN: "must-not-survive",
  ACTIONS_RUNTIME_TOKEN: "must-not-survive",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "must-not-survive",
  npm_config_password: "must-not-survive",
  npm_config_username: "must-not-survive",
  npm_config_cert: "must-not-survive",
  npm_config_key: "must-not-survive",
  CSC_LINK: "must-not-survive",
  CSC_KEY_PASSWORD: "must-not-survive",
  WIN_CSC_LINK: "must-not-survive",
  WIN_CSC_KEY_PASSWORD: "must-not-survive",
  APPLE_ID: "must-not-survive",
  APPLE_APP_SPECIFIC_PASSWORD: "must-not-survive",
  AC_PASSWORD: "must-not-survive",
  WINDOWS_CERTIFICATE_FILE: "must-not-survive",
  SIGNTOOL_PATH: "must-not-survive",
  ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
  ELECTRON_OVERRIDE_DIST_PATH: "/tmp/hostile-electron",
  force_no_cache: "true",
  electron_use_remote_checksums: "true",
  npm_config_electron_mirror: "https://invalid.example/",
  npm_config_electron_custom_filename: "hostile.zip",
  npm_config_platform: "win32",
  npm_config_arch: "x64",
  npm_config_ignore_scripts: "true",
  npm_execpath: "/tmp/hostile/npm-cli.js",
  NPM_CONFIG_USERCONFIG: "/tmp/hostile-user-npmrc",
  nPm_CoNfIg_GlObAlCoNfIg: "/tmp/hostile-global-npmrc",
  NPM_CONFIG_REGISTRY: "https://private.invalid/",
  NPM_CONFIG_CACHE: "/tmp/hostile-npm-cache",
  NPM_CONFIG_AUDIT: "true",
  NPM_CONFIG_FUND: "true",
  NPM_CONFIG_UPDATE_NOTIFIER: "true",
  NPM_CONFIG_OFFLINE: "true",
  npm_config_target: "20.0.0",
  npm_config_runtime: "electron",
  npm_config_disturl: "https://hostile.invalid/headers",
  npm_config_node_gyp: "/tmp/hostile-node-gyp",
  npm_config_python: "/tmp/hostile-python",
  npm_config_omit: "dev",
  npm_config_optional: "false",
  npm_config_bin_links: "false",
  npm_config_script_shell: "/tmp/hostile-shell",
  npm_config_legacy_peer_deps: "true",
  nPm_CoNfIg_ArBiTrArY_FuTuRe_KnOb: "must-not-survive",
  AWS_SECRET_ACCESS_KEY: "must-not-survive",
  AWS_SESSION_TOKEN: "must-not-survive",
  GOOGLE_APPLICATION_CREDENTIALS: "/tmp/must-not-survive-google.json",
  GITHUB_PAT: "must-not-survive",
  CI_JOB_TOKEN: "must-not-survive",
  SSH_AUTH_SOCK: "/tmp/must-not-survive-agent.sock",
  NODE_OPTIONS: "--require=/tmp/must-not-survive-node-options.js",
  DICEKEYS_SECRET: "must-not-survive",
  UV_USE_IO_URING: "1",
};

for (const [key, value] of Object.entries(sentinels)) process.env[key] = value;
const javascriptEnvironment = await commandEnvironment();
const javascriptSurvivors = Object.keys(javascriptEnvironment).filter(
  (key) =>
    (isSensitiveEnvironmentKey(key) || isHostileBuildEnvironmentKey(key)) &&
    !(key === "CSC_IDENTITY_AUTO_DISCOVERY" && javascriptEnvironment[key] === "false") &&
    !(key === "npm_config_ignore_scripts" && javascriptEnvironment[key] === "false"),
);
if (javascriptSurvivors.length) {
  throw new Error(`JavaScript environment scrub failed: ${javascriptSurvivors.sort().join(", ")}`);
}
if (
  !isCanonicalRuntimeEnvironmentEntry("UV_USE_IO_URING", "0", "linux") ||
  isCanonicalRuntimeEnvironmentEntry("UV_USE_IO_URING", "1", "linux") ||
  isCanonicalRuntimeEnvironmentEntry("UV_USE_IO_URING", "0", "darwin")
) {
  throw new Error("Linux Node runtime environment exception is not exact and fail-closed");
}
const javascriptNonAllowlisted = Object.keys(javascriptEnvironment).filter(
  (key) => !isAllowedBuildEnvironmentKey(key),
);
if (javascriptNonAllowlisted.length) {
  throw new Error(
    `JavaScript environment retained non-allowlisted keys: ${javascriptNonAllowlisted.sort().join(", ")}`,
  );
}
for (const [key, hostileValue] of Object.entries(sentinels)) {
  if (javascriptEnvironment[key] === hostileValue) {
    throw new Error(`JavaScript environment retained hostile sentinel ${key}`);
  }
}
if (javascriptEnvironment.CSC_IDENTITY_AUTO_DISCOVERY !== "false") {
  throw new Error("JavaScript environment did not disable signing discovery");
}
if (
  javascriptEnvironment.npm_config_ignore_scripts !== "false" ||
  javascriptEnvironment.CI !== "true" ||
  javascriptEnvironment.NO_UPDATE_NOTIFIER !== "1"
) {
  throw new Error("JavaScript environment did not force audited lifecycle/update controls");
}
for (const [key, expected] of Object.entries({
  npm_config_userconfig: emptyUserNpmrc,
  npm_config_globalconfig: emptyGlobalNpmrc,
  npm_config_registry: "https://registry.npmjs.org/",
  npm_config_cache: join(cacheRoot, "npm"),
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
})) {
  if (javascriptEnvironment[key] !== expected) {
    throw new Error(`JavaScript environment did not force ${key}=${expected}`);
  }
}
if ("npm_config_offline" in javascriptEnvironment || "NPM_CONFIG_OFFLINE" in javascriptEnvironment) {
  throw new Error("JavaScript online mode retained an inherited npm offline value");
}
const canonicalNpmKeys = new Set([
  "npm_config_userconfig",
  "npm_config_globalconfig",
  "npm_config_registry",
  "npm_config_cache",
  "npm_config_audit",
  "npm_config_fund",
  "npm_config_update_notifier",
  "npm_config_ignore_scripts",
]);
const unexpectedNpmKeys = Object.keys(javascriptEnvironment).filter(
  (key) => /^NPM_CONFIG_/i.test(key) && !canonicalNpmKeys.has(key),
);
if (unexpectedNpmKeys.length) {
  throw new Error(`JavaScript environment retained arbitrary npm config: ${unexpectedNpmKeys.join(", ")}`);
}

const shellTest = spawnSync(
  "bash",
  [
    "-c",
    'source "$1"; configure_build_environment; node "$2"',
    "environment-scrub-test",
    join(repositoryRoot, "scripts", "lib", "build-contract.sh"),
    join(repositoryRoot, "scripts", "verify-sanitized-environment.mjs"),
  ],
  {
    cwd: repositoryRoot,
    env: { ...process.env, ...sentinels },
    encoding: "utf8",
  },
);
if (shellTest.status !== 0) {
  throw new Error(`shell environment scrub failed:\n${shellTest.stdout}${shellTest.stderr}`);
}

console.log("environment scrub regression passed for JavaScript and shell command paths");
