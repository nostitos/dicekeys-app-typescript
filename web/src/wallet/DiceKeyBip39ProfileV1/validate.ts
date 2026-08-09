import {
  DiceKeyFaces,
  FaceDigits,
  FaceLetters,
  FaceOrientationLettersTrbl,
  diceKeyFacesFromHumanReadableForm,
} from "../../dicekeys/DiceKey";
import type { DiceKeyInHumanReadableForm } from "../../dicekeys/DiceKey";

export const WalletDiceKeyValidationErrorCodes = [
  "NON_ASCII",
  "INVALID_LENGTH",
  "INVALID_LETTER",
  "INVALID_DIGIT",
  "INVALID_ORIENTATION",
  "DUPLICATE_OR_MISSING_LETTER",
] as const;

export type WalletDiceKeyValidationErrorCode =
  typeof WalletDiceKeyValidationErrorCodes[number];

export class WalletDiceKeyValidationError extends Error {
  readonly name = "WalletDiceKeyValidationError";

  constructor(
    readonly code: WalletDiceKeyValidationErrorCode,
    readonly position?: number,
  ) {
    super(
      position == null
        ? `DiceKey validation failed (${code})`
        : `DiceKey validation failed (${code} at face ${position})`,
    );
  }
}

const allowedLetters = new Set<string>(FaceLetters);
const allowedDigits = new Set<string>(FaceDigits);
const allowedOrientations = new Set<string>(FaceOrientationLettersTrbl);

const fail = (
  code: WalletDiceKeyValidationErrorCode,
  position?: number,
): never => {
  throw new WalletDiceKeyValidationError(code, position);
};

/**
 * Validate the profile's canonical 75-byte interchange form without using the
 * more permissive generic DiceKey validator.
 */
export const validateDiceKeyHumanReadableForm = (
  candidate: unknown,
): DiceKeyFaces => {
  if (typeof candidate !== "string") {
    throw new TypeError("DiceKey human-readable form must be a string");
  }

  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate.charCodeAt(index) > 0x7f) {
      fail("NON_ASCII");
    }
  }

  if (candidate.length !== 75) {
    fail("INVALID_LENGTH");
  }

  const letters = new Set<string>();
  for (let position = 0; position < 25; position += 1) {
    const offset = position * 3;
    const letter = candidate[offset]!;
    const digit = candidate[offset + 1]!;
    const orientation = candidate[offset + 2]!;

    if (!allowedLetters.has(letter)) fail("INVALID_LETTER", position);
    if (!allowedDigits.has(digit)) fail("INVALID_DIGIT", position);
    if (!allowedOrientations.has(orientation)) {
      fail("INVALID_ORIENTATION", position);
    }
    letters.add(letter);
  }

  if (letters.size !== FaceLetters.length) {
    fail("DUPLICATE_OR_MISSING_LETTER");
  }

  try {
    return diceKeyFacesFromHumanReadableForm(
      candidate as DiceKeyInHumanReadableForm,
    );
  } catch {
    // This branch can only represent disagreement with the already-completed
    // strict checks. Keep the failure closed and do not expose input contents.
    throw new TypeError("Validated DiceKey could not be parsed");
  }
};

/**
 * Runtime-check the public faces input, serialize it through the application's
 * established HRF implementation, and return a clean parsed tuple.
 */
export const validateWalletDiceKeyFaces = (candidate: unknown): DiceKeyFaces => {
  if (!Array.isArray(candidate)) {
    throw new TypeError("DiceKey faces must be an array");
  }
  if (candidate.length !== 25) {
    fail("INVALID_LENGTH");
  }

  const cleanFaceFields: Array<{
    readonly letter: string;
    readonly digit: string;
    readonly orientationAsLowercaseLetterTrbl: string;
  }> = [];
  for (let position = 0; position < candidate.length; position += 1) {
    const face = candidate[position];
    if (face == null || typeof face !== "object" || Array.isArray(face)) {
      throw new TypeError("Every DiceKey face must be an object");
    }

    const readRequiredField = (
      fieldName: "letter" | "digit" | "orientationAsLowercaseLetterTrbl",
    ): string => {
      let descriptor: PropertyDescriptor | undefined;
      try {
        if (!Object.hasOwn(face, fieldName)) {
          throw new TypeError("DiceKey face is missing a required field");
        }
        descriptor = Object.getOwnPropertyDescriptor(face, fieldName);
      } catch {
        throw new TypeError("DiceKey face fields could not be inspected");
      }
      if (descriptor == null || !("value" in descriptor)) {
        throw new TypeError("DiceKey face fields must be data properties");
      }
      if (typeof descriptor.value !== "string" || descriptor.value.length !== 1) {
        throw new TypeError("DiceKey face fields must be single characters");
      }
      return descriptor.value;
    };

    // Read in normative face-field order without invoking accessors or coercion.
    const letter = readRequiredField("letter");
    const digit = readRequiredField("digit");
    const orientationAsLowercaseLetterTrbl = readRequiredField(
      "orientationAsLowercaseLetterTrbl",
    );
    cleanFaceFields.push({ letter, digit, orientationAsLowercaseLetterTrbl });
  }

  const humanReadableForm = cleanFaceFields
    .map(({ letter, digit, orientationAsLowercaseLetterTrbl }) =>
      `${letter}${digit}${orientationAsLowercaseLetterTrbl}`)
    .join("") as DiceKeyInHumanReadableForm;
  return validateDiceKeyHumanReadableForm(humanReadableForm);
};
