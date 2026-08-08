#!/usr/bin/env node
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { repositoryRoot } from "./lib/build-contract.mjs";

const attributes = await readFile(join(repositoryRoot, ".gitattributes"), "utf8");
for (const rule of ["* text=auto eol=lf", "*.bat text eol=crlf", "*.cmd text eol=crlf"]) {
  if (!attributes.split(/\r?\n/).includes(rule)) {
    throw new Error(`.gitattributes lacks required cross-platform EOL rule: ${rule}`);
  }
}

const files = [];
const walk = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) files.push(path);
  }
};
await walk(join(repositoryRoot, "scripts"));
for (const path of files) {
  const bytes = await readFile(path);
  if (bytes.includes(0x0d)) throw new Error(`script contains a CR byte despite LF policy: ${path}`);
}

for (const name of ["bootstrap", "check", "build-release", "lint-diagnostic"]) {
  const path = join(repositoryRoot, "scripts", name);
  const bytes = await readFile(path, "utf8");
  if (!bytes.startsWith("#!/usr/bin/env bash\n")) {
    throw new Error(`public Bash entrypoint has a non-LF shebang: ${path}`);
  }
  if (process.platform !== "win32" && ((await lstat(path)).mode & 0o111) === 0) {
    throw new Error(`public Bash entrypoint is not executable: ${path}`);
  }
}

console.log("Git attributes and script bytes preserve LF shebangs across Windows checkouts");
