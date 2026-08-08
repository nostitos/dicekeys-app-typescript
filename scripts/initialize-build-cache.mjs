#!/usr/bin/env node
import { initializeBuildCache } from "./lib/build-contract.mjs";

if (process.argv.length > 2) throw new Error("initialize-build-cache takes no arguments");
await initializeBuildCache();
