#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? "reference");
if (!existsSync(root)) throw new Error(`Python source root does not exist: ${root}`);

const found = [];
const walk = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.name === "__pycache__" || /\.(?:pyc|pyo)$/i.test(entry.name)) found.push(path);
    if (entry.isDirectory()) await walk(path);
  }
};
await walk(root);
if (found.length) {
  throw new Error(`Python test run created forbidden bytecode artifacts: ${found.join(", ")}`);
}
console.log("Python reference tree contains no bytecode artifacts");
