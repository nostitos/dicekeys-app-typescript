import type {
  PhysicalFacePosition,
  SanitizedAcquisitionCleanup,
  SanitizedDiceKeyAcquisition,
} from "../WalletRecovery/foundation";
import type {
  WalletRecoveryScanCandidate,
  WalletRecoveryScanResult,
} from "./wallet-recovery-scanner-policy";

export type WalletRecoveryScannerAcquisition = SanitizedDiceKeyAcquisition;

export type WalletRecoveryScannerAcquisitionHandle =
  SanitizedAcquisitionCleanup;

export interface WalletRecoveryScannerAttemptFailure {
  readonly status: "failed";
  readonly reason: "scanner-attempt-failed";
}

export const WALLET_RECOVERY_SCANNER_ATTEMPT_FAILED:
  WalletRecoveryScannerAttemptFailure = Object.freeze({
    status: "failed",
    reason: "scanner-attempt-failed",
  });

export type WalletRecoveryScannerResult =
  | WalletRecoveryScanResult
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
  // Keep the stable settlement observed even if a caller only needs the
  // synchronous inerting guarantee. Consumers may still await the same promise.
  void cleanupSettlement.catch(() => {});

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
