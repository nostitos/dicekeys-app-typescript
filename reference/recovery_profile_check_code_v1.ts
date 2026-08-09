#!/usr/bin/env node
/* Independent Node-compatible TypeScript reference for the Phase 4 check code. */

"use strict";

const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const PROFILE_ID = "DK-BIP39-24-v1";
const LABEL = "Recovery profile check code v1";
const DOMAIN_ASCII = "DiceKeys/RecoveryProfileCheckCode/v1";
const PREFIX = Buffer.concat([
  Buffer.from(DOMAIN_ASCII, "ascii"),
  Buffer.from([0]),
  Buffer.from(PROFILE_ID, "ascii"),
  Buffer.from([0]),
]);
const PREFIX_HEX =
  "446963654b6579732f5265636f7665727950726f66696c65436865636b436f64652f763100444b2d42495033392d32342d763100";
const WORD_LIST_BYTES = readFileSync(join(__dirname, "bip39-english.txt"));
const WORDS = WORD_LIST_BYTES.toString("ascii")
  .trimEnd()
  .split("\n");
const WORD_INDEX = new Map(WORDS.map((word, index) => [word, index]));
const SOURCE_VECTORS_PATH = join(__dirname, "..", "spec", "test-vectors.json");
const CHECK_CODE_VECTORS_PATH = join(
  __dirname,
  "..",
  "spec",
  "recovery-profile-check-code-v1-test-vectors.json",
);

class CheckCodeInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "CheckCodeInputError";
  }
}

function validateCanonicalMnemonic(candidate) {
  if (
    typeof candidate !== "string"
    || !/^[a-z]+(?: [a-z]+){23}$/.test(candidate)
  ) {
    throw new CheckCodeInputError(
      "mnemonic must be exactly 24 lowercase ASCII words",
    );
  }
  const indexes = candidate.split(" ").map((word) => {
    const index = WORD_INDEX.get(word);
    if (index == null) {
      throw new CheckCodeInputError(
        "mnemonic contains a non-BIP39-English word",
      );
    }
    return index;
  });
  const bits = indexes.map((index) => index.toString(2).padStart(11, "0")).join("");
  const entropy = Buffer.alloc(32);
  for (let offset = 0; offset < entropy.length; offset += 1) {
    entropy[offset] = Number.parseInt(bits.slice(offset * 8, offset * 8 + 8), 2);
  }
  const checksum = Number.parseInt(bits.slice(256), 2);
  if (createHash("sha256").update(entropy).digest()[0] !== checksum) {
    throw new CheckCodeInputError("mnemonic has an invalid BIP39 checksum");
  }
  return candidate;
}

function digestForProfile(profile, mnemonic) {
  return createHash("sha256")
    .update(Buffer.from(DOMAIN_ASCII, "ascii"))
    .update(Buffer.from([0]))
    .update(Buffer.from(profile, "ascii"))
    .update(Buffer.from([0]))
    .update(Buffer.from(mnemonic, "ascii"))
    .digest();
}

function deriveCheckCode(candidate) {
  const mnemonic = validateCanonicalMnemonic(candidate);
  const digest = createHash("sha256")
    .update(PREFIX)
    .update(Buffer.from(mnemonic, "ascii"))
    .digest();
  const checkCodeHex = digest.subarray(0, 6).toString("hex").toUpperCase();
  return {
    fullDigestHex: digest.toString("hex"),
    checkCodeHex,
    displayCheckCode: checkCodeHex.match(/.{4}/g).join("-"),
  };
}

function loadDocuments() {
  return {
    source: JSON.parse(readFileSync(SOURCE_VECTORS_PATH, "utf8")),
    expected: JSON.parse(readFileSync(CHECK_CODE_VECTORS_PATH, "utf8")),
  };
}

function allVectorResults() {
  const { source, expected } = loadDocuments();
  if (source.validVectorIdsInOrder.length !== source.vectors.length) {
    throw new Error("source vector IDs and mnemonic records are not aligned");
  }
  const results = Object.fromEntries(
    source.validVectorIdsInOrder.map((vectorId, index) => [
      vectorId,
      deriveCheckCode(source.vectors[index].mnemonic),
    ]),
  );
  if (JSON.stringify(Object.keys(results)) !== JSON.stringify(Object.keys(expected.vectors))) {
    throw new Error("check-code vector keys do not match the source vector order");
  }
  return results;
}

function runSelfTest() {
  const { source, expected } = loadDocuments();
  if (WORDS.length !== 2048) throw new Error("word-list size mismatch");
  if (LABEL !== expected.label) throw new Error("label mismatch");
  if (PROFILE_ID !== expected.profile) throw new Error("profile mismatch");
  if (DOMAIN_ASCII !== expected.domainAscii) throw new Error("domain mismatch");
  if (PREFIX.toString("hex") !== PREFIX_HEX || PREFIX_HEX !== expected.preimagePrefixHex) {
    throw new Error("fixed preimage prefix mismatch");
  }
  if (expected.digestAlgorithm !== "SHA-256" || expected.codeByteLength !== 6) {
    throw new Error("digest contract mismatch");
  }
  const wordListContract = expected.bip39EnglishWordList;
  if (
    wordListContract.entryCount !== WORDS.length
    || wordListContract.lfTerminatedAsciiByteLength !== WORD_LIST_BYTES.length
    || wordListContract.lfTerminatedAsciiSha256
      !== createHash("sha256").update(WORD_LIST_BYTES).digest("hex")
  ) {
    throw new Error("BIP39 English word-list provenance mismatch");
  }

  const results = allVectorResults();
  if (Object.keys(results).length !== 27 || expected.vectorCount !== 27) {
    throw new Error("vector count mismatch");
  }
  let associations = 0;
  source.validVectorIdsInOrder.forEach((vectorId, index) => {
    const vector = source.vectors[index];
    if (vector.allFourRotations.length !== 4) {
      throw new Error(`rotation count mismatch: ${vectorId}`);
    }
    if (JSON.stringify(results[vectorId]) !== JSON.stringify(expected.vectors[vectorId])) {
      throw new Error(`vector mismatch: ${vectorId}`);
    }
    vector.allFourRotations.forEach(() => {
      if (JSON.stringify(deriveCheckCode(vector.mnemonic)) !== JSON.stringify(results[vectorId])) {
        throw new Error(`rotation association mismatch: ${vectorId}`);
      }
      associations += 1;
    });
  });
  if (associations !== 108 || expected.physicalRotationAssociationCount !== 108) {
    throw new Error("rotation association count mismatch");
  }
  const v01 = source.vectors[0].mnemonic;
  if (results.V01.fullDigestHex !== "521cbb8cfd07d4e44f94d70c2af68d2606bab17317de71553100af1488cde7cd") {
    throw new Error("V01 full digest mismatch");
  }
  if (results.V01.displayCheckCode !== "521C-BB8C-FD07") {
    throw new Error("V01 display code mismatch");
  }
  const changedProfile = expected.negativeControls.changedProfileForV01;
  if (digestForProfile(changedProfile.profile, v01).toString("hex") !== changedProfile.fullDigestHex) {
    throw new Error("changed-profile negative control mismatch");
  }
  if (results.V23.displayCheckCode === results.V24.displayCheckCode) {
    throw new Error("digit sensitivity pair collided");
  }
  if (results.V25.displayCheckCode === results.V26.displayCheckCode) {
    throw new Error("orientation sensitivity pair collided");
  }
  [
    ` ${v01}`,
    `${v01} `,
    v01.replace(" ", "  "),
    v01.replace(" ", "\t"),
    v01.replace(" ", "\n"),
    v01.replace(" ", "\u00a0"),
    v01.replace("execute", "Execute"),
  ].forEach((candidate) => {
    try {
      deriveCheckCode(candidate);
      throw new Error("non-canonical mnemonic encoding was accepted");
    } catch (error) {
      if (!(error instanceof CheckCodeInputError)) throw error;
    }
  });
  return { vectorCount: Object.keys(results).length, associationCount: associations };
}

if (require.main === module) {
  if (process.argv.length !== 3 || !["--self-test", "--all-json"].includes(process.argv[2])) {
    process.stderr.write("usage: recovery_profile_check_code_v1.ts --self-test|--all-json\n");
    process.exitCode = 2;
  } else if (process.argv[2] === "--all-json") {
    process.stdout.write(`${JSON.stringify(allVectorResults())}\n`);
  } else {
    const result = runSelfTest();
    process.stdout.write(
      `ok: ${result.vectorCount} check-code vectors and ${result.associationCount} rotation associations matched\n`,
    );
  }
}

module.exports = {
  CheckCodeInputError,
  deriveCheckCode,
  runSelfTest,
};
