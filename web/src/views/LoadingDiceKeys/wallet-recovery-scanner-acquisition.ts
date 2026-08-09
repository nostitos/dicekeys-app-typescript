import type {
  PhysicalFacePosition,
  SanitizedAcquisitionCleanup,
  SanitizedDiceKeyAcquisition,
} from "../WalletRecovery/foundation";
import type {
  WalletRecoveryScanCandidate,
  WalletRecoveryScanRequiresRescan,
  WalletRecoveryScanResult,
} from "./wallet-recovery-scanner-policy";

export type WalletRecoveryScannerAcquisition = SanitizedDiceKeyAcquisition;

export type WalletRecoveryScannerAcquisitionHandle =
  SanitizedAcquisitionCleanup;

export interface WalletRecoveryScannerAttemptFailure {
  readonly status: "failed";
  readonly reason: "scanner-attempt-failed";
  readonly acquisitionId: string;
}

export const createWalletRecoveryScannerAttemptFailure = (
  acquisitionId: string,
): WalletRecoveryScannerAttemptFailure => Object.freeze({
    status: "failed",
    reason: "scanner-attempt-failed",
    acquisitionId,
  });

export type WalletRecoveryScannerResult =
  | (WalletRecoveryScanCandidate & Readonly<{ acquisitionId: string }>)
  | (WalletRecoveryScanRequiresRescan & Readonly<{ acquisitionId: string }>)
  | WalletRecoveryScannerAttemptFailure;

export type WalletRecoveryScannerTerminal =
  | WalletRecoveryScannerAcquisition
  | WalletRecoveryScannerAcquisitionHandle;

/**
 * Couples one opaque scanner-attempt id to synchronous inerting and one stable
 * asynchronous worker-cleanup settlement. dispose() initiates cleanup once.
 */
export const createWalletRecoveryScannerAcquisitionHandle = (
  acquisitionId: string,
  beginDisposal: () => Promise<void>,
): WalletRecoveryScannerAcquisitionHandle => {
  let disposalStarted = false;
  let resolveCleanup!: () => void;
  let rejectCleanup!: (error: unknown) => void;
  const cleanupSettlement = new Promise<void>((resolve, reject) => {
    resolveCleanup = resolve;
    rejectCleanup = reject;
  });

  const dispose = (): void => {
    if (disposalStarted) return;
    disposalStarted = true;
    try {
      void beginDisposal().then(resolveCleanup, rejectCleanup);
    } catch (error) {
      rejectCleanup(error);
    }
  };

  return Object.freeze({
    acquisitionId,
    dispose,
    cleanupSettlement,
  });
};

/** Correlate every fixed scanner-policy outcome to its mounted attempt. */
export const scannerResultForAcquisition = (
  result: WalletRecoveryScanResult,
  acquisitionId: string,
): Exclude<WalletRecoveryScannerResult, WalletRecoveryScannerAttemptFailure> =>
  Object.freeze({
    ...result,
    acquisitionId,
  });

/** A frozen, exact-shape acquisition accepted directly by WalletRecoveryFlow. */
export const scannerCandidateToSanitizedAcquisition = (
  candidate: WalletRecoveryScanCandidate,
  handle: WalletRecoveryScannerAcquisitionHandle,
): SanitizedDiceKeyAcquisition => {
  const common = {
    acquisitionId: handle.acquisitionId,
    faces: candidate.faces,
    dispose: handle.dispose,
    cleanupSettlement: handle.cleanupSettlement,
  } as const;
  if (candidate.status === "exact") {
    return Object.freeze({
      ...common,
      confidence: "trusted" as const,
    });
  }
  const reviewRequiredPositions = Object.freeze(
    candidate.flaggedFaceIndexes.map(
      (faceIndex) => faceIndex + 1 as PhysicalFacePosition,
    ),
  );
  return Object.freeze({
    ...common,
    confidence: "review-required" as const,
    reviewRequiredPositions,
  });
};
