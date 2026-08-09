import type { DiceKeyFaces, OrientedFace } from "../../dicekeys/DiceKey";
import { validateWalletDiceKeyFaces } from "../../wallet/DiceKeyBip39ProfileV1/validate";

export type WalletRecoveryCandidateStatus =
  | "exact"
  | "requires-confirmation";

export type WalletRecoveryRescanReason =
  | "incomplete"
  | "malformed"
  | "no-majority"
  | "ocr-ambiguous"
  | "unsupported-scanner-error"
  | "strict-wallet-invalid";

export interface WalletRecoveryScanCandidate {
  readonly status: WalletRecoveryCandidateStatus;
  readonly faces: DiceKeyFaces;
  readonly flaggedFaceIndexes: readonly number[];
}

export interface WalletRecoveryScanRequiresRescan {
  readonly status: "rescan";
  readonly reason: WalletRecoveryRescanReason;
  readonly flaggedFaceIndexes: readonly number[];
}

export type WalletRecoveryScanResult =
  | WalletRecoveryScanCandidate
  | WalletRecoveryScanRequiresRescan;

type ScannerErrorRecord = { readonly type?: unknown };

const allFaceIndexes = Object.freeze(
  Array.from({ length: 25 }, (_, index) => index),
);

const frozenIndexes = (indexes: readonly number[]): readonly number[] =>
  Object.freeze([...indexes]);

const rescan = (
  reason: WalletRecoveryRescanReason,
  flaggedFaceIndexes: readonly number[],
): WalletRecoveryScanRequiresRescan =>
  Object.freeze({
    status: "rescan" as const,
    reason,
    flaggedFaceIndexes: frozenIndexes(flaggedFaceIndexes),
  });

const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === "object" && candidate != null && !Array.isArray(candidate);

const sanitizeFaces = (faces: readonly Record<string, unknown>[]): OrientedFace[] =>
  faces.map(({ letter, digit, orientationAsLowercaseLetterTrbl }) => ({
    letter,
    digit,
    orientationAsLowercaseLetterTrbl,
  })) as OrientedFace[];

/**
 * Fail-closed wallet scan policy. It never returns third-party FaceRead
 * instances, scanner metadata, or captured face images.
 */
const evaluateWalletRecoveryScannerReadUnchecked = (
  candidate: unknown,
): WalletRecoveryScanResult => {
  if (!Array.isArray(candidate) || candidate.length !== 25) {
    return rescan("incomplete", allFaceIndexes);
  }

  const malformedIndexes: number[] = [];
  const noMajorityIndexes: number[] = [];
  const ocrAmbiguousIndexes: number[] = [];
  const unsupportedErrorIndexes: number[] = [];
  const errorIndexes: number[] = [];
  const faceRecords: Record<string, unknown>[] = [];

  candidate.forEach((face, index) => {
    if (!isRecord(face)) {
      malformedIndexes.push(index);
      return;
    }
    faceRecords.push(face);

    const { letter, digit, orientationAsLowercaseLetterTrbl, errors } = face;
    if (
      typeof orientationAsLowercaseLetterTrbl !== "string" ||
      !Array.isArray(errors)
    ) {
      malformedIndexes.push(index);
      return;
    }
    if (typeof letter !== "string" || typeof digit !== "string") {
      noMajorityIndexes.push(index);
    }

    errors.forEach((scannerError: unknown) => {
      if (!isRecord(scannerError) || typeof scannerError.type !== "string") {
        malformedIndexes.push(index);
        return;
      }
      const { type } = scannerError as ScannerErrorRecord;
      if (!errorIndexes.includes(index)) errorIndexes.push(index);
      if (type === "ocr-second-choice" || type === "ocr-mismatch") {
        if (!ocrAmbiguousIndexes.includes(index)) ocrAmbiguousIndexes.push(index);
      } else if (
        type === "no-majority-agreement" ||
        type === "no-undoverline-or-overline-with-which-to-locate-face"
      ) {
        if (!noMajorityIndexes.includes(index)) noMajorityIndexes.push(index);
      } else if (
        type !== "undoverline-bit-mismatch" &&
        type !== "undoverline-missing"
      ) {
        if (!unsupportedErrorIndexes.includes(index)) {
          unsupportedErrorIndexes.push(index);
        }
      }
    });
  });

  if (malformedIndexes.length > 0 || faceRecords.length !== 25) {
    return rescan("malformed", malformedIndexes);
  }
  if (noMajorityIndexes.length > 0) {
    return rescan("no-majority", noMajorityIndexes);
  }
  if (ocrAmbiguousIndexes.length > 0) {
    return rescan("ocr-ambiguous", ocrAmbiguousIndexes);
  }
  if (unsupportedErrorIndexes.length > 0) {
    return rescan("unsupported-scanner-error", unsupportedErrorIndexes);
  }

  let validatedFaces: DiceKeyFaces;
  try {
    validatedFaces = validateWalletDiceKeyFaces(sanitizeFaces(faceRecords));
  } catch {
    return rescan("strict-wallet-invalid", allFaceIndexes);
  }

  const faces = Object.freeze(
    validatedFaces.map((face) => Object.freeze({ ...face })),
  ) as DiceKeyFaces;
  const flaggedFaceIndexes = frozenIndexes(errorIndexes);
  return Object.freeze({
    status: errorIndexes.length === 0 ? "exact" : "requires-confirmation",
    faces,
    flaggedFaceIndexes,
  });
};

export const evaluateWalletRecoveryScannerRead = (
  candidate: unknown,
): WalletRecoveryScanResult => {
  try {
    return evaluateWalletRecoveryScannerReadUnchecked(candidate);
  } catch {
    return rescan("malformed", allFaceIndexes);
  }
};
