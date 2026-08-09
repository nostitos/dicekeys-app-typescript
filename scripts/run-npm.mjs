#!/usr/bin/env node
import {
  commandEnvironment,
  requireToolchain,
  runNpm,
} from "./lib/build-contract.mjs";

const args = process.argv.slice(2);
if (!args.length) throw new Error("run-npm requires npm CLI arguments");
requireToolchain();
const offline =
  args.includes("--offline") ||
  /^(?:1|true)$/i.test(process.env.npm_config_offline ?? process.env.NPM_CONFIG_OFFLINE ?? "");
const env = await commandEnvironment({ offline });
runNpm(args, { cwd: process.cwd(), env });
