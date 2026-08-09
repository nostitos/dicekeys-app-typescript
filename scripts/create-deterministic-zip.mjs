#!/usr/bin/env node
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const [sourceArgument, outputArgument, prefixArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument) {
  throw new Error("usage: create-deterministic-zip.mjs <source-directory> <output.zip> [archive-prefix]");
}
const source = resolve(sourceArgument);
const output = resolve(outputArgument);
const prefix = (prefixArgument ?? basename(source)).replace(/\/+$/, "");
const epoch = Number(process.env.SOURCE_DATE_EPOCH);
if (!Number.isInteger(epoch)) throw new Error("SOURCE_DATE_EPOCH must be set to integer seconds");

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const u16 = (value) => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value & 0xffff);
  return bytes;
};
const u32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
};

const boundedDate = new Date(Math.max(epoch * 1000, Date.UTC(1980, 0, 1)));
const dosTime = (boundedDate.getUTCHours() << 11) | (boundedDate.getUTCMinutes() << 5) | (boundedDate.getUTCSeconds() >> 1);
const dosDate = ((boundedDate.getUTCFullYear() - 1980) << 9) | ((boundedDate.getUTCMonth() + 1) << 5) | boundedDate.getUTCDate();

const files = [];
const walk = async (directory) => {
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isDirectory()) await walk(path);
    else if (info.isFile()) files.push({ path });
    else throw new Error(`deterministic web archive does not accept non-file entry: ${path}`);
  }
};
await walk(source);

const localParts = [];
const centralParts = [];
let offset = 0;
for (const file of files) {
  const name = `${prefix}/${relative(source, file.path).split(sep).join("/")}`;
  const nameBytes = Buffer.from(name, "utf8");
  const data = await readFile(file.path);
  const checksum = crc32(data);
  const normalizedRegularFileMode = 0o100644;
  const local = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate),
    u32(checksum), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes,
  ]);
  localParts.push(local, data);
  centralParts.push(Buffer.concat([
    u32(0x02014b50), u16(0x0314), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate),
    u32(checksum), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0),
    u16(0), u16(0), u32((normalizedRegularFileMode & 0xffff) << 16), u32(offset), nameBytes,
  ]));
  offset += local.length + data.length;
}
const central = Buffer.concat(centralParts);
const end = Buffer.concat([
  u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
  u32(central.length), u32(offset), u16(0),
]);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, Buffer.concat([...localParts, central, end]), { mode: 0o644 });
console.log(`wrote deterministic ZIP with ${files.length} files: ${output}`);
