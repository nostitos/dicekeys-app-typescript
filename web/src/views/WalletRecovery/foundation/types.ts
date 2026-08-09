import type {
  DiceKeyFaces,
  OrientedFace,
} from "../../../dicekeys/DiceKey";
import type { WalletMnemonicResult } from "../../../wallet/DiceKeyBip39ProfileV1";

export const PHYSICAL_FACE_POSITIONS = Object.freeze([
  1, 2, 3, 4, 5,
  6, 7, 8, 9, 10,
  11, 12, 13, 14, 15,
  16, 17, 18, 19, 20,
  21, 22, 23, 24, 25,
] as const);

export type PhysicalFacePosition = typeof PHYSICAL_FACE_POSITIONS[number];

export type GridCoordinate = 1 | 2 | 3 | 4 | 5;

export const RECOVERY_WORD_POSITIONS = Object.freeze([
  1, 2, 3, 4, 5, 6,
  7, 8, 9, 10, 11, 12,
  13, 14, 15, 16, 17, 18,
  19, 20, 21, 22, 23, 24,
] as const);

export type RecoveryWordPosition = typeof RECOVERY_WORD_POSITIONS[number];

export interface RecoveryWordEntry {
  readonly position: RecoveryWordPosition;
  readonly word: string;
}

export type ComparedFaceField =
  | "letter"
  | "digit"
  | "orientation";

export type QuarterTurnsClockwise = 0 | 1 | 2 | 3;

export interface RecoveryDiceKeyFace {
  readonly letter: OrientedFace["letter"];
  readonly digit: OrientedFace["digit"];
  readonly orientationAsLowercaseLetterTrbl:
    OrientedFace["orientationAsLowercaseLetterTrbl"];
}

export interface FaceDifference {
  readonly position: PhysicalFacePosition;
  readonly row: GridCoordinate;
  readonly column: GridCoordinate;
  readonly fields: readonly ComparedFaceField[];
  readonly firstScanFace: RecoveryDiceKeyFace;
  readonly secondScanFace: RecoveryDiceKeyFace;
}

export interface RotationComparison {
  readonly rotation: QuarterTurnsClockwise;
  readonly differences: readonly FaceDifference[];
}

export interface MatchingComparisonResult {
  readonly kind: "match";
  readonly rotation: QuarterTurnsClockwise;
}

export interface UniqueMismatchComparisonResult {
  readonly kind: "mismatch";
  readonly bestComparison: RotationComparison;
}

export interface AmbiguousMismatchComparisonResult {
  readonly kind: "alignment-ambiguous";
  readonly tiedComparisons: readonly RotationComparison[];
}

export type DiceKeyRotationComparisonResult =
  | MatchingComparisonResult
  | UniqueMismatchComparisonResult
  | AmbiguousMismatchComparisonResult;

interface TrustedAcquisition {
  readonly confidence: "trusted";
  readonly reviewRequiredPositions?: never;
}

interface ReviewRequiredAcquisition {
  readonly confidence: "review-required";
  readonly reviewRequiredPositions: readonly PhysicalFacePosition[];
}

/**
 * Scanner-specific confidence data must be reduced to this shape by an
 * adapter. The flow accepts scanner acquisitions only.
 */
export type SanitizedAcquisitionCleanup = Readonly<{
  acquisitionId: string;
  dispose: () => void;
  cleanupSettlement: Promise<void>;
}>;

export type SanitizedDiceKeyAcquisition = SanitizedAcquisitionCleanup &
  Readonly<{ faces: DiceKeyFaces }> &
  (TrustedAcquisition | ReviewRequiredAcquisition);

export interface RecoveryExplanationConsents {
  readonly computerIsOfflineAndTrusted: boolean;
  readonly understandsWordsControlWallet: boolean;
  readonly willRetainProfileWithPhysicalDiceKey: boolean;
}

export type BackupVerificationMode = "six-word-challenge" | "full-entry";

export type BackupFeedbackCode =
  | "BACKUP_WORD_MISMATCH"
  | "BACKUP_ENTRY_INCOMPLETE";

export type RecoveryFlowFailureCode =
  | "INVALID_ACQUISITION"
  | "ACQUISITION_REUSED"
  | "ACQUISITION_FAILED"
  | "ACQUISITION_DISPOSAL_FAILED"
  | "DERIVATION_FAILED"
  | "INVALID_DERIVATION_RESULT"
  | "CHECK_CODE_FAILED"
  | "INVALID_CHECK_CODE";

interface StateBase {
  readonly epoch: number;
}

export type RecoveryFlowState =
  | (StateBase & { readonly kind: "explain" })
  | (StateBase & { readonly kind: "awaiting-first-acquisition" })
  | (StateBase & {
      readonly kind: "reviewing-first-acquisition";
      readonly reviewRequiredPositions: readonly PhysicalFacePosition[];
      readonly reviewedPositions: readonly PhysicalFacePosition[];
    })
  | (StateBase & { readonly kind: "releasing-first-acquisition" })
  | (StateBase & {
      readonly kind: "awaiting-physical-break";
      readonly firstAcquisitionDisposed: true;
    })
  | (StateBase & { readonly kind: "awaiting-second-acquisition" })
  | (StateBase & {
      readonly kind: "reviewing-second-acquisition";
      readonly reviewRequiredPositions: readonly PhysicalFacePosition[];
      readonly reviewedPositions: readonly PhysicalFacePosition[];
    })
  | (StateBase & { readonly kind: "releasing-second-acquisition" })
  | (StateBase & {
      readonly kind: "matched";
      readonly rotation: QuarterTurnsClockwise;
    })
  | (StateBase & {
      readonly kind: "mismatch";
      readonly comparison: UniqueMismatchComparisonResult;
    })
  | (StateBase & {
      readonly kind: "alignment-ambiguous";
      readonly comparison: AmbiguousMismatchComparisonResult;
    })
  | (StateBase & { readonly kind: "deriving" })
  | (StateBase & {
      readonly kind: "concealed";
      readonly profileId: string;
      readonly checkCode: string;
    })
  | (StateBase & {
      readonly kind: "revealed";
      readonly profileId: string;
      readonly checkCode: string;
      readonly wordEntries: readonly RecoveryWordEntry[];
    })
  | (StateBase & {
      readonly kind: "backup-choice";
      readonly profileId: string;
      readonly checkCode: string;
    })
  | (StateBase & {
      readonly kind: "six-word-challenge";
      readonly profileId: string;
      readonly checkCode: string;
      readonly positions: readonly RecoveryWordPosition[];
      readonly feedbackCode?: BackupFeedbackCode;
    })
  | (StateBase & {
      readonly kind: "full-entry";
      readonly profileId: string;
      readonly checkCode: string;
      readonly feedbackCode?: BackupFeedbackCode;
    })
  | (StateBase & {
      readonly kind: "verified";
      readonly profileId: string;
      readonly checkCode: string;
      readonly method: BackupVerificationMode;
    })
  | (StateBase & {
      readonly kind: "failed";
      readonly code: RecoveryFlowFailureCode;
    })
  | (StateBase & { readonly kind: "cleared" });

export type RecoveryTransitionErrorCode =
  | "ILLEGAL_TRANSITION"
  | "CONSENT_REQUIRED"
  | "REVIEW_INCOMPLETE"
  | "POSITION_NOT_REVIEWABLE"
  | "SECURE_RANDOM_UNAVAILABLE";

export class RecoveryTransitionError extends Error {
  public readonly code: RecoveryTransitionErrorCode;

  public constructor(code: RecoveryTransitionErrorCode) {
    super(code);
    this.name = "RecoveryTransitionError";
    this.code = code;
  }
}

export type DeriveWalletMnemonic = (
  faces: DiceKeyFaces,
) => Promise<WalletMnemonicResult>;

export type DeriveRecoveryProfileCheckCode = (
  result: WalletMnemonicResult,
) => Promise<string>;

export type SecureGetRandomValues = <T extends Uint32Array>(values: T) => T;

export interface WalletRecoveryFlowDependencies {
  readonly deriveWalletMnemonic: DeriveWalletMnemonic;
  readonly deriveRecoveryProfileCheckCode?: DeriveRecoveryProfileCheckCode;
  readonly getRandomValues?: SecureGetRandomValues;
}
