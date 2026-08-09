#!/usr/bin/env node
import { runGit } from "./lib/build-contract.mjs";

const args = process.argv.slice(2);
if (!args.length) throw new Error("git-command requires a Git subcommand");
const output = runGit(args);
if (output) process.stdout.write(`${output}\n`);
