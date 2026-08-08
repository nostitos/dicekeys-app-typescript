#!/usr/bin/env node
/*
 * Independent TypeScript reference for DK-BIP39-24-v1.
 *
 * The source deliberately uses the JavaScript-compatible subset of TypeScript
 * so the audited Node 20 baseline can execute it without a transpiler.  It
 * imports only Node built-ins and contains its own RFC 7693 BLAKE2b core because
 * Node 20 cannot request a keyed 32-byte BLAKE2b digest correctly.
 */

"use strict";

const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const PROFILE_ID = "DK-BIP39-24-v1";
const FACE_LETTERS = "ABCDEFGHIJKLMNOPRSTUVWXYZ";
const FACE_DIGITS = "123456";
const FACE_ORIENTATIONS = "trbl";
const RECIPE_BYTES = Buffer.from('{"purpose":"wallet"}', "ascii");
const OBJECT_TYPE_BYTES = Buffer.from("Secret", "ascii");
const DERIVATION_INFO = Buffer.concat([OBJECT_TYPE_BYTES, RECIPE_BYTES]);
const WORD_LIST_PATH = join(__dirname, "bip39-english.txt");
const WORD_LIST_SHA256 =
  "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda";
const VECTORS_PATH = join(__dirname, "..", "spec", "test-vectors.json");
const VALIDATION_ERROR_PRECEDENCE = Object.freeze([
  "NON_ASCII",
  "INVALID_LENGTH",
  "INVALID_LETTER",
  "INVALID_DIGIT",
  "INVALID_ORIENTATION",
  "DUPLICATE_OR_MISSING_LETTER",
]);
const VALIDATION_ERROR_CODES = VALIDATION_ERROR_PRECEDENCE;

const ROTATION_INDEXES = [
  Array.from({ length: 25 }, (_, index) => index),
  [
    20, 15, 10, 5, 0,
    21, 16, 11, 6, 1,
    22, 17, 12, 7, 2,
    23, 18, 13, 8, 3,
    24, 19, 14, 9, 4,
  ],
  [
    24, 23, 22, 21, 20,
    19, 18, 17, 16, 15,
    14, 13, 12, 11, 10,
    9, 8, 7, 6, 5,
    4, 3, 2, 1, 0,
  ],
  [
    4, 9, 14, 19, 24,
    3, 8, 13, 18, 23,
    2, 7, 12, 17, 22,
    1, 6, 11, 16, 21,
    0, 5, 10, 15, 20,
  ],
];

class ProfileInputError extends Error {
  constructor(code, message) {
    if (!VALIDATION_ERROR_CODES.includes(code)) {
      throw new RangeError(`unknown profile validation error code: ${code}`);
    }
    super(message);
    this.name = "ProfileInputError";
    this.code = code;
  }
}

function parseDiceKeyHrf(humanReadableForm) {
  if (typeof humanReadableForm !== "string") {
    throw new TypeError("DiceKey human-readable form must be a string");
  }
  if (!/^[\x00-\x7f]*$/.test(humanReadableForm)) {
    throw new ProfileInputError(
      "NON_ASCII",
      "DiceKey human-readable form must be ASCII",
    );
  }
  if (Buffer.byteLength(humanReadableForm, "ascii") !== 75) {
    throw new ProfileInputError(
      "INVALID_LENGTH",
      "DiceKey human-readable form must be exactly 75 bytes",
    );
  }

  const faces = [];
  for (let position = 0; position < 25; position += 1) {
    const offset = position * 3;
    const letter = humanReadableForm[offset];
    const digit = humanReadableForm[offset + 1];
    const orientation = humanReadableForm[offset + 2];
    const faceNumber = position + 1;
    if (!FACE_LETTERS.includes(letter)) {
      throw new ProfileInputError(
        "INVALID_LETTER",
        `face ${faceNumber} has an invalid letter`,
      );
    }
    if (!FACE_DIGITS.includes(digit)) {
      throw new ProfileInputError(
        "INVALID_DIGIT",
        `face ${faceNumber} has an invalid digit`,
      );
    }
    if (!FACE_ORIENTATIONS.includes(orientation)) {
      throw new ProfileInputError(
        "INVALID_ORIENTATION",
        `face ${faceNumber} has an invalid orientation`,
      );
    }
    faces.push({ letter, digit, orientation });
  }

  const letters = faces.map((face) => face.letter);
  if (
    new Set(letters).size !== 25
    || [...FACE_LETTERS].some((letter) => !letters.includes(letter))
  ) {
    throw new ProfileInputError(
      "DUPLICATE_OR_MISSING_LETTER",
      "face letters must contain ABCDEFGHIJKLMNOPRSTUVWXYZ exactly once",
    );
  }
  return faces;
}

function serializeFaces(faces) {
  if (!Array.isArray(faces) || faces.length !== 25) {
    throw new ProfileInputError(
      "INVALID_LENGTH",
      "a DiceKey must contain exactly 25 faces",
    );
  }
  return faces
    .map((face) => face.letter + face.digit + face.orientation)
    .join("");
}

function rotateFaces(faces, clockwiseQuarterTurns) {
  if (![0, 1, 2, 3].includes(clockwiseQuarterTurns)) {
    throw new RangeError("rotation must be 0, 1, 2, or 3 clockwise quarter-turns");
  }
  if (!Array.isArray(faces) || faces.length !== 25) {
    throw new ProfileInputError(
      "INVALID_LENGTH",
      "a DiceKey must contain exactly 25 faces",
    );
  }
  return ROTATION_INDEXES[clockwiseQuarterTurns].map((index) => {
    const face = faces[index];
    const orientationIndex = FACE_ORIENTATIONS.indexOf(face.orientation);
    return {
      letter: face.letter,
      digit: face.digit,
      orientation:
        FACE_ORIENTATIONS[(orientationIndex + clockwiseQuarterTurns) % 4],
    };
  });
}

function allFourRotations(humanReadableForm) {
  const faces = parseDiceKeyHrf(humanReadableForm);
  return [0, 1, 2, 3].map((turns) =>
    serializeFaces(rotateFaces(faces, turns))
  );
}

function canonicalizeDiceKey(humanReadableForm) {
  return allFourRotations(humanReadableForm).reduce((earliest, candidate) =>
    Buffer.compare(Buffer.from(candidate, "ascii"), Buffer.from(earliest, "ascii")) < 0
      ? candidate
      : earliest
  );
}

const MASK_64 = (1n << 64n) - 1n;
const BLAKE2B_IV = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
];
const BLAKE2B_SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

function add64(...values) {
  return values.reduce((sum, value) => (sum + value) & MASK_64, 0n);
}

function rotateRight64(value, bits) {
  const count = BigInt(bits);
  return ((value >> count) | (value << (64n - count))) & MASK_64;
}

function blake2bMix(v, a, b, c, d, x, y) {
  v[a] = add64(v[a], v[b], x);
  v[d] = rotateRight64(v[d] ^ v[a], 32);
  v[c] = add64(v[c], v[d]);
  v[b] = rotateRight64(v[b] ^ v[c], 24);
  v[a] = add64(v[a], v[b], y);
  v[d] = rotateRight64(v[d] ^ v[a], 16);
  v[c] = add64(v[c], v[d]);
  v[b] = rotateRight64(v[b] ^ v[c], 63);
}

function blake2bCompress(hashState, block, byteCounter, isLastBlock) {
  const messageWords = Array.from({ length: 16 }, (_, index) =>
    block.readBigUInt64LE(index * 8)
  );
  const v = [...hashState, ...BLAKE2B_IV];
  v[12] ^= byteCounter & MASK_64;
  v[13] ^= (byteCounter >> 64n) & MASK_64;
  if (isLastBlock) {
    v[14] ^= MASK_64;
  }

  for (const sigma of BLAKE2B_SIGMA) {
    blake2bMix(v, 0, 4, 8, 12, messageWords[sigma[0]], messageWords[sigma[1]]);
    blake2bMix(v, 1, 5, 9, 13, messageWords[sigma[2]], messageWords[sigma[3]]);
    blake2bMix(v, 2, 6, 10, 14, messageWords[sigma[4]], messageWords[sigma[5]]);
    blake2bMix(v, 3, 7, 11, 15, messageWords[sigma[6]], messageWords[sigma[7]]);
    blake2bMix(v, 0, 5, 10, 15, messageWords[sigma[8]], messageWords[sigma[9]]);
    blake2bMix(v, 1, 6, 11, 12, messageWords[sigma[10]], messageWords[sigma[11]]);
    blake2bMix(v, 2, 7, 8, 13, messageWords[sigma[12]], messageWords[sigma[13]]);
    blake2bMix(v, 3, 4, 9, 14, messageWords[sigma[14]], messageWords[sigma[15]]);
  }
  for (let index = 0; index < 8; index += 1) {
    hashState[index] = (
      hashState[index] ^ v[index] ^ v[index + 8]
    ) & MASK_64;
  }
}

function blake2b(messageInput, keyInput = Buffer.alloc(0), outputLength = 64) {
  const message = Buffer.from(messageInput);
  const key = Buffer.from(keyInput);
  if (!Number.isInteger(outputLength) || outputLength < 1 || outputLength > 64) {
    throw new RangeError("BLAKE2b output length must be between 1 and 64 bytes");
  }
  if (key.length > 64) {
    throw new RangeError("BLAKE2b key must not exceed 64 bytes");
  }

  const hashState = [...BLAKE2B_IV];
  const parameterWord =
    outputLength | (key.length << 8) | (1 << 16) | (1 << 24);
  hashState[0] ^= BigInt(parameterWord);

  let input = message;
  if (key.length > 0) {
    const keyBlock = Buffer.alloc(128);
    key.copy(keyBlock);
    input = Buffer.concat([keyBlock, message]);
  }

  let offset = 0;
  let byteCounter = 0n;
  while (offset + 128 < input.length) {
    byteCounter += 128n;
    blake2bCompress(
      hashState,
      input.subarray(offset, offset + 128),
      byteCounter,
      false,
    );
    offset += 128;
  }

  const finalLength = input.length - offset;
  const finalBlock = Buffer.alloc(128);
  if (finalLength > 0) {
    input.copy(finalBlock, 0, offset);
  }
  byteCounter += BigInt(finalLength);
  blake2bCompress(hashState, finalBlock, byteCounter, true);

  const fullDigest = Buffer.alloc(64);
  hashState.forEach((word, index) => fullDigest.writeBigUInt64LE(word, index * 8));
  return fullDigest.subarray(0, outputLength);
}

function blake2b256(key, message) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new RangeError("this profile requires a 32-byte BLAKE2b key");
  }
  return blake2b(message, key, 32);
}

function deriveEntropy(humanReadableForm) {
  const canonicalSeedString = canonicalizeDiceKey(humanReadableForm);
  const inputKeyMaterial = Buffer.from(canonicalSeedString, "ascii");
  const pseudorandomKey = blake2b256(Buffer.alloc(32), inputKeyMaterial);
  const entropy = blake2b256(
    pseudorandomKey,
    Buffer.concat([DERIVATION_INFO, Buffer.from([1])]),
  );
  return { canonicalSeedString, entropy };
}

function loadEnglishWordList() {
  const raw = readFileSync(WORD_LIST_PATH);
  const actualHash = createHash("sha256").update(raw).digest("hex");
  if (actualHash !== WORD_LIST_SHA256) {
    throw new Error(`BIP39 English word-list hash mismatch: ${actualHash}`);
  }
  if ([...raw].some((byte) => byte > 0x7f)) {
    throw new Error("BIP39 English word list must be ASCII");
  }
  const text = raw.toString("ascii");
  const words = text.endsWith("\n")
    ? text.slice(0, -1).split("\n")
    : text.split("\n");
  if (
    words.length !== 2048
    || new Set(words).size !== 2048
    || words.some((word) => !/^[a-z]+$/.test(word))
    || words.some((word, index) => index > 0 && words[index - 1] >= word)
  ) {
    throw new Error("BIP39 English word-list structure is invalid");
  }
  return words;
}

function entropyToBip39Mnemonic(entropyInput, wordList) {
  const entropy = Buffer.from(entropyInput);
  if (entropy.length !== 32) {
    throw new RangeError("DK-BIP39-24-v1 requires exactly 32 entropy bytes");
  }
  const words = wordList || loadEnglishWordList();
  if (!Array.isArray(words) || words.length !== 2048) {
    throw new RangeError("BIP39 word list must contain exactly 2048 words");
  }
  const checksum = createHash("sha256").update(entropy).digest().subarray(0, 1);
  const bits = BigInt(`0x${Buffer.concat([entropy, checksum]).toString("hex")}`);
  const indexes = Array.from({ length: 24 }, (_, wordNumber) =>
    Number((bits >> BigInt((23 - wordNumber) * 11)) & 0x7ffn)
  );
  return indexes.map((index) => words[index]).join(" ");
}

function deriveProfile(humanReadableForm) {
  const { canonicalSeedString, entropy } = deriveEntropy(humanReadableForm);
  return {
    profile: PROFILE_ID,
    canonicalSeedString,
    derivedEntropyHex: entropy.toString("hex"),
    mnemonic: entropyToBip39Mnemonic(entropy),
  };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch\nactual:   ${actual}\nexpected: ${expected}`);
  }
}

function expectInputError(candidate, expectedCode) {
  try {
    deriveProfile(candidate);
  } catch (error) {
    if (error instanceof ProfileInputError) {
      assertEqual(error.code, expectedCode, "input error code");
      return;
    }
    throw error;
  }
  throw new Error("malformed DiceKey input was accepted");
}

function runSelfTest() {
  assertEqual(
    blake2b(Buffer.from("abc", "ascii")).toString("hex"),
    "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d"
      + "17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    "RFC 7693 BLAKE2b",
  );
  assertEqual(
    blake2b256(Buffer.alloc(32), Buffer.from("abc", "ascii")).toString("hex"),
    "bad705ff155af631f38dc6cafdda827a31595c802f3ff585c10691c58944d89b",
    "keyed BLAKE2b-256",
  );
  assertEqual(
    entropyToBip39Mnemonic(Buffer.alloc(32)),
    [...Array(23).fill("abandon"), "art"].join(" "),
    "BIP39 zero-entropy vector",
  );

  const vectorDocument = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));
  const vectors = vectorDocument.vectors || [];
  const expectedVectorCount = vectorDocument.generation.validVectorCount;
  const expectedDerivationCount =
    vectorDocument.generation.physicalRotationDerivationCount;
  assertEqual(vectorDocument.profile, PROFILE_ID, "vector-document profile");
  assertEqual(
    vectorDocument.generation.recipeUtf8Hex,
    RECIPE_BYTES.toString("hex"),
    "vector-document recipe",
  );
  const precedenceDocument = vectorDocument.invalidValidationPrecedence;
  const committedPrecedence = precedenceDocument.steps.flatMap((step) =>
    step.errorCode ? [step.errorCode] : step.perFaceErrorOrder
  );
  assertEqual(
    JSON.stringify(committedPrecedence),
    JSON.stringify(VALIDATION_ERROR_PRECEDENCE),
    "validation-error precedence",
  );
  assertEqual(
    precedenceDocument.multipleFailureRule,
    "stop at the first failed step or first failed per-face check",
    "multiple-validation-failure rule",
  );
  if (vectors.length !== expectedVectorCount || vectors.length < 5) {
    throw new Error("committed valid-vector count does not match metadata");
  }

  let derivationsChecked = 0;
  vectors.forEach((vector) => {
    const rotations = allFourRotations(vector.diceKeyHumanReadableForm);
    assertEqual(JSON.stringify(rotations), JSON.stringify(vector.allFourRotations), "rotations");
    assertEqual(
      rotations.reduce((earliest, value) => value < earliest ? value : earliest),
      vector.canonicalSeedString,
      "canonical seed string",
    );
    assertEqual(vector.profile, PROFILE_ID, "profile identifier");
    assertEqual(vector.recipeUtf8Hex, RECIPE_BYTES.toString("hex"), "recipe bytes");
    rotations.forEach((rotation) => {
      const result = deriveProfile(rotation);
      assertEqual(result.profile, PROFILE_ID, "profile identifier");
      assertEqual(result.canonicalSeedString, vector.canonicalSeedString, "canonical seed string");
      assertEqual(result.derivedEntropyHex, vector.derivedEntropyHex, "derived entropy");
      assertEqual(result.mnemonic, vector.mnemonic, "mnemonic");
      derivationsChecked += 1;
    });
  });

  assertEqual(derivationsChecked, expectedDerivationCount, "derivation count");
  const invalidCases = vectorDocument.invalidCases || [];
  if (invalidCases.length === 0) {
    throw new Error("committed invalid cases are required");
  }
  invalidCases.forEach((invalidCase) => {
    expectInputError(
      invalidCase.diceKeyHumanReadableForm,
      invalidCase.expectedErrorCode,
    );
  });

  const acquisitionCases = vectorDocument.acquisitionPolicyCases || [];
  if (acquisitionCases.length === 0) {
    throw new Error("committed acquisition-policy cases are required");
  }
  acquisitionCases.forEach((policyCase) => {
    assertEqual(
      policyCase.expectedAcquisitionState,
      "AMBIGUOUS_SCAN",
      "acquisition state",
    );
    assertEqual(policyCase.humanReadableFormProduced, false, "HRF production policy");
    assertEqual(policyCase.profileDerivationInvoked, false, "derivation policy");
  });
  return derivationsChecked;
}

function main(argv) {
  if (argv.length === 1 && argv[0] === "--self-test") {
    const checked = runSelfTest();
    process.stdout.write(`ok: ${checked} committed rotation derivations matched\n`);
    return 0;
  }
  if (argv.length !== 1 || argv[0].startsWith("--")) {
    process.stderr.write(
      "usage: node reference/dk_bip39_24_v1.ts <75-character-HRF>\n"
        + "       node reference/dk_bip39_24_v1.ts --self-test\n",
    );
    return 2;
  }
  try {
    process.stdout.write(`${JSON.stringify(deriveProfile(argv[0]), null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ProfileInputError) {
      process.stderr.write(`error: ${error.code}: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

module.exports = {
  PROFILE_ID,
  VALIDATION_ERROR_CODES,
  VALIDATION_ERROR_PRECEDENCE,
  ProfileInputError,
  allFourRotations,
  blake2b,
  blake2b256,
  canonicalizeDiceKey,
  deriveEntropy,
  deriveProfile,
  entropyToBip39Mnemonic,
  parseDiceKeyHrf,
  rotateFaces,
  runSelfTest,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
