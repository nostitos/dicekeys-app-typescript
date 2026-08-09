import { webcrypto } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  deriveWalletMnemonicV1,
} from "../DiceKeyBip39ProfileV1";
import type { WalletMnemonicResult } from "../DiceKeyBip39ProfileV1/profile";
import {
  validateDiceKeyHumanReadableForm,
} from "../DiceKeyBip39ProfileV1/validate";
import * as publicCheckCodeApi from ".";
import {
  deriveRecoveryProfileCheckCodeV1FromCanonicalMnemonicForTests,
} from "./derive";
import { RECOVERY_PROFILE_CHECK_CODE_V1 } from "./profile";
import {
  recoveryProfileCheckCodeTestVectors,
  recoveryProfileCheckCodeVectorMetadata,
} from "./testVectors";
import {
  RecoveryProfileCheckCodeInputError,
  RecoveryProfileCheckCodeInputErrorCode,
  RecoveryProfileCheckCodeOperationalError,
  readCanonicalMnemonicFromWalletResult,
  validateCanonicalWalletMnemonic,
} from "./validate";

if (globalThis.crypto?.subtle == null) {
  globalThis.crypto = webcrypto as unknown as Crypto;
}

jest.setTimeout(30_000);

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const frozenWalletResult = (mnemonic: string): WalletMnemonicResult =>
  Object.freeze({
    profileId: "DK-BIP39-24-v1",
    words: Object.freeze(mnemonic.split(" ")),
    mnemonic,
  });

const expectInputCode = async (
  promise: Promise<unknown>,
  code: RecoveryProfileCheckCodeInputErrorCode,
): Promise<void> => {
  try {
    await promise;
    throw new Error("Expected recovery check-code input validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(RecoveryProfileCheckCodeInputError);
    expect((error as RecoveryProfileCheckCodeInputError).code).toBe(code);
  }
};

const expectFreshInvalidResult = async (
  promise: Promise<unknown>,
  callerError: Error,
): Promise<void> => {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RecoveryProfileCheckCodeInputError);
  expect(caught).not.toBe(callerError);
  const inputError = caught as RecoveryProfileCheckCodeInputError;
  expect(inputError.code).toBe("INVALID_RESULT");
  expect(inputError.message).toBe(
    "Recovery profile check code input failed (INVALID_RESULT)",
  );
  expect(inputError.message).not.toContain(callerError.message);
  expect("cause" in inputError).toBe(false);
};

const expectFreshOperationalError = async (
  promise: Promise<unknown>,
  callerError?: Error,
): Promise<void> => {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RecoveryProfileCheckCodeOperationalError);
  if (callerError != null) {
    expect(caught).not.toBe(callerError);
  }
  const operationalError = caught as RecoveryProfileCheckCodeOperationalError;
  expect(operationalError.code).toBe("SHA256_FAILED");
  expect(operationalError.message).toBe(
    "Recovery profile check code hashing failed (SHA256_FAILED)",
  );
  if (callerError != null) {
    expect(operationalError.message).not.toContain(callerError.message);
  }
  expect("cause" in operationalError).toBe(false);
};

const expectWiped = (bytes: Uint8Array): void => {
  expect(bytes).toStrictEqual(new Uint8Array(bytes.length));
};

const callerControlledError = (): RecoveryProfileCheckCodeInputError => {
  const error = new RecoveryProfileCheckCodeInputError("INVALID_PROFILE");
  error.message = "caller-controlled secret payload";
  Object.defineProperty(error, "cause", {
    value: "caller-controlled secret cause",
    enumerable: true,
  });
  return error;
};

const callerControlledOperationalError =
(): RecoveryProfileCheckCodeOperationalError => {
  const error = new RecoveryProfileCheckCodeOperationalError();
  error.message = "host WebCrypto secret payload";
  Object.defineProperty(error, "cause", {
    value: "host WebCrypto secret cause",
    enumerable: true,
  });
  return error;
};

const typeScriptFilesBelow = (directory: string): readonly string[] => {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      files.push(...typeScriptFilesBelow(path));
    } else if (/\.tsx?$/.test(name)) {
      files.push(path);
    }
  }
  return files;
};

describe("Recovery profile check code v1", () => {
  test("freezes the exact metadata and exposes one public operation", async () => {
    expect(RECOVERY_PROFILE_CHECK_CODE_V1).toStrictEqual({
      label: "Recovery profile check code v1",
      domain: "DiceKeys/RecoveryProfileCheckCode/v1",
      profileId: "DK-BIP39-24-v1",
      digestAlgorithm: "SHA-256",
      codeByteLength: 6,
    });
    expect(Object.isFrozen(RECOVERY_PROFILE_CHECK_CODE_V1)).toBe(true);
    expect(Object.keys(publicCheckCodeApi).sort()).toStrictEqual([
      "RECOVERY_PROFILE_CHECK_CODE_V1",
      "deriveRecoveryProfileCheckCodeV1",
    ]);
    expect(publicCheckCodeApi.deriveRecoveryProfileCheckCodeV1.length).toBe(1);

    const valid = frozenWalletResult(
      recoveryProfileCheckCodeTestVectors[0]!.mnemonic,
    );
    const callWithOverride =
      publicCheckCodeApi.deriveRecoveryProfileCheckCodeV1 as unknown as (
        result: WalletMnemonicResult,
        options: unknown,
      ) => Promise<string>;
    await expect(callWithOverride(valid, { domain: "changed" })).rejects.toBeInstanceOf(
      TypeError,
    );
    if (false) {
      // @ts-expect-error There is no domain/profile/passphrase/network argument.
      void publicCheckCodeApi.deriveRecoveryProfileCheckCodeV1(valid, {});
    }
  });

  test("loads the distinct 27-vector artifact and exact fixed prefix", () => {
    expect(recoveryProfileCheckCodeVectorMetadata).toStrictEqual({
      schema: "RecoveryProfileCheckCode-v1-test-vectors",
      schemaVersion: 1,
      label: "Recovery profile check code v1",
      profile: "DK-BIP39-24-v1",
      domainAscii: "DiceKeys/RecoveryProfileCheckCode/v1",
      preimagePrefixHex:
        "446963654b6579732f5265636f7665727950726f66696c65436865636b436f64652f763100444b2d42495033392d32342d763100",
      digestAlgorithm: "SHA-256",
      codeByteLength: 6,
      vectorCount: 27,
      physicalRotationAssociationCount: 108,
    });
    expect(recoveryProfileCheckCodeTestVectors).toHaveLength(27);
    expect(recoveryProfileCheckCodeTestVectors.map(({ id }) => id)).toStrictEqual(
      Array.from({ length: 27 }, (_, index) =>
        `V${String(index + 1).padStart(2, "0")}`),
    );
    expect(recoveryProfileCheckCodeTestVectors.every(Object.isFrozen)).toBe(true);
    expect(
      recoveryProfileCheckCodeTestVectors.flatMap(
        ({ allFourRotations }) => allFourRotations,
      ),
    ).toHaveLength(108);
  });

  test("matches every full digest and formatted code", async () => {
    for (const vector of recoveryProfileCheckCodeTestVectors) {
      const result =
        await deriveRecoveryProfileCheckCodeV1FromCanonicalMnemonicForTests(
          vector.mnemonic,
        );
      try {
        expect(bytesToHex(result.digest)).toBe(vector.fullDigestHex);
        expect(bytesToHex(result.digest.subarray(0, 6)).toUpperCase()).toBe(
          vector.checkCodeHex,
        );
        expect(result.checkCode).toBe(vector.displayCheckCode);
        expect(result.checkCode).toMatch(/^[0-9A-F]{4}(?:-[0-9A-F]{4}){2}$/);
        expect(Object.isFrozen(result)).toBe(true);
      } finally {
        result.digest.fill(0);
      }
    }
    expect(recoveryProfileCheckCodeTestVectors[0]).toMatchObject({
      id: "V01",
      fullDigestHex:
        "521cbb8cfd07d4e44f94d70c2af68d2606bab17317de71553100af1488cde7cd",
      checkCodeHex: "521CBB8CFD07",
      displayCheckCode: "521C-BB8C-FD07",
    });
  });

  test("associates all 108 physical rotations through the Phase 3 result", async () => {
    let associations = 0;
    for (const vector of recoveryProfileCheckCodeTestVectors) {
      for (const humanReadableForm of vector.allFourRotations) {
        const faces = validateDiceKeyHumanReadableForm(humanReadableForm);
        const walletResult = await deriveWalletMnemonicV1(faces);
        expect(walletResult.mnemonic).toBe(vector.mnemonic);
        await expect(
          publicCheckCodeApi.deriveRecoveryProfileCheckCodeV1(walletResult),
        ).resolves.toBe(vector.displayCheckCode);
        associations += 1;
      }
    }
    expect(associations).toBe(108);
  });

  test("accepts only the exact frozen Phase 3 result shape", async () => {
    const mnemonic = recoveryProfileCheckCodeTestVectors[0]!.mnemonic;
    const words = mnemonic.split(" ");
    const valid = frozenWalletResult(mnemonic);
    expect(readCanonicalMnemonicFromWalletResult(valid)).toBe(mnemonic);

    await expectInputCode(
      publicCheckCodeApi.deriveRecoveryProfileCheckCodeV1(
        mnemonic as unknown as WalletMnemonicResult,
      ),
      "INVALID_RESULT",
    );
    await expectInputCode(
      publicCheckCodeApi.deriveRecoveryProfileCheckCodeV1({
        profileId: "DK-BIP39-24-v1",
        words,
        mnemonic,
      }),
      "MUTABLE_RESULT",
    );
    await expectInputCode(
      publicCheckCodeApi.deriveRecoveryProfileCheckCodeV1(Object.freeze({
        profileId: "DK-BIP39-24-v1",
        words,
        mnemonic,
      })),
      "MUTABLE_RESULT",
    );
    await expectInputCode(
      publicCheckCodeApi.deriveRecoveryProfileCheckCodeV1(Object.freeze({
        ...valid,
        entropy: new Uint8Array(32),
      }) as unknown as WalletMnemonicResult),
      "INVALID_RESULT",
    );
    await expectInputCode(
      publicCheckCodeApi.deriveRecoveryProfileCheckCodeV1(Object.freeze({
        ...valid,
        profileId: "DK-BIP39-24-v2",
      }) as unknown as WalletMnemonicResult),
      "INVALID_PROFILE",
    );
    await expectInputCode(
      publicCheckCodeApi.deriveRecoveryProfileCheckCodeV1(Object.freeze({
        ...valid,
        mnemonic: `${mnemonic} `,
      })),
      "INVALID_RESULT",
    );

    const getterResult = Object.freeze(Object.defineProperties({}, {
      profileId: { enumerable: true, get: () => "DK-BIP39-24-v1" },
      words: { enumerable: true, get: () => valid.words },
      mnemonic: { enumerable: true, get: () => mnemonic },
    })) as WalletMnemonicResult;
    await expectInputCode(
      publicCheckCodeApi.deriveRecoveryProfileCheckCodeV1(getterResult),
      "INVALID_RESULT",
    );
  });

  test("rejects frozen trailing-hole, larger-length, and sparse word arrays", async () => {
    const mnemonic = recoveryProfileCheckCodeTestVectors[0]!.mnemonic;
    const length25WithTrailingHole = mnemonic.split(" ");
    length25WithTrailingHole.length = 25;
    const length64WithTrailingHoles = mnemonic.split(" ");
    length64WithTrailingHoles.length = 64;
    const sparseLength24 = mnemonic.split(" ");
    delete sparseLength24[7];

    for (const words of [
      length25WithTrailingHole,
      length64WithTrailingHoles,
      sparseLength24,
    ]) {
      const candidate = Object.freeze({
        profileId: "DK-BIP39-24-v1",
        words: Object.freeze(words),
        mnemonic,
      }) as WalletMnemonicResult;
      await expectInputCode(
        publicCheckCodeApi.deriveRecoveryProfileCheckCodeV1(candidate),
        "INVALID_RESULT",
      );
    }
  });

  test("collapses every hostile outer-result reflection trap to a fresh invalid-result error", async () => {
    const valid = frozenWalletResult(
      recoveryProfileCheckCodeTestVectors[0]!.mnemonic,
    );
    const proxyCases: Array<{
      readonly name: string;
      readonly candidate: WalletMnemonicResult;
      readonly callerError: Error;
    }> = [];

    for (const trapName of [
      "ownKeys",
      "isExtensible",
      "getOwnPropertyDescriptor",
    ] as const) {
      const callerError = callerControlledError();
      const handler: ProxyHandler<WalletMnemonicResult> = {
        [trapName]: () => {
          throw callerError;
        },
      };
      proxyCases.push({
        name: trapName,
        candidate: new Proxy(valid, handler),
        callerError,
      });
    }

    const lateDescriptorError = callerControlledError();
    let outerDescriptorReads = 0;
    proxyCases.push({
      name: "late getOwnPropertyDescriptor",
      candidate: new Proxy(valid, {
        getOwnPropertyDescriptor: (target, property) => {
          outerDescriptorReads += 1;
          if (outerDescriptorReads > 3) throw lateDescriptorError;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      }),
      callerError: lateDescriptorError,
    });

    const revokedError = callerControlledError();
    const revoked = Proxy.revocable(valid, {});
    revoked.revoke();
    proxyCases.push({
      name: "revoked Array.isArray proxy",
      candidate: revoked.proxy,
      callerError: revokedError,
    });

    for (const { name, candidate, callerError } of proxyCases) {
      await expectFreshInvalidResult(
        publicCheckCodeApi.deriveRecoveryProfileCheckCodeV1(candidate),
        callerError,
      );
      expect(name).toBeTruthy();
    }
  });

  test("collapses every hostile word-array reflection trap to a fresh invalid-result error", async () => {
    const mnemonic = recoveryProfileCheckCodeTestVectors[0]!.mnemonic;
    const baseWords = Object.freeze(mnemonic.split(" "));
    const proxyCases: Array<{
      readonly name: string;
      readonly words: readonly string[];
      readonly callerError: Error;
    }> = [];

    for (const trapName of [
      "ownKeys",
      "isExtensible",
      "getOwnPropertyDescriptor",
    ] as const) {
      const callerError = callerControlledError();
      const handler: ProxyHandler<readonly string[]> = {
        [trapName]: () => {
          throw callerError;
        },
      };
      proxyCases.push({
        name: trapName,
        words: new Proxy(baseWords, handler),
        callerError,
      });
    }

    const lateDescriptorError = callerControlledError();
    let wordDescriptorReads = 0;
    proxyCases.push({
      name: "late getOwnPropertyDescriptor",
      words: new Proxy(baseWords, {
        getOwnPropertyDescriptor: (target, property) => {
          wordDescriptorReads += 1;
          if (wordDescriptorReads > 25) throw lateDescriptorError;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      }),
      callerError: lateDescriptorError,
    });

    const revokedError = callerControlledError();
    const revoked = Proxy.revocable(baseWords, {});
    revoked.revoke();
    proxyCases.push({
      name: "revoked Array.isArray proxy",
      words: revoked.proxy,
      callerError: revokedError,
    });

    for (const { name, words, callerError } of proxyCases) {
      const candidate = Object.freeze({
        profileId: "DK-BIP39-24-v1",
        words,
        mnemonic,
      }) as WalletMnemonicResult;
      await expectFreshInvalidResult(
        publicCheckCodeApi.deriveRecoveryProfileCheckCodeV1(candidate),
        callerError,
      );
      expect(name).toBeTruthy();
    }
  });

  test("rejects whitespace, case, normalization, unknown words, and bad checksum", async () => {
    const mnemonic = recoveryProfileCheckCodeTestVectors[0]!.mnemonic;
    const formatFailures = [
      ` ${mnemonic}`,
      `${mnemonic} `,
      mnemonic.replace(" ", "  "),
      mnemonic.replace(" ", "\t"),
      mnemonic.replace(" ", "\n"),
      mnemonic.replace(" ", "\u00a0"),
      mnemonic.replace("execute", "Execute"),
      mnemonic.replace("execute", "e\u0301xecute"),
      mnemonic.split(" ").slice(0, 23).join(" "),
    ];
    for (const candidate of formatFailures) {
      await expectInputCode(
        validateCanonicalWalletMnemonic(candidate),
        "INVALID_MNEMONIC_FORMAT",
      );
    }
    await expectInputCode(
      validateCanonicalWalletMnemonic(
        mnemonic.replace("execute", "notaword"),
      ),
      "UNKNOWN_WORD",
    );
    await expectInputCode(
      validateCanonicalWalletMnemonic(
        `${mnemonic.slice(0, mnemonic.lastIndexOf(" "))} abandon`,
      ),
      "INVALID_CHECKSUM",
    );
  });

  test("changes for mnemonic sensitivity pairs while the production profile stays fixed", async () => {
    const digitPair = recoveryProfileCheckCodeTestVectors.slice(22, 24);
    const orientationPair = recoveryProfileCheckCodeTestVectors.slice(24, 26);
    expect(digitPair[0]!.displayCheckCode).not.toBe(digitPair[1]!.displayCheckCode);
    expect(orientationPair[0]!.displayCheckCode).not.toBe(
      orientationPair[1]!.displayCheckCode,
    );
    await expectInputCode(
      publicCheckCodeApi.deriveRecoveryProfileCheckCodeV1(Object.freeze({
        ...frozenWalletResult(digitPair[0]!.mnemonic),
        profileId: "DK-BIP39-24-v2",
      }) as unknown as WalletMnemonicResult),
      "INVALID_PROFILE",
    );
  });

  test("returns only the display string and wipes owned digest buffers", async () => {
    const subtleDigest = crypto.subtle.digest.bind(crypto.subtle);
    const returnedBuffers: ArrayBuffer[] = [];
    const digestSpy = jest.spyOn(crypto.subtle, "digest").mockImplementation(
      async (...argumentsForDigest: Parameters<SubtleCrypto["digest"]>) => {
        const buffer = await subtleDigest(...argumentsForDigest);
        returnedBuffers.push(buffer);
        return buffer;
      },
    );
    try {
      const result = await publicCheckCodeApi.deriveRecoveryProfileCheckCodeV1(
        frozenWalletResult(recoveryProfileCheckCodeTestVectors[0]!.mnemonic),
      );
      expect(result).toBe("521C-BB8C-FD07");
      expect(typeof result).toBe("string");
      expect(returnedBuffers).toHaveLength(2);
      for (const buffer of returnedBuffers) {
        expect(new Uint8Array(buffer)).toStrictEqual(new Uint8Array(32));
      }
    } finally {
      digestSpy.mockRestore();
    }
  });

  test("collapses checksum WebCrypto failures and wipes every created buffer", async () => {
    const mnemonic = recoveryProfileCheckCodeTestVectors[0]!.mnemonic;
    const cases = [
      "synchronous throw",
      "rejected promise",
      "hostile thenable",
      "zero-byte digest",
      "short digest",
      "non-buffer result",
    ] as const;

    for (const failureCase of cases) {
      const callerError = callerControlledOperationalError();
      const digestInputs: Uint8Array[] = [];
      let malformedDigest: Uint8Array | undefined;
      const digestSpy = jest.spyOn(crypto.subtle, "digest").mockImplementation((
        (_algorithm: AlgorithmIdentifier, input: BufferSource): unknown => {
          expect(input).toBeInstanceOf(Uint8Array);
          digestInputs.push(input as Uint8Array);
          switch (failureCase) {
            case "synchronous throw":
              throw callerError;
            case "rejected promise":
              return Promise.reject(callerError);
            case "hostile thenable":
              return Object.defineProperty({}, "then", {
                get: () => {
                  throw callerError;
                },
              }) as Promise<ArrayBuffer>;
            case "zero-byte digest":
              malformedDigest = new Uint8Array(0);
              return malformedDigest.buffer as ArrayBuffer;
            case "short digest":
              malformedDigest = new Uint8Array(6).fill(0xa5);
              return malformedDigest.buffer as ArrayBuffer;
            case "non-buffer result":
              malformedDigest = new Uint8Array(32).fill(0xa5);
              return malformedDigest as unknown as Promise<ArrayBuffer>;
          }
        }
      ) as unknown as SubtleCrypto["digest"]);
      try {
        await expectFreshOperationalError(
          validateCanonicalWalletMnemonic(mnemonic),
          callerError,
        );
        expect(digestInputs).toHaveLength(1);
        digestInputs.forEach(expectWiped);
        if (malformedDigest != null) expectWiped(malformedDigest);
      } finally {
        digestSpy.mockRestore();
      }
    }
  });

  test("collapses final WebCrypto failures and wipes mnemonic, entropy, preimage, and digests", async () => {
    const mnemonic = recoveryProfileCheckCodeTestVectors[0]!.mnemonic;
    const actualDigest = crypto.subtle.digest.bind(crypto.subtle);
    const cases = [
      "synchronous throw",
      "rejected promise",
      "hostile thenable",
      "zero-byte digest",
      "short digest",
      "non-buffer result",
    ] as const;

    for (const failureCase of cases) {
      const callerError = callerControlledOperationalError();
      const digestInputs: Uint8Array[] = [];
      const validDigestBuffers: ArrayBuffer[] = [];
      const encodedMnemonicBuffers: Uint8Array[] = [];
      let malformedDigest: Uint8Array | undefined;
      let callCount = 0;

      const originalEncode = TextEncoder.prototype.encode;
      const encodeSpy = jest.spyOn(TextEncoder.prototype, "encode").mockImplementation(
        function captureEncodedBytes(this: TextEncoder, input?: string): Uint8Array {
          const bytes = originalEncode.call(this, input);
          encodedMnemonicBuffers.push(bytes);
          return bytes;
        },
      );
      const digestSpy = jest.spyOn(crypto.subtle, "digest").mockImplementation((
        (_algorithm: AlgorithmIdentifier, input: BufferSource): unknown => {
          expect(input).toBeInstanceOf(Uint8Array);
          digestInputs.push(input as Uint8Array);
          callCount += 1;
          if (callCount === 1) {
            return actualDigest("SHA-256", input).then((buffer) => {
              validDigestBuffers.push(buffer);
              return buffer;
            });
          }
          switch (failureCase) {
            case "synchronous throw":
              throw callerError;
            case "rejected promise":
              return Promise.reject(callerError);
            case "hostile thenable":
              return Object.defineProperty({}, "then", {
                get: () => {
                  throw callerError;
                },
              }) as Promise<ArrayBuffer>;
            case "zero-byte digest":
              malformedDigest = new Uint8Array(0);
              return malformedDigest.buffer as ArrayBuffer;
            case "short digest":
              malformedDigest = new Uint8Array(6).fill(0xa5);
              return malformedDigest.buffer as ArrayBuffer;
            case "non-buffer result":
              malformedDigest = new Uint8Array(32).fill(0xa5);
              return malformedDigest as unknown as Promise<ArrayBuffer>;
          }
        }
      ) as unknown as SubtleCrypto["digest"]);
      try {
        await expectFreshOperationalError(
          publicCheckCodeApi.deriveRecoveryProfileCheckCodeV1(
            frozenWalletResult(mnemonic),
          ),
          callerError,
        );
        expect(callCount).toBe(2);
        expect(digestInputs).toHaveLength(2);
        expect(validDigestBuffers).toHaveLength(1);
        expect(encodedMnemonicBuffers).toHaveLength(1);
        digestInputs.forEach(expectWiped);
        validDigestBuffers.forEach((buffer) => expectWiped(new Uint8Array(buffer)));
        encodedMnemonicBuffers.forEach(expectWiped);
        if (malformedDigest != null) expectWiped(malformedDigest);
      } finally {
        digestSpy.mockRestore();
        encodeSpy.mockRestore();
      }
    }
  });

  test("keeps secret-adjacent and wallet interpretation inputs out of production code", () => {
    const productionDirectory = join(__dirname);
    const productionSource = typeScriptFilesBelow(productionDirectory)
      .filter((path) => !path.endsWith(".test.ts") && !path.endsWith("testVectors.ts"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(productionSource).not.toMatch(/derivedEntropyHex|secretBytes|seeded-crypto/i);
    expect(productionSource).not.toMatch(/\bpassphrase\b/i);
    expect(productionSource).not.toMatch(/\bbip32\b/i);
    expect(productionSource).not.toMatch(/\bnetwork\b/i);
    expect(productionSource).not.toMatch(/seeded-crypto|formats\/bip39\/bip39/);
    expect(readFileSync(join(productionDirectory, "index.ts"), "utf8")).toBe(
      "export { RECOVERY_PROFILE_CHECK_CODE_V1 } from \"./profile\";\n"
      + "export { deriveRecoveryProfileCheckCodeV1 } from \"./derive\";\n",
    );
  });
});
