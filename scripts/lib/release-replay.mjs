import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalAcquisitionText = (value) =>
  String(value)
    .replaceAll(" --offline", "")
    .replaceAll("-cache-replay-", "-{acquisition}-")
    .replaceAll("-online-", "-{acquisition}-");

const normalizedProvenance = (provenance) => {
  const normalized = structuredClone(provenance);
  normalized.execution.acquisitionMode = "<acquisition-mode>";
  normalized.execution.invocation = canonicalAcquisitionText(normalized.execution.invocation);
  normalized.orchestrationCommandSummary = normalized.orchestrationCommandSummary.map(
    canonicalAcquisitionText,
  );
  return stable(normalized);
};

export const createReleaseReplayIdentity = async (releaseDirectory) => {
  const root = resolve(releaseDirectory);
  const provenance = JSON.parse(await readFile(join(root, "provenance.json"), "utf8"));
  const acquisitionMode = provenance.execution?.acquisitionMode;
  if (![
    "online-acquisition-allowed",
    "cache-enforced-replay",
  ].includes(acquisitionMode)) {
    throw new Error(`unsupported release acquisition mode: ${acquisitionMode}`);
  }
  const checksumLines = (await readFile(join(root, "SHA256SUMS"), "utf8"))
    .split("\n")
    .filter(Boolean);
  const files = [];
  const seen = new Set();
  for (const line of checksumLines) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!match) throw new Error(`invalid release checksum line: ${line}`);
    let [, hash, path] = match;
    if (path === "provenance.json") {
      hash = sha256(`${JSON.stringify(normalizedProvenance(provenance))}\n`);
    }
    path = canonicalAcquisitionText(path);
    if (seen.has(path)) throw new Error(`normalized release identity repeats path: ${path}`);
    seen.add(path);
    files.push({ path, sha256: hash });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return stable({
    schemaVersion: 1,
    acquisitionMode,
    sourceCommit: provenance.source?.commit,
    sourceStateSha256: provenance.source?.stateSha256,
    releaseEligible: provenance.releaseEligible,
    checksumEntryCount: checksumLines.length,
    normalizedProvenanceSha256: sha256(`${JSON.stringify(normalizedProvenance(provenance))}\n`),
    files,
  });
};

export const assertReleaseReplayIdentity = (online, replay) => {
  if (
    online.acquisitionMode !== "online-acquisition-allowed" ||
    replay.acquisitionMode !== "cache-enforced-replay"
  ) {
    throw new Error("release identities do not describe online then cache-enforced replay");
  }
  for (const identity of [online, replay]) {
    if (
      identity.schemaVersion !== 1 ||
      identity.releaseEligible !== false ||
      !/^[0-9a-f]{40}$/.test(identity.sourceCommit ?? "") ||
      !/^[0-9a-f]{64}$/.test(identity.sourceStateSha256 ?? "") ||
      identity.checksumEntryCount !== identity.files?.length
    ) {
      throw new Error("release replay identity is incomplete or incorrectly eligible");
    }
  }
  const comparable = (identity) => ({
    schemaVersion: identity.schemaVersion,
    sourceCommit: identity.sourceCommit,
    sourceStateSha256: identity.sourceStateSha256,
    releaseEligible: identity.releaseEligible,
    checksumEntryCount: identity.checksumEntryCount,
    normalizedProvenanceSha256: identity.normalizedProvenanceSha256,
    files: identity.files,
  });
  if (JSON.stringify(comparable(online)) !== JSON.stringify(comparable(replay))) {
    throw new Error(
      "online/cache-replay release evidence differs across normalized provenance, SBOMs, inventories, assertions, archives, or checksums",
    );
  }
};
