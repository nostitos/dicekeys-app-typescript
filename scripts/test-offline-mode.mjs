#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { commandEnvironment, repositoryRoot } from "./lib/build-contract.mjs";

process.env.npm_config_offline = "false";
process.env.NPM_CONFIG_OFFLINE = "false";
const javascriptOffline = await commandEnvironment({ offline: true });
if (
  javascriptOffline.npm_config_offline !== "true" ||
  javascriptOffline.DICEKEYS_BUILD_OFFLINE !== "true" ||
  Object.hasOwn(javascriptOffline, "NPM_CONFIG_OFFLINE")
) {
  throw new Error("JavaScript --offline mode did not override a conflicting inherited environment");
}

process.env.npm_config_offline = "true";
process.env.NPM_CONFIG_OFFLINE = "true";
const javascriptOnline = await commandEnvironment({ offline: false });
if (
  Object.hasOwn(javascriptOnline, "npm_config_offline") ||
  Object.hasOwn(javascriptOnline, "NPM_CONFIG_OFFLINE")
) {
  throw new Error("JavaScript online mode did not clear inherited offline configuration");
}
if (javascriptOnline.DICEKEYS_BUILD_OFFLINE !== "false") {
  throw new Error("JavaScript online mode marker is not authoritative");
}

const shellLibrary = join(repositoryRoot, "scripts", "lib", "build-contract.sh");
const shellCase = (argument, inheritedValue) => {
  const command = argument
    ? 'source "$1"; parse_offline_flag --offline; printf "%s|%s|%s" "$OFFLINE" "${npm_config_offline-unset}" "${NPM_CONFIG_OFFLINE-unset}"'
    : 'source "$1"; parse_offline_flag; printf "%s|%s|%s" "$OFFLINE" "${npm_config_offline-unset}" "${NPM_CONFIG_OFFLINE-unset}"';
  const completed = spawnSync("bash", ["-c", command, "offline-mode-test", shellLibrary], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      npm_config_offline: inheritedValue,
      NPM_CONFIG_OFFLINE: inheritedValue,
    },
    encoding: "utf8",
  });
  if (completed.status !== 0) {
    throw new Error(`shell offline-mode test failed: ${completed.stdout}${completed.stderr}`);
  }
  return completed.stdout;
};

if (shellCase(true, "false") !== "true|true|unset") {
  throw new Error("shell --offline mode did not override uppercase/lowercase false");
}
if (shellCase(false, "true") !== "false|unset|unset") {
  throw new Error("shell online mode did not clear inherited uppercase/lowercase true");
}

console.log("offline/online mode authority regression passed for JavaScript and shell paths");
