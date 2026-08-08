#!/usr/bin/env node
if (process.platform !== "win32") process.umask(0o022);
import { join } from "node:path";
import {
  commandEnvironment,
  repositoryRoot,
  requireToolchain,
  run,
} from "./lib/build-contract.mjs";

if (process.argv.length > 2) throw new Error("package-unsigned takes no arguments");
requireToolchain();
const offline = /^(?:1|true)$/i.test(
  process.env.npm_config_offline ?? process.env.NPM_CONFIG_OFFLINE ?? "",
);
const env = await commandEnvironment({ offline });
run(process.execPath, [join(repositoryRoot, "scripts", "verify-sanitized-environment.mjs")], {
  env,
});
run(
  process.execPath,
  [join(repositoryRoot, "scripts", "verify-build-contract.mjs"), "--postinstall"],
  { env },
);
run(
  process.execPath,
  [join(repositoryRoot, "scripts", "safe-clean.mjs"), "electron/out/unsigned"],
  { env },
);
run(
  process.execPath,
  [
    join(repositoryRoot, "electron", "node_modules", "electron-builder", "cli.js"),
    "--dir",
    "--publish=never",
    "--config=electron-builder.unsigned.js",
  ],
  { cwd: join(repositoryRoot, "electron"), env },
);
