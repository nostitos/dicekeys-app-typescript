import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { SeededCryptoModulePromise } from "@dicekeys/seeded-crypto-js";

import {
  DiceKeyFaces,
  DiceKeyWithoutKeyId,
  diceKeyFacesToSeedString,
} from "../../dicekeys/DiceKey";
import {
  diceKeyToBip39String,
} from "../../formats/bip39/bip39";
import { english } from "../../formats/bip39/word-lists/english";
import * as publicProfileApi from ".";
import { deriveWalletMnemonicV1WithEntropyForTests } from "./derive";
import { DK_BIP39_24_V1 } from "./profile";
import {
  walletProfileAcquisitionPolicyCases,
  walletProfileEnglishWordListProvenance,
  walletProfileInvalidTestCases,
  walletProfileTestVectorProfile,
  walletProfileTestVectors,
} from "./testVectors";
import {
  WalletDiceKeyValidationError,
  WalletDiceKeyValidationErrorCode,
  WalletDiceKeyValidationErrorCodes,
  validateDiceKeyHumanReadableForm,
  validateWalletDiceKeyFaces,
} from "./validate";

jest.setTimeout(30_000);

const webRoot = existsSync(join(process.cwd(), "src", "index.html"))
  ? process.cwd()
  : resolve(process.cwd(), "web");

const bytesToHex = (bytes: Uint8Array | Uint8ClampedArray): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const replaceCharacterAt = (
  value: string,
  index: number,
  replacement: string,
): string => `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;

const expectValidationCode = (
  candidate: unknown,
  expectedCode: WalletDiceKeyValidationErrorCode,
  expectedPosition?: number,
): void => {
  try {
    validateDiceKeyHumanReadableForm(candidate);
    throw new Error("Expected strict DiceKey validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(WalletDiceKeyValidationError);
    const validationError = error as WalletDiceKeyValidationError;
    expect(validationError.code).toBe(expectedCode);
    if (expectedPosition != null) {
      expect(validationError.position).toBe(expectedPosition);
    }
    if (typeof candidate === "string") {
      expect(validationError.message).not.toContain(candidate);
    }
  }
};

const mnemonicToEntropyAndChecksum = (
  words: readonly string[],
): { readonly entropy: Uint8ClampedArray; readonly checksumByte: number } => {
  const indexes = words.map((word) => english.indexOf(word));
  expect(indexes.every((index) => index >= 0)).toBe(true);
  const bits = indexes
    .map((index) => index.toString(2).padStart(11, "0"))
    .join("");
  expect(bits).toHaveLength(264);

  const entropy = new Uint8ClampedArray(32);
  for (let index = 0; index < entropy.length; index += 1) {
    entropy[index] = Number.parseInt(bits.slice(index * 8, (index + 1) * 8), 2);
  }
  return {
    entropy,
    checksumByte: Number.parseInt(bits.slice(256), 2),
  };
};

const hasValidMnemonicChecksum = (words: readonly string[]): boolean => {
  if (words.length !== 24) return false;
  const indexes = words.map((word) => english.indexOf(word));
  if (indexes.some((index) => index < 0)) return false;
  const bits = indexes
    .map((index) => index.toString(2).padStart(11, "0"))
    .join("");
  const entropy = new Uint8ClampedArray(32);
  for (let index = 0; index < entropy.length; index += 1) {
    entropy[index] = Number.parseInt(bits.slice(index * 8, (index + 1) * 8), 2);
  }
  const checksumByte = Number.parseInt(bits.slice(256), 2);
  return createHash("sha256").update(entropy).digest()[0] === checksumByte;
};

const hammingDistanceOfHex = (left: string, right: string): number => {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  expect(leftBytes).toHaveLength(rightBytes.length);
  let distance = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    let difference = leftBytes[index]! ^ rightBytes[index]!;
    while (difference !== 0) {
      distance += difference & 1;
      difference >>>= 1;
    }
  }
  return distance;
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

describe("DK-BIP39-24-v1 wallet derivation profile", () => {
  test("freezes the exact profile metadata and recipe bytes", () => {
    expect(Object.keys(DK_BIP39_24_V1)).toStrictEqual([
      "id",
      "recipe",
      "wordCount",
    ]);
    expect(DK_BIP39_24_V1).toStrictEqual({
      id: "DK-BIP39-24-v1",
      recipe: '{"purpose":"wallet"}',
      wordCount: 24,
    });
    expect(Object.isFrozen(DK_BIP39_24_V1)).toBe(true);
    expect(Buffer.from(DK_BIP39_24_V1.recipe, "utf8").toString("hex")).toBe(
      "7b22707572706f7365223a2277616c6c6574227d",
    );
    expect("verificationFingerprint" in DK_BIP39_24_V1).toBe(false);
  });

  test("exposes only the frozen profile and one-argument derivation function", async () => {
    expect(Object.keys(publicProfileApi).sort()).toStrictEqual([
      "DK_BIP39_24_V1",
      "deriveWalletMnemonicV1",
    ]);
    expect(publicProfileApi.deriveWalletMnemonicV1.length).toBe(1);

    const faces = validateDiceKeyHumanReadableForm(
      walletProfileTestVectors[0]!.diceKeyHumanReadableForm,
    );
    const callWithOverride = publicProfileApi.deriveWalletMnemonicV1 as unknown as (
      candidateFaces: DiceKeyFaces,
      options: unknown,
    ) => Promise<unknown>;
    await expect(callWithOverride(faces, { recipe: "{}" })).rejects.toBeInstanceOf(
      TypeError,
    );

    if (false) {
      // @ts-expect-error The public profile deliberately has no recipe/mode argument.
      void publicProfileApi.deriveWalletMnemonicV1(faces, { recipe: "{}" });
    }
  });

  test("loads the canonical 27-vector and 108-rotation corpus with zipped IDs", () => {
    expect(walletProfileTestVectorProfile).toBe(DK_BIP39_24_V1.id);
    expect(walletProfileTestVectors).toHaveLength(27);
    expect(walletProfileTestVectors.flatMap((vector) => vector.allFourRotations)).toHaveLength(
      108,
    );
    expect(walletProfileTestVectors.map(({ id }) => id)).toStrictEqual(
      Array.from({ length: 27 }, (_, index) => `V${String(index + 1).padStart(2, "0")}`),
    );
    expect(new Set(walletProfileTestVectors.map(({ id }) => id)).size).toBe(27);
    expect(walletProfileTestVectors.every(Object.isFrozen)).toBe(true);
  });

  test("matches entropy, checksum, mnemonic, and canonical rotation for all 108 derivations", async () => {
    let derivationCount = 0;
    for (const vector of walletProfileTestVectors) {
      expect(vector.profile).toBe(DK_BIP39_24_V1.id);
      expect(vector.recipeUtf8Hex).toBe(
        Buffer.from(DK_BIP39_24_V1.recipe, "utf8").toString("hex"),
      );
      for (const humanReadableForm of vector.allFourRotations) {
        const faces = validateDiceKeyHumanReadableForm(humanReadableForm);
        expect(diceKeyFacesToSeedString(faces)).toBe(vector.canonicalSeedString);

        const result = await deriveWalletMnemonicV1WithEntropyForTests(faces);
        try {
          expect(result.profileId).toBe(DK_BIP39_24_V1.id);
          expect(bytesToHex(result.entropy)).toBe(vector.derivedEntropyHex);
          expect(result.mnemonic).toBe(vector.mnemonic);
          expect(result.words).toStrictEqual(vector.mnemonic.split(" "));
          expect(result.words).toHaveLength(24);
          expect(Object.isFrozen(result)).toBe(true);
          expect(Object.isFrozen(result.words)).toBe(true);

          const decoded = mnemonicToEntropyAndChecksum(result.words);
          expect(bytesToHex(decoded.entropy)).toBe(vector.derivedEntropyHex);
          expect(decoded.checksumByte).toBe(
            createHash("sha256").update(decoded.entropy).digest()[0],
          );
        } finally {
          result.entropy.fill(0);
        }
        derivationCount += 1;
      }
    }
    expect(derivationCount).toBe(108);
  });

  test("returns only the mnemonic and clears every extracted entropy buffer", async () => {
    const vector = walletProfileTestVectors[0]!;
    const faces = validateDiceKeyHumanReadableForm(
      vector.diceKeyHumanReadableForm,
    );
    const fillSpy = jest.spyOn(Uint8ClampedArray.prototype, "fill");
    try {
      const result = await publicProfileApi.deriveWalletMnemonicV1(faces);
      expect(Object.keys(result)).toStrictEqual(["profileId", "words", "mnemonic"]);
      expect(result.mnemonic).toBe(vector.mnemonic);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.words)).toBe(true);
      expect("entropy" in result).toBe(false);
      expect("canonicalSeed" in result).toBe(false);
      expect("recipe" in result).toBe(false);
      expect("verificationFingerprint" in result).toBe(false);
      expect(fillSpy.mock.calls.some(([value]) => value === 0)).toBe(true);
    } finally {
      fillSpy.mockRestore();
    }

    const seededCryptoModule = await SeededCryptoModulePromise;
    type SecretResult = ReturnType<
      typeof seededCryptoModule.Secret.deriveFromSeed
    >;
    const deriveSpy = jest.spyOn(seededCryptoModule.Secret, "deriveFromSeed");
    try {
      const extractedBytes = new Uint8Array(
        Buffer.from(vector.derivedEntropyHex, "hex"),
      );
      const expectedOwnedEntropy = new Uint8ClampedArray(extractedBytes);
      const extractedBytesGetter = jest.fn(() => extractedBytes);
      const deleteSecret = jest.fn(() => {
        expect(extractedBytes).toStrictEqual(new Uint8Array(32));
      });
      const successfulSecret = {
        delete: deleteSecret,
      } as unknown as SecretResult;
      Object.defineProperty(successfulSecret, "secretBytes", {
        configurable: true,
        enumerable: true,
        get: extractedBytesGetter,
      });
      deriveSpy.mockReturnValue(successfulSecret);
      const internalResult = await deriveWalletMnemonicV1WithEntropyForTests(faces);
      try {
        expect(internalResult.entropy).toStrictEqual(expectedOwnedEntropy);
        expect(internalResult.mnemonic).toBe(vector.mnemonic);
        expect(extractedBytes).toStrictEqual(new Uint8Array(32));
        expect(extractedBytesGetter).toHaveBeenCalledTimes(1);
        expect(deleteSecret).toHaveBeenCalledTimes(1);
      } finally {
        internalResult.entropy.fill(0);
      }

      const deleteFailure = new Error("synthetic native delete failure");
      const extractedBeforeDeleteFailure = new Uint8Array(32).fill(0x5a);
      const failingDelete = jest.fn(() => {
        expect(extractedBeforeDeleteFailure).toStrictEqual(new Uint8Array(32));
        throw deleteFailure;
      });
      deriveSpy.mockReturnValue({
        secretBytes: extractedBeforeDeleteFailure,
        delete: failingDelete,
      } as unknown as SecretResult);
      const ownedFillSpy = jest.spyOn(Uint8ClampedArray.prototype, "fill");
      try {
        await expect(
          deriveWalletMnemonicV1WithEntropyForTests(faces),
        ).rejects.toBe(deleteFailure);
        const ownedWipeCallIndex = ownedFillSpy.mock.contexts.findIndex(
          (context, index) =>
            context instanceof Uint8ClampedArray &&
            ownedFillSpy.mock.calls[index]?.[0] === 0,
        );
        expect(ownedWipeCallIndex).toBeGreaterThanOrEqual(0);
        const wipedOwnedEntropy = ownedFillSpy.mock.contexts[
          ownedWipeCallIndex
        ] as Uint8ClampedArray;
        expect(wipedOwnedEntropy).toStrictEqual(new Uint8ClampedArray(32));
      } finally {
        ownedFillSpy.mockRestore();
      }
      expect(extractedBeforeDeleteFailure).toStrictEqual(new Uint8Array(32));
      expect(failingDelete).toHaveBeenCalledTimes(1);

      const getterFailure = new Error("synthetic secret-byte getter failure");
      const laterCleanupFailure = new Error("synthetic later cleanup failure");
      const failingGetter = jest.fn(() => {
        throw getterFailure;
      });
      const failingGetterDelete = jest.fn(() => {
        throw laterCleanupFailure;
      });
      const getterFailureSecret = {
        delete: failingGetterDelete,
      } as unknown as SecretResult;
      Object.defineProperty(getterFailureSecret, "secretBytes", {
        configurable: true,
        enumerable: true,
        get: failingGetter,
      });
      deriveSpy.mockReturnValue(getterFailureSecret);
      await expect(
        deriveWalletMnemonicV1WithEntropyForTests(faces),
      ).rejects.toBe(getterFailure);
      expect(failingGetter).toHaveBeenCalledTimes(1);
      expect(failingGetterDelete).toHaveBeenCalledTimes(1);

      const numericExceptionPointer = 1234;
      const exceptionMessageSpy = jest
        .spyOn(seededCryptoModule, "getExceptionMessage")
        .mockReturnValue("synthetic translated WASM failure");
      try {
        deriveSpy.mockImplementation(() => {
          throw numericExceptionPointer;
        });
        await expect(
          deriveWalletMnemonicV1WithEntropyForTests(faces),
        ).rejects.toThrow("synthetic translated WASM failure");
        expect(exceptionMessageSpy).toHaveBeenCalledWith(numericExceptionPointer);
      } finally {
        exceptionMessageSpy.mockRestore();
      }
    } finally {
      deriveSpy.mockRestore();
    }
  });

  test("keeps recipe whitespace byte-sensitive without a public override", async () => {
    const vector = walletProfileTestVectors[0]!;
    const seededCryptoModule = await SeededCryptoModulePromise;
    const alteredRecipe = '{"purpose": "wallet"}';
    const alteredSecret = seededCryptoModule.Secret.deriveFromSeed(
      vector.canonicalSeedString,
      alteredRecipe,
    );
    let alteredSecretBytes: Uint8Array | undefined;
    try {
      alteredSecretBytes = alteredSecret.secretBytes;
      const alteredEntropyHex = bytesToHex(alteredSecretBytes);
      expect(alteredEntropyHex).toBe(
        "c41dceddd3480f658e6ede05c2bb207d5dade74cf441da502ea64353c638be5d",
      );
      expect(alteredEntropyHex).not.toBe(vector.derivedEntropyHex);
      expect(Buffer.from(alteredRecipe, "utf8")).not.toStrictEqual(
        Buffer.from(DK_BIP39_24_V1.recipe, "utf8"),
      );
    } finally {
      alteredSecretBytes?.fill(0);
      alteredSecret.delete();
    }
  });

  test("pins the 2048-word English BIP39 list structure and hash", () => {
    const serialized = `${english.join("\n")}\n`;
    expect(english).toHaveLength(walletProfileEnglishWordListProvenance.entryCount);
    expect(new Set(english).size).toBe(2048);
    expect(english.every((word) => /^[a-z]+$/.test(word))).toBe(true);
    expect(
      english.every((word, index) => index === 0 || english[index - 1]! < word),
    ).toBe(true);
    expect(Buffer.byteLength(serialized, "ascii")).toBe(
      walletProfileEnglishWordListProvenance.lfTerminatedAsciiByteLength,
    );
    expect(createHash("sha256").update(serialized, "ascii").digest("hex")).toBe(
      walletProfileEnglishWordListProvenance.lfTerminatedAsciiSha256,
    );
  });

  test("rejects a valid-word mnemonic with one checksum bit flipped", () => {
    const words = walletProfileTestVectors[0]!.mnemonic.split(" ");
    expect(hasValidMnemonicChecksum(words)).toBe(true);

    const finalWordIndex = english.indexOf(words[23]!);
    expect(finalWordIndex).toBeGreaterThanOrEqual(0);
    const checksumBitFlippedWords = [...words];
    checksumBitFlippedWords[23] = english[finalWordIndex ^ 1]!;

    expect(english).toContain(checksumBitFlippedWords[23]);
    expect(checksumBitFlippedWords).not.toStrictEqual(words);
    expect(
      bytesToHex(mnemonicToEntropyAndChecksum(checksumBitFlippedWords).entropy),
    ).toBe(walletProfileTestVectors[0]!.derivedEntropyHex);
    expect(hasValidMnemonicChecksum(checksumBitFlippedWords)).toBe(false);
  });

  test("rejects all 13 invalid vectors with the frozen error code", () => {
    expect(walletProfileInvalidTestCases).toHaveLength(13);
    for (const testCase of walletProfileInvalidTestCases) {
      expectValidationCode(
        testCase.diceKeyHumanReadableForm,
        testCase.expectedErrorCode as WalletDiceKeyValidationErrorCode,
      );
    }
  });

  test("applies the normative compound-failure precedence", () => {
    const valid = walletProfileAcquisitionPolicyCases[0]!
      .candidateHumanReadableForms[0]!;
    expectValidationCode(`Å${valid}`, "NON_ASCII");
    expectValidationCode(`-${valid}`, "INVALID_LENGTH");

    let candidate = replaceCharacterAt(valid, 0, "-");
    candidate = replaceCharacterAt(candidate, 1, "0");
    candidate = replaceCharacterAt(candidate, 2, "?");
    expectValidationCode(candidate, "INVALID_LETTER", 0);

    candidate = replaceCharacterAt(valid, 1, "0");
    candidate = replaceCharacterAt(candidate, 2, "?");
    expectValidationCode(candidate, "INVALID_DIGIT", 0);

    candidate = replaceCharacterAt(valid, 2, "?");
    candidate = replaceCharacterAt(candidate, 3, "-");
    expectValidationCode(candidate, "INVALID_ORIENTATION", 0);

    candidate = replaceCharacterAt(valid, 3, "A");
    candidate = replaceCharacterAt(candidate, 74, "?");
    expectValidationCode(candidate, "INVALID_ORIENTATION", 24);
  });

  test("fails closed on malformed runtime faces and unknown orientation", async () => {
    const vector = walletProfileTestVectors[0]!;
    const valid = validateDiceKeyHumanReadableForm(
      vector.diceKeyHumanReadableForm,
    );
    const cloneValidFaces = (): unknown[] => valid.map((face) => ({ ...face }));
    const seededCryptoModule = await SeededCryptoModulePromise;
    const deriveSpy = jest.spyOn(seededCryptoModule.Secret, "deriveFromSeed");
    try {
      await expect(
        publicProfileApi.deriveWalletMnemonicV1({} as DiceKeyFaces),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        publicProfileApi.deriveWalletMnemonicV1([] as unknown as DiceKeyFaces),
      ).rejects.toMatchObject({ code: "INVALID_LENGTH" });
      await expect(
        publicProfileApi.deriveWalletMnemonicV1([
          ...cloneValidFaces(),
          {
            letter: "",
            digit: "",
            orientationAsLowercaseLetterTrbl: "",
          },
        ] as unknown as DiceKeyFaces),
      ).rejects.toMatchObject({ code: "INVALID_LENGTH" });
      await expect(
        publicProfileApi.deriveWalletMnemonicV1(
          [{
            letter: vector.diceKeyHumanReadableForm,
            digit: "",
            orientationAsLowercaseLetterTrbl: "",
          }] as unknown as DiceKeyFaces,
        ),
      ).rejects.toMatchObject({ code: "INVALID_LENGTH" });
      await expect(
        publicProfileApi.deriveWalletMnemonicV1(
          Array.from({ length: 25 }, () => null) as unknown as DiceKeyFaces,
        ),
      ).rejects.toBeInstanceOf(TypeError);

      const arrayValuedFace = cloneValidFaces();
      arrayValuedFace[0] = Object.assign([], valid[0]);
      await expect(
        publicProfileApi.deriveWalletMnemonicV1(
          arrayValuedFace as unknown as DiceKeyFaces,
        ),
      ).rejects.toBeInstanceOf(TypeError);

      const coercionFunction = jest.fn(() => valid[0].letter);
      const coercibleField = cloneValidFaces();
      coercibleField[0] = {
        ...valid[0],
        letter: { toString: coercionFunction },
      };
      await expect(
        publicProfileApi.deriveWalletMnemonicV1(
          coercibleField as unknown as DiceKeyFaces,
        ),
      ).rejects.toBeInstanceOf(TypeError);
      expect(coercionFunction).not.toHaveBeenCalled();

      const numericDigit = cloneValidFaces();
      numericDigit[0] = {
        ...valid[0],
        digit: 1,
      };
      await expect(
        publicProfileApi.deriveWalletMnemonicV1(
          numericDigit as unknown as DiceKeyFaces,
        ),
      ).rejects.toBeInstanceOf(TypeError);

      const crossFieldBoundarySmuggle = cloneValidFaces();
      crossFieldBoundarySmuggle[0] = {
        ...valid[0],
        letter: `${valid[0].letter}${valid[0].digit}`,
        digit: "",
      };
      await expect(
        publicProfileApi.deriveWalletMnemonicV1(
          crossFieldBoundarySmuggle as unknown as DiceKeyFaces,
        ),
      ).rejects.toBeInstanceOf(TypeError);

      const missingField = cloneValidFaces();
      missingField[0] = {
        letter: valid[0].letter,
        orientationAsLowercaseLetterTrbl:
          valid[0].orientationAsLowercaseLetterTrbl,
      };
      await expect(
        publicProfileApi.deriveWalletMnemonicV1(
          missingField as unknown as DiceKeyFaces,
        ),
      ).rejects.toBeInstanceOf(TypeError);

      const inheritedFields = cloneValidFaces();
      inheritedFields[0] = Object.create(valid[0]) as object;
      await expect(
        publicProfileApi.deriveWalletMnemonicV1(
          inheritedFields as unknown as DiceKeyFaces,
        ),
      ).rejects.toBeInstanceOf(TypeError);

      const accessorFunction = jest.fn(() => valid[0].letter);
      const accessorFace: Record<string, unknown> = {
        digit: valid[0].digit,
        orientationAsLowercaseLetterTrbl:
          valid[0].orientationAsLowercaseLetterTrbl,
      };
      Object.defineProperty(accessorFace, "letter", {
        configurable: true,
        enumerable: true,
        get: accessorFunction,
      });
      const accessorFields = cloneValidFaces();
      accessorFields[0] = accessorFace;
      await expect(
        publicProfileApi.deriveWalletMnemonicV1(
          accessorFields as unknown as DiceKeyFaces,
        ),
      ).rejects.toBeInstanceOf(TypeError);
      expect(accessorFunction).not.toHaveBeenCalled();

      const unknownOrientation = valid.map((face, index) => ({
        ...face,
        ...(index === 0 ? { orientationAsLowercaseLetterTrbl: "?" } : {}),
      })) as unknown as DiceKeyFaces;
      await expect(
        publicProfileApi.deriveWalletMnemonicV1(unknownOrientation),
      ).rejects.toMatchObject({ code: "INVALID_ORIENTATION", position: 0 });

      const duplicateLetter = valid.map((face, index) => ({
        ...face,
        ...(index === 1 ? { letter: valid[0].letter } : {}),
      })) as unknown as DiceKeyFaces;
      await expect(
        publicProfileApi.deriveWalletMnemonicV1(duplicateLetter),
      ).rejects.toMatchObject({ code: "DUPLICATE_OR_MISSING_LETTER" });

      expect(deriveSpy).not.toHaveBeenCalled();
    } finally {
      deriveSpy.mockRestore();
    }

    const facesWithExtraMetadata = valid.map((face, position) => ({
      ...face,
      scannerConfidence: 0.99,
      scannerPosition: position,
    })) as unknown as DiceKeyFaces;
    const sanitizedFaces = validateWalletDiceKeyFaces(facesWithExtraMetadata);
    expect(sanitizedFaces).toStrictEqual(valid);
    expect("scannerConfidence" in sanitizedFaces[0]).toBe(false);
    await expect(
      publicProfileApi.deriveWalletMnemonicV1(facesWithExtraMetadata),
    ).resolves.toMatchObject({ mnemonic: vector.mnemonic });
  });

  test("leaves P01 ambiguity at the acquisition boundary", async () => {
    const policyCase = walletProfileAcquisitionPolicyCases[0]!;
    expect(policyCase.id).toBe("P01");
    expect(policyCase.expectedAcquisitionState).toBe("AMBIGUOUS_SCAN");
    expect(policyCase.humanReadableFormProduced).toBe(false);
    expect(policyCase.profileDerivationInvoked).toBe(false);
    expect(WalletDiceKeyValidationErrorCodes).not.toContain("AMBIGUOUS_SCAN");
    expect(policyCase.candidateHumanReadableForms).toHaveLength(2);
    for (const candidate of policyCase.candidateHumanReadableForms) {
      expect(validateDiceKeyHumanReadableForm(candidate)).toHaveLength(25);
    }

    const seededCryptoModule = await SeededCryptoModulePromise;
    const deriveSpy = jest.spyOn(seededCryptoModule.Secret, "deriveFromSeed");
    try {
      await expect(
        publicProfileApi.deriveWalletMnemonicV1(
          policyCase as unknown as DiceKeyFaces,
        ),
      ).rejects.toBeInstanceOf(TypeError);
      expect(deriveSpy).not.toHaveBeenCalled();
    } finally {
      deriveSpy.mockRestore();
    }
  });

  test("preserves the two fixed one-face sensitivity pairs", () => {
    const digitLeft = walletProfileTestVectors.find(({ id }) => id === "V23")!;
    const digitRight = walletProfileTestVectors.find(({ id }) => id === "V24")!;
    const orientationLeft = walletProfileTestVectors.find(({ id }) => id === "V25")!;
    const orientationRight = walletProfileTestVectors.find(({ id }) => id === "V26")!;

    const differingFaces = (left: string, right: string): readonly number[] =>
      Array.from({ length: 25 }, (_, index) => index).filter(
        (index) => left.slice(index * 3, index * 3 + 3) !==
          right.slice(index * 3, index * 3 + 3),
      );

    expect(differingFaces(
      digitLeft.diceKeyHumanReadableForm,
      digitRight.diceKeyHumanReadableForm,
    )).toStrictEqual([12]);
    expect(digitLeft.diceKeyHumanReadableForm.slice(36, 39)).toBe("M1t");
    expect(digitRight.diceKeyHumanReadableForm.slice(36, 39)).toBe("M6t");
    expect(hammingDistanceOfHex(
      digitLeft.derivedEntropyHex,
      digitRight.derivedEntropyHex,
    )).toBe(124);
    expect(digitLeft.mnemonic.split(" ").filter(
      (word, index) => word !== digitRight.mnemonic.split(" ")[index],
    )).toHaveLength(24);

    expect(differingFaces(
      orientationLeft.diceKeyHumanReadableForm,
      orientationRight.diceKeyHumanReadableForm,
    )).toStrictEqual([7]);
    expect(orientationLeft.diceKeyHumanReadableForm.slice(21, 24)).toBe("O2b");
    expect(orientationRight.diceKeyHumanReadableForm.slice(21, 24)).toBe("O2t");
    expect(hammingDistanceOfHex(
      orientationLeft.derivedEntropyHex,
      orientationRight.derivedEntropyHex,
    )).toBe(132);
    expect(orientationLeft.mnemonic.split(" ").filter(
      (word, index) => word !== orientationRight.mnemonic.split(" ")[index],
    )).toHaveLength(24);
  });

  test("keeps the legacy reversible layout output separate from wallet recovery", async () => {
    const vector = walletProfileTestVectors[0]!;
    const faces = validateDiceKeyHumanReadableForm(vector.diceKeyHumanReadableForm);
    const legacyMnemonic = await diceKeyToBip39String(
      new DiceKeyWithoutKeyId(faces),
    );
    const walletResult = await publicProfileApi.deriveWalletMnemonicV1(faces);
    expect(legacyMnemonic).not.toBe(walletResult.mnemonic);
    expect(walletResult.mnemonic).toBe(vector.mnemonic);
  });

  test("keeps reversible codecs and test seams outside production imports and exports", () => {
    const forbiddenLegacySymbols = [
      "bip39StringToDiceKey",
      "diceKeyToBip39WordArray",
      "diceKeyToBip39String",
    ];
    for (const symbol of forbiddenLegacySymbols) {
      expect(symbol in publicProfileApi).toBe(false);
    }
    expect("deriveWalletMnemonicV1WithEntropyForTests" in publicProfileApi).toBe(false);
    expect("validateDiceKeyHumanReadableForm" in publicProfileApi).toBe(false);
    expect("walletProfileTestVectors" in publicProfileApi).toBe(false);

    const productionFiles = typeScriptFilesBelow(join(webRoot, "src"))
      .filter((path) => !/\.test\.tsx?$/.test(path));
    for (const path of productionFiles) {
      const source = readFileSync(path, "utf8");
      if (!path.endsWith(join("formats", "bip39", "bip39.ts"))) {
        const importStatements = source.match(
          /import[\s\S]*?from\s+["'][^"']+["'];?/g,
        ) ?? [];
        for (const statement of importStatements) {
          for (const symbol of forbiddenLegacySymbols) {
            expect(statement).not.toMatch(new RegExp(`\\b${symbol}\\b`));
          }
        }
      }
      if (!path.endsWith(join("DiceKeyBip39ProfileV1", "testVectors.ts"))) {
        expect(source).not.toMatch(/from\s+["'][^"']*testVectors["']/);
      }
    }
  });

  test("derives identically in isolated browser and Electron build-mode loads", async () => {
    const buildFlagName = "VITE_SET_APP_RUNNING_IN_ELECTRON";
    const buildFlagGlobal = globalThis as typeof globalThis & {
      VITE_SET_APP_RUNNING_IN_ELECTRON?: boolean;
    };
    const originalBuildFlagDescriptor = Object.getOwnPropertyDescriptor(
      buildFlagGlobal,
      buildFlagName,
    );
    const vector = walletProfileTestVectors[0]!;

    const loadAndDeriveInBuildMode = async (runningInElectron: boolean) => {
      Object.defineProperty(buildFlagGlobal, buildFlagName, {
        configurable: true,
        enumerable: false,
        value: runningInElectron,
        writable: true,
      });

      let observedBuildMode: boolean | undefined;
      let result: Awaited<
        ReturnType<typeof publicProfileApi.deriveWalletMnemonicV1>
      > | undefined;
      await jest.isolateModulesAsync(async () => {
        const buildConstants = await import("../../vite-build-constants");
        const isolatedProfile = await import(".");
        const isolatedValidator = await import("./validate");
        observedBuildMode = buildConstants.RUNNING_IN_ELECTRON;
        const faces = isolatedValidator.validateDiceKeyHumanReadableForm(
          vector.diceKeyHumanReadableForm,
        );
        result = await isolatedProfile.deriveWalletMnemonicV1(faces);
      });
      if (observedBuildMode == null || result == null) {
        throw new Error("Isolated build-mode derivation did not complete");
      }
      return { observedBuildMode, result };
    };

    try {
      const browserMode = await loadAndDeriveInBuildMode(false);
      const electronMode = await loadAndDeriveInBuildMode(true);
      expect(browserMode.observedBuildMode).toBe(false);
      expect(electronMode.observedBuildMode).toBe(true);
      expect(browserMode.result).toStrictEqual({
        profileId: DK_BIP39_24_V1.id,
        words: vector.mnemonic.split(" "),
        mnemonic: vector.mnemonic,
      });
      expect(electronMode.result).toStrictEqual(browserMode.result);
    } finally {
      jest.resetModules();
      if (originalBuildFlagDescriptor == null) {
        delete buildFlagGlobal.VITE_SET_APP_RUNNING_IN_ELECTRON;
      } else {
        Object.defineProperty(
          buildFlagGlobal,
          buildFlagName,
          originalBuildFlagDescriptor,
        );
      }
    }

    // This proves same-module build-mode parity. Browser/Electron runtime E2E
    // execution remains a later acceptance gate.
    for (const name of ["profile.ts", "validate.ts", "derive.ts", "index.ts"]) {
      const source = readFileSync(
        join(webRoot, "src", "wallet", "DiceKeyBip39ProfileV1", name),
        "utf8",
      );
      expect(source).not.toMatch(
        /(?:from\s+["'][^"']*(?:electron|IElectronBridge)|process\.platform|window\.|navigator\.)/i,
      );
    }
  });
});
