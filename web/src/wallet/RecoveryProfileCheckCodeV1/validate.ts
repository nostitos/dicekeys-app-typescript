import type { WalletMnemonicResult } from "../DiceKeyBip39ProfileV1/profile";
import { english } from "../../formats/bip39/word-lists/english";
import { RECOVERY_PROFILE_CHECK_CODE_V1 } from "./profile";

export const RecoveryProfileCheckCodeInputErrorCodes = [
  "INVALID_RESULT",
  "MUTABLE_RESULT",
  "INVALID_PROFILE",
  "INVALID_MNEMONIC_FORMAT",
  "UNKNOWN_WORD",
  "INVALID_CHECKSUM",
] as const;

export type RecoveryProfileCheckCodeInputErrorCode =
  typeof RecoveryProfileCheckCodeInputErrorCodes[number];

export class RecoveryProfileCheckCodeInputError extends Error {
  readonly name = "RecoveryProfileCheckCodeInputError";

  constructor(readonly code: RecoveryProfileCheckCodeInputErrorCode) {
    super(`Recovery profile check code input failed (${code})`);
  }
}

export const RecoveryProfileCheckCodeOperationalErrorCode =
  "SHA256_FAILED" as const;

export class RecoveryProfileCheckCodeOperationalError extends Error {
  readonly name = "RecoveryProfileCheckCodeOperationalError";
  readonly code = RecoveryProfileCheckCodeOperationalErrorCode;

  constructor() {
    super("Recovery profile check code hashing failed (SHA256_FAILED)");
  }
}

const bip39EnglishWordIndexes = new Map(
  english.map((word, index) => [word, index] as const),
);

const fail = (code: RecoveryProfileCheckCodeInputErrorCode): never => {
  throw new RecoveryProfileCheckCodeInputError(code);
};

const wipeBestEffort = (
  values: Uint8Array | number[] | undefined,
): void => {
  try {
    values?.fill(0);
  } catch {
    // JavaScript cannot guarantee erasure; preserve the validation result.
  }
};

const wipeMalformedDigestResultBestEffort = (value: unknown): void => {
  try {
    if (ArrayBuffer.isView(value)) {
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength).fill(0);
    } else if (value instanceof ArrayBuffer) {
      new Uint8Array(value).fill(0);
    }
  } catch {
    // A malformed or hostile host result must not replace the fixed error.
  }
};

const inspectCallerValue = <Result>(operation: () => Result): Result => {
  try {
    return operation();
  } catch {
    // Never preserve a caller-controlled trap error, message, identity, or cause.
    throw new RecoveryProfileCheckCodeInputError("INVALID_RESULT");
  }
};

const isCallerValueAnArray = (value: unknown): boolean =>
  inspectCallerValue(() => Array.isArray(value));

const isCallerValueFrozen = (value: object): boolean =>
  inspectCallerValue(() => Object.isFrozen(value));

const readOwnDataProperty = (
  value: object,
  property: string | symbol,
): unknown => {
  const descriptor = inspectCallerValue(
    () => Object.getOwnPropertyDescriptor(value, property),
  );
  if (descriptor == null || !("value" in descriptor)) {
    throw new RecoveryProfileCheckCodeInputError("INVALID_RESULT");
  }
  return descriptor.value;
};

const hasExactOwnKeys = (
  value: object,
  expected: readonly (string | symbol)[],
): boolean => {
  const actual = inspectCallerValue(() => Reflect.ownKeys(value));
  return actual.length === expected.length
    && expected.every((key) => actual.includes(key));
};

/**
 * Fixed WebCrypto boundary shared by both profile hashes. All host failures and
 * malformed results collapse to one payload-free operational error.
 */
export const sha256Digest = async (input: Uint8Array): Promise<Uint8Array> => {
  let rawDigest: unknown;
  try {
    rawDigest = await crypto.subtle.digest("SHA-256", input);
  } catch {
    throw new RecoveryProfileCheckCodeOperationalError();
  }

  let digestBytes: Uint8Array | undefined;
  try {
    if (!(rawDigest instanceof ArrayBuffer)) {
      throw new TypeError("Malformed digest");
    }
    digestBytes = new Uint8Array(rawDigest);
    if (digestBytes.length !== 32) {
      throw new TypeError("Malformed digest length");
    }
    return digestBytes;
  } catch {
    wipeBestEffort(digestBytes);
    wipeMalformedDigestResultBestEffort(rawDigest);
    throw new RecoveryProfileCheckCodeOperationalError();
  }
};

/** Validate exact ASCII/BIP39 form without normalizing caller input. */
export const validateCanonicalWalletMnemonic = async (
  candidate: unknown,
): Promise<string> => {
  if (
    typeof candidate !== "string"
    || !/^[a-z]+(?: [a-z]+){23}$/.test(candidate)
  ) {
    throw new RecoveryProfileCheckCodeInputError("INVALID_MNEMONIC_FORMAT");
  }

  const words = candidate.split(" ");
  const numericIndexes = words.map((word) => {
    const index = bip39EnglishWordIndexes.get(word);
    if (index == null) {
      throw new RecoveryProfileCheckCodeInputError("UNKNOWN_WORD");
    }
    return index;
  });
  const entropy = new Uint8Array(32);
  let checksumByte = 0;
  let digestBytes: Uint8Array | undefined;
  try {
    for (let bitIndex = 0; bitIndex < 264; bitIndex += 1) {
      const wordIndex = Math.floor(bitIndex / 11);
      const bitWithinWord = bitIndex % 11;
      const bit = (numericIndexes[wordIndex]! >> (10 - bitWithinWord)) & 1;
      if (bitIndex < 256) {
        entropy[Math.floor(bitIndex / 8)]! |= bit << (7 - (bitIndex % 8));
      } else {
        checksumByte |= bit << (7 - (bitIndex - 256));
      }
    }

    digestBytes = await sha256Digest(entropy);
    if (digestBytes[0] !== checksumByte) {
      fail("INVALID_CHECKSUM");
    }
    return candidate;
  } finally {
    wipeBestEffort(numericIndexes);
    wipeBestEffort(entropy);
    wipeBestEffort(digestBytes);
  }
};

/**
 * Inspect the exact frozen shape emitted by the Phase 3 wallet profile without
 * invoking accessors or accepting hidden fields such as entropy.
 */
export const readCanonicalMnemonicFromWalletResult = (
  candidate: unknown,
): WalletMnemonicResult["mnemonic"] => {
  if (
    candidate == null
    || typeof candidate !== "object"
  ) {
    throw new RecoveryProfileCheckCodeInputError("INVALID_RESULT");
  }
  const result = candidate as object;
  if (
    isCallerValueAnArray(result)
    || !hasExactOwnKeys(result, ["profileId", "words", "mnemonic"])
  ) {
    fail("INVALID_RESULT");
  }
  if (!isCallerValueFrozen(result)) {
    fail("MUTABLE_RESULT");
  }

  const profileId = readOwnDataProperty(result, "profileId");
  const words = readOwnDataProperty(result, "words");
  const mnemonic = readOwnDataProperty(result, "mnemonic");

  if (profileId !== RECOVERY_PROFILE_CHECK_CODE_V1.profileId) {
    fail("INVALID_PROFILE");
  }
  if (!isCallerValueAnArray(words)) {
    throw new RecoveryProfileCheckCodeInputError("INVALID_RESULT");
  }
  const resultWords = words as unknown[];
  if (!isCallerValueFrozen(resultWords)) {
    fail("MUTABLE_RESULT");
  }
  if (
    !hasExactOwnKeys(resultWords, [
      ...Array.from({ length: 24 }, (_, index) => String(index)),
      "length",
    ])
  ) {
    fail("INVALID_RESULT");
  }
  if (readOwnDataProperty(resultWords, "length") !== 24) {
    fail("INVALID_RESULT");
  }

  const cleanWords: string[] = [];
  for (let index = 0; index < 24; index += 1) {
    const word = readOwnDataProperty(resultWords, String(index));
    if (typeof word !== "string") {
      throw new RecoveryProfileCheckCodeInputError("INVALID_RESULT");
    }
    cleanWords.push(word);
  }
  if (typeof mnemonic !== "string" || cleanWords.join(" ") !== mnemonic) {
    throw new RecoveryProfileCheckCodeInputError("INVALID_RESULT");
  }
  return mnemonic;
};
