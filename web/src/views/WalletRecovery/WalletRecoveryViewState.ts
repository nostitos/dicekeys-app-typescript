import {
  action,
  computed,
  makeObservable,
  observable,
  reaction,
  runInAction,
} from "mobx";

import { NavigationPathState } from "../../state/core/NavigationPathState";
import type { ViewState } from "../../state/core/ViewState";
import {
  deriveWalletMnemonicV1,
} from "../../wallet/DiceKeyBip39ProfileV1";
import { deriveRecoveryProfileCheckCodeV1 } from "../../wallet/RecoveryProfileCheckCodeV1";
import type { DiceKeyFaces } from "../../dicekeys/DiceKey";
import type {
  WalletRecoveryScannerResult,
  WalletRecoveryScannerTerminal,
  WalletRecoveryScannerAcquisition,
  WalletRecoveryScannerAcquisitionHandle,
} from "../LoadingDiceKeys/wallet-recovery-scanner-acquisition";
import type { WalletRecoveryRescanReason } from "../LoadingDiceKeys/wallet-recovery-scanner-policy";
import {
  RecoveryTransitionError,
  snapshotStrictWalletRecoveryFace,
  snapshotValidatedWalletRecoveryFaces,
  WalletRecoveryFlow,
} from "./foundation";
import type {
  BackupVerificationMode,
  PhysicalFacePosition,
  RecoveryDiceKeyFace,
  RecoveryExplanationConsents,
  RecoveryFlowFailureCode,
  RecoveryFlowState,
  RecoveryTransitionErrorCode,
  RecoveryWordEntry,
  WalletRecoveryFlowDependencies,
} from "./foundation";
import {
  walletRecoverySessionGate,
  type WalletRecoveryRegisteredScannerHandle,
  type WalletRecoverySessionCleanupStatus,
  type WalletRecoverySessionGate,
  type WalletRecoverySessionOwner,
} from "./wallet-recovery-session-gate";

export const WalletRecoveryViewStateName = "wallet-recovery" as const;

export type WalletRecoverySafeErrorCode =
  | RecoveryFlowFailureCode
  | RecoveryTransitionErrorCode
  | "SCANNER_CALLBACK_INVALID"
  | "SCANNER_SESSION_BLOCKED"
  | "UNEXPECTED_UI_FAILURE";

export type WalletRecoveryInlineErrorCode =
  | "CONSENT_REQUIRED"
  | "REVIEW_INCOMPLETE"
  | "POSITION_NOT_REVIEWABLE"
  | "SECURE_RANDOM_UNAVAILABLE";

export type WalletRecoveryScannerCallback = (
  result: WalletRecoveryScannerResult,
  terminal?: WalletRecoveryScannerTerminal,
) => void;

const WALLET_RECOVERY_RESCAN_REASONS = Object.freeze([
  "incomplete",
  "malformed",
  "no-majority",
  "ocr-ambiguous",
  "unsupported-scanner-error",
  "strict-wallet-invalid",
] as const satisfies readonly WalletRecoveryRescanReason[]);

const defaultDependencies: WalletRecoveryFlowDependencies = Object.freeze({
  deriveWalletMnemonic: deriveWalletMnemonicV1,
  deriveRecoveryProfileCheckCode: deriveRecoveryProfileCheckCodeV1,
});

const isRecord = (candidate: unknown): candidate is Record<string, unknown> => {
  if (typeof candidate !== "object" || candidate == null) return false;
  try {
    return !Array.isArray(candidate);
  } catch {
    return false;
  }
};

const ownDataValue = (
  candidate: object,
  key: PropertyKey,
): unknown => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    return descriptor != null && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
};

const isKnownRescanReason = (
  candidate: unknown,
): candidate is WalletRecoveryRescanReason =>
  typeof candidate === "string" &&
  WALLET_RECOVERY_RESCAN_REASONS.includes(
    candidate as WalletRecoveryRescanReason,
  );

const isAcquisitionTerminal = (
  candidate: unknown,
): candidate is WalletRecoveryScannerAcquisition =>
  isRecord(candidate) && ownDataValue(candidate, "faces") !== undefined;

const snapshotExactArrayDataValues = (
  candidate: unknown,
  maximumLength: number,
): readonly unknown[] | undefined => {
  try {
    if (!Array.isArray(candidate)) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, "length");
    if (
      lengthDescriptor == null ||
      !("value" in lengthDescriptor) ||
      !Number.isInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maximumLength
    ) {
      return undefined;
    }
    const length = lengthDescriptor.value as number;
    const expectedKeys = [
      ...Array.from({ length }, (_, index) => String(index)),
      "length",
    ];
    const actualKeys = Reflect.ownKeys(candidate);
    if (
      actualKeys.length !== expectedKeys.length ||
      !expectedKeys.every((key) => actualKeys.includes(key))
    ) {
      return undefined;
    }
    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(
        candidate,
        String(index),
      );
      if (descriptor == null || !("value" in descriptor)) return undefined;
      values.push(descriptor.value);
    }
    return Object.freeze(values);
  } catch {
    return undefined;
  }
};

interface PairedAcquisitionSnapshot {
  readonly faces: DiceKeyFaces;
  readonly confidence: "trusted" | "review-required";
  readonly reviewRequiredPositions: readonly PhysicalFacePosition[];
}

const snapshotPairedAcquisition = (
  result: WalletRecoveryScannerResult,
  acquisition: WalletRecoveryScannerAcquisition,
  registeredAttempt: RegisteredScannerAttempt,
): PairedAcquisitionSnapshot | undefined => {
  try {
    const status = ownDataValue(result, "status");
    if (status !== "exact" && status !== "requires-confirmation") {
      return undefined;
    }
    const resultFaces = ownDataValue(result, "faces");
    const acquisitionFaces = ownDataValue(acquisition, "faces");
    if (resultFaces === undefined || resultFaces !== acquisitionFaces) {
      return undefined;
    }
    if (
      ownDataValue(result, "acquisitionId") !==
        registeredAttempt.token.acquisitionId ||
      ownDataValue(acquisition, "acquisitionId") !==
        registeredAttempt.token.acquisitionId ||
      ownDataValue(acquisition, "dispose") !== registeredAttempt.token.dispose ||
      ownDataValue(acquisition, "cleanupSettlement") !==
        registeredAttempt.token.cleanupSettlement
    ) {
      return undefined;
    }
    const faces = snapshotValidatedWalletRecoveryFaces(acquisitionFaces);
    if (faces == null) return undefined;
    const confidence = ownDataValue(acquisition, "confidence");
    const flaggedFaceIndexes = snapshotExactArrayDataValues(
      ownDataValue(result, "flaggedFaceIndexes"),
      25,
    );
    if (flaggedFaceIndexes == null) return undefined;
    if (status === "exact") {
      return confidence === "trusted" && flaggedFaceIndexes.length === 0
        ? Object.freeze({
            faces,
            confidence: "trusted",
            reviewRequiredPositions: Object.freeze([]),
          })
        : undefined;
    }
    const reviewRequiredPositionValues = snapshotExactArrayDataValues(
      ownDataValue(acquisition, "reviewRequiredPositions"),
      25,
    );
    if (
      confidence !== "review-required" ||
      reviewRequiredPositionValues == null ||
      reviewRequiredPositionValues.length === 0 ||
      reviewRequiredPositionValues.length !== flaggedFaceIndexes.length
    ) {
      return undefined;
    }
    const positions: PhysicalFacePosition[] = [];
    const seenPositions = new Set<PhysicalFacePosition>();
    for (let index = 0; index < flaggedFaceIndexes.length; index += 1) {
      const faceIndex = flaggedFaceIndexes[index];
      const position = reviewRequiredPositionValues[index];
      if (
        typeof faceIndex !== "number" ||
        !Number.isInteger(faceIndex) ||
        faceIndex < 0 ||
        faceIndex >= 25 ||
        typeof position !== "number" ||
        !Number.isInteger(position) ||
        position !== faceIndex + 1 ||
        seenPositions.has(position as PhysicalFacePosition)
      ) {
        return undefined;
      }
      const physicalPosition = position as PhysicalFacePosition;
      seenPositions.add(physicalPosition);
      positions.push(physicalPosition);
    }
    return Object.freeze({
      faces,
      confidence: "review-required",
      reviewRequiredPositions: Object.freeze(positions),
    });
  } catch {
    return undefined;
  }
};

const scheduleMicrotask = (callback: () => void): void => {
  if (globalThis.queueMicrotask != null) {
    globalThis.queueMicrotask(callback);
  } else {
    void Promise.resolve().then(callback);
  }
};

const stateIsAwaitingAcquisition = (
  state: RecoveryFlowState,
): state is Extract<RecoveryFlowState, {
  readonly kind:
    | "awaiting-first-acquisition"
    | "awaiting-second-acquisition";
}> =>
  state.kind === "awaiting-first-acquisition" ||
  state.kind === "awaiting-second-acquisition";

const stateIsReviewingAcquisition = (
  state: RecoveryFlowState,
): state is Extract<RecoveryFlowState, {
  readonly kind:
    | "reviewing-first-acquisition"
    | "reviewing-second-acquisition";
}> =>
  state.kind === "reviewing-first-acquisition" ||
  state.kind === "reviewing-second-acquisition";

const stateHasLiveCeremony = (state: RecoveryFlowState): boolean =>
  state.kind !== "explain" && state.kind !== "cleared";

const stateAllowsPendingScannerCleanup = (state: RecoveryFlowState): boolean =>
  state.kind === "awaiting-first-acquisition" ||
  state.kind === "reviewing-first-acquisition" ||
  state.kind === "releasing-first-acquisition" ||
  state.kind === "awaiting-second-acquisition" ||
  state.kind === "reviewing-second-acquisition" ||
  state.kind === "releasing-second-acquisition" ||
  state.kind === "failed";

interface RegisteredScannerAttempt {
  readonly epoch: number;
  readonly kind:
    | "awaiting-first-acquisition"
      | "awaiting-second-acquisition";
  readonly owner: WalletRecoverySessionOwner;
  readonly token: WalletRecoveryRegisteredScannerHandle;
}

interface ScannerStageOwner {
  readonly epoch: number;
  readonly kind: RegisteredScannerAttempt["kind"];
  readonly owner: WalletRecoverySessionOwner;
}

const recoverableTransitionMatchesContext = (
  code: RecoveryTransitionErrorCode,
  state: RecoveryFlowState,
): code is WalletRecoveryInlineErrorCode => {
  switch (code) {
    case "CONSENT_REQUIRED":
      return state.kind === "explain";
    case "REVIEW_INCOMPLETE":
    case "POSITION_NOT_REVIEWABLE":
      return state.kind === "reviewing-first-acquisition" ||
        state.kind === "reviewing-second-acquisition";
    case "SECURE_RANDOM_UNAVAILABLE":
      return state.kind === "backup-choice";
    case "ILLEGAL_TRANSITION":
      return false;
  }
};

/**
 * MobX presentation adapter for the framework-free recovery ceremony.
 *
 * The foundation remains the only step/state authority. This adapter mirrors
 * its immutable state by reference, bridges the scanner's correlated terminal
 * callback, and owns only the minimum temporary presentation data needed to
 * review a sanitized acquisition.
 */
export class WalletRecoveryViewState implements ViewState {
  public readonly viewName = WalletRecoveryViewStateName;
  public readonly navState: NavigationPathState;

  private readonly parentNavState: NavigationPathState;
  private readonly dependencies: WalletRecoveryFlowDependencies;
  private readonly recoveryFlow: WalletRecoveryFlow;
  private readonly sessionGate: WalletRecoverySessionGate;

  private flowStateSnapshot: RecoveryFlowState;
  private reviewFacesSnapshot: DiceKeyFaces | undefined;
  private rescanReasonSnapshot: WalletRecoveryRescanReason | undefined;
  private safeErrorCodeSnapshot: WalletRecoverySafeErrorCode | undefined;
  private inlineErrorCodeSnapshot: WalletRecoveryInlineErrorCode | undefined;
  private reviewCleanupSettlement: Promise<void> | undefined;
  private registeredScannerAttempt: RegisteredScannerAttempt | undefined;
  private scannerStageOwner: ScannerStageOwner | undefined;
  private stopSessionGateReaction: (() => void) | undefined;
  private clearInProgress = false;
  private cleanupFailureDuringClear = false;

  private readonly activeMountLeases = new Set<number>();
  private nextMountLeaseId = 1;
  private unmountClearGeneration = 0;

  public constructor(
    parentNavState: NavigationPathState = NavigationPathState.root,
    dependencies: WalletRecoveryFlowDependencies = defaultDependencies,
    sessionGate: WalletRecoverySessionGate = walletRecoverySessionGate,
  ) {
    this.parentNavState = parentNavState;
    this.dependencies = dependencies;
    this.sessionGate = sessionGate;
    this.navState = new NavigationPathState(
      parentNavState,
      WalletRecoveryViewStateName,
    );
    this.recoveryFlow = new WalletRecoveryFlow(dependencies);
    this.flowStateSnapshot = this.recoveryFlow.state;

    makeObservable<
      WalletRecoveryViewState,
      | "flowStateSnapshot"
      | "reviewFacesSnapshot"
      | "rescanReasonSnapshot"
      | "safeErrorCodeSnapshot"
      | "inlineErrorCodeSnapshot"
    >(this, {
      flowStateSnapshot: observable.ref,
      reviewFacesSnapshot: observable.ref,
      rescanReasonSnapshot: observable.ref,
      safeErrorCodeSnapshot: observable.ref,
      inlineErrorCodeSnapshot: observable.ref,
      flowState: computed,
      state: computed,
      reviewFaces: computed,
      rescanReason: computed,
      safeErrorCode: computed,
      inlineErrorCode: computed,
      sessionGateStatus: computed,
      canBeginRecovery: computed,
      scannerAttemptKey: computed,
      acceptExplanation: action,
      reviewFace: action,
      completeAcquisitionReview: action,
      acknowledgePhysicalBreak: action,
      beginDerivation: action,
      reveal: action,
      continueToBackupChoice: action,
      chooseBackupVerification: action,
      returnToBackupChoice: action,
      submitSixWordChallenge: action,
      submitFullEntry: action,
      registerWalletScannerAttempt: action,
      clear: action,
    });

    this.stopSessionGateReaction = reaction(
      () => this.sessionGate.status,
      (status) => {
        if (status === "idle") return;
        runInAction(() => this.handleNonIdleSessionCleanup(status));
      },
      { fireImmediately: true },
    );
  }

  public get flowState(): RecoveryFlowState {
    return this.flowStateSnapshot;
  }

  /** Alias for views that conventionally read `state.state`. */
  public get state(): RecoveryFlowState {
    return this.flowStateSnapshot;
  }

  public get reviewFaces(): DiceKeyFaces | undefined {
    return this.reviewFacesSnapshot;
  }

  public get rescanReason(): WalletRecoveryRescanReason | undefined {
    return this.rescanReasonSnapshot;
  }

  public get safeErrorCode(): WalletRecoverySafeErrorCode | undefined {
    return this.flowStateSnapshot.kind === "failed"
      ? this.flowStateSnapshot.code
      : this.safeErrorCodeSnapshot;
  }

  public get inlineErrorCode(): WalletRecoveryInlineErrorCode | undefined {
    return this.inlineErrorCodeSnapshot;
  }

  public get sessionGateStatus(): WalletRecoverySessionCleanupStatus {
    return this.sessionGate.status;
  }

  public get canBeginRecovery(): boolean {
    return this.flowStateSnapshot.kind === "explain" &&
      this.sessionGate.canBeginNewCeremony;
  }

  /** Stable for one awaiting stage; changes before a distinct second attempt. */
  public get scannerAttemptKey(): string | undefined {
    return stateIsAwaitingAcquisition(this.flowStateSnapshot)
      ? `${this.flowStateSnapshot.kind}:${this.flowStateSnapshot.epoch}`
      : undefined;
  }

  public acceptExplanation = (
    consents: RecoveryExplanationConsents,
  ): boolean => {
    if (!this.sessionGate.canBeginNewCeremony) {
      this.inlineErrorCodeSnapshot = undefined;
      this.safeErrorCodeSnapshot = undefined;
      return false;
    }
    return this.performTransition(() => {
      this.recoveryFlow.acceptExplanation(consents);
    });
  };

  public reviewFace = (
    position: PhysicalFacePosition,
    correctedFace?: RecoveryDiceKeyFace,
  ): boolean => {
    const correctedFaceSnapshot = correctedFace === undefined
      ? undefined
      : snapshotStrictWalletRecoveryFace(correctedFace);
    if (correctedFace !== undefined && correctedFaceSnapshot == null) {
      this.failTerminally("INVALID_ACQUISITION");
      return false;
    }
    const transitioned = this.performTransition(() => {
      this.recoveryFlow.reviewFace(
        position,
        correctedFaceSnapshot,
      );
    });
    if (
      transitioned &&
      correctedFaceSnapshot != null &&
      stateIsReviewingAcquisition(this.flowStateSnapshot) &&
      this.reviewFacesSnapshot != null
    ) {
      this.reviewFacesSnapshot = Object.freeze(
        this.reviewFacesSnapshot.map((face, index) =>
          index === position - 1
            ? correctedFaceSnapshot
            : face),
      ) as unknown as DiceKeyFaces;
    }
    return transitioned;
  };

  public completeAcquisitionReview = (): boolean =>
    this.performTransition(() => {
      this.recoveryFlow.completeAcquisitionReview();
    });

  public acknowledgePhysicalBreak = (): boolean => {
    if (!this.requireIdleCleanupGate()) return false;
    return this.performTransition(() => {
      this.recoveryFlow.acknowledgePhysicalBreak();
    });
  };

  public beginDerivation = (): Promise<boolean> => {
    if (!this.requireIdleCleanupGate()) {
      return Promise.resolve(false);
    }
    this.safeErrorCodeSnapshot = undefined;
    this.inlineErrorCodeSnapshot = undefined;
    const operationContext = this.flowStateSnapshot;
    let derivation: Promise<void>;
    try {
      derivation = this.recoveryFlow.beginDerivation();
      this.syncFromFlow();
    } catch (error) {
      this.recordOperationError(error, operationContext);
      this.syncFromFlow();
      return Promise.resolve(false);
    }

    return derivation.then(
      () => {
        runInAction(() => this.syncFromFlow());
        return this.flowStateSnapshot.kind === "concealed";
      },
      () => {
        runInAction(() => {
          this.failTerminally("UNEXPECTED_UI_FAILURE");
        });
        return false;
      },
    );
  };

  public reveal = (): boolean => {
    if (!this.requireIdleCleanupGate()) return false;
    return this.performTransition(() => {
      this.recoveryFlow.reveal();
    });
  };

  public continueToBackupChoice = (): boolean => {
    if (!this.requireIdleCleanupGate()) return false;
    return this.performTransition(() => {
      this.recoveryFlow.continueToBackupChoice();
    });
  };

  public chooseBackupVerification = (
    mode: BackupVerificationMode,
  ): boolean => {
    if (!this.requireIdleCleanupGate()) return false;
    if (mode !== "six-word-challenge" && mode !== "full-entry") {
      this.failTerminally("ILLEGAL_TRANSITION");
      return false;
    }
    return this.performTransition(() => {
      this.recoveryFlow.chooseBackupVerification(mode);
    });
  };

  public returnToBackupChoice = (): boolean => {
    if (!this.requireIdleCleanupGate()) return false;
    return this.performTransition(() => {
      this.recoveryFlow.returnToBackupChoice();
    });
  };

  /** Entries are forwarded synchronously and never retained by this adapter. */
  public submitSixWordChallenge = (
    entries: readonly RecoveryWordEntry[],
  ): boolean => {
    if (!this.requireIdleCleanupGate()) return false;
    return this.performTransitionWithResult(
      () => this.recoveryFlow.submitSixWordChallenge(entries),
      false,
    );
  };

  /** Entries are forwarded synchronously and never retained by this adapter. */
  public submitFullEntry = (
    entries: readonly RecoveryWordEntry[],
  ): boolean => {
    if (!this.requireIdleCleanupGate()) return false;
    return this.performTransitionWithResult(
      () => this.recoveryFlow.submitFullEntry(entries),
      false,
    );
  };

  /** Called by wallet-mode ScanDiceKeyView immediately after attempt mount. */
  public registerWalletScannerAttempt = (
    handle: WalletRecoveryScannerAcquisitionHandle,
  ): boolean => {
    const currentState = this.flowStateSnapshot;
    if (!stateIsAwaitingAcquisition(currentState)) {
      this.sessionGate.trackAndDisposeUnpaired(Object.freeze({}), handle);
      if (currentState.kind !== "cleared") {
        this.failTerminally("SCANNER_CALLBACK_INVALID");
      }
      return false;
    }

    const owner = this.ownerForAwaitingStage(currentState);
    const token = this.sessionGate.registerAttempt(
      owner,
      handle,
    );
    if (token == null) {
      this.failTerminally("SCANNER_SESSION_BLOCKED");
      return false;
    }

    const previousAttempt = this.registeredScannerAttempt;
    if (previousAttempt != null && previousAttempt.token !== token) {
      this.sessionGate.disposeAttempt(
        previousAttempt.owner,
        previousAttempt.token,
      );
    }
    this.registeredScannerAttempt = {
      epoch: currentState.epoch,
      kind: currentState.kind,
      owner,
      token,
    };
    return true;
  };

  /**
   * Capture the exact awaiting epoch now. Late callbacks remain bound to this
   * adapter and epoch, so they can only be rejected/disposed by the old flow.
   */
  public walletScannerCallbackForCurrentAttempt = (): WalletRecoveryScannerCallback => {
    const awaitingState = this.flowStateSnapshot;
    const expectedEpoch = awaitingState.epoch;
    const expectedKind = awaitingState.kind;
    const expectedOwner = stateIsAwaitingAcquisition(awaitingState)
      ? this.ownerForAwaitingStage(awaitingState)
      : Object.freeze({});

    return (result, terminal): void => {
      runInAction(() => {
        try {
          if (
            this.flowStateSnapshot.epoch !== expectedEpoch ||
            this.flowStateSnapshot.kind !== expectedKind ||
            !stateIsAwaitingAcquisition(this.flowStateSnapshot)
          ) {
            this.disposeUnpairedTerminal(terminal, expectedOwner);
            return;
          }
          this.handleScannerCallback(
            expectedEpoch,
            expectedOwner,
            result,
            terminal,
          );
        } catch {
          this.failInvalidScannerCallback(terminal, expectedOwner);
        }
      });
    };
  };

  /**
   * Register one committed view mount. The deferred zero-lease check avoids
   * clearing during React StrictMode's immediate effect cleanup/setup replay.
   */
  public mountView = (): (() => void) => {
    const leaseId = this.nextMountLeaseId++;
    this.activeMountLeases.add(leaseId);
    this.unmountClearGeneration += 1;
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.activeMountLeases.delete(leaseId);
      if (this.activeMountLeases.size !== 0) return;
      const clearGeneration = ++this.unmountClearGeneration;
      scheduleMicrotask(() => {
        if (
          clearGeneration !== this.unmountClearGeneration ||
          this.activeMountLeases.size !== 0
        ) {
          return;
        }
        runInAction(() => this.clear());
      });
    };
  };

  public clear = (): void => {
    if (this.clearInProgress) {
      if (this.sessionGate.status === "unconfirmed") {
        this.cleanupFailureDuringClear = true;
      }
      return;
    }
    const wasLive = stateHasLiveCeremony(this.flowStateSnapshot);
    this.clearInProgress = true;
    this.cleanupFailureDuringClear = false;
    try {
      this.unmountClearGeneration += 1;
      this.disposeRegisteredScannerAttempt();
      this.recoveryFlow.clear();
      this.reviewFacesSnapshot = undefined;
      this.rescanReasonSnapshot = undefined;
      this.safeErrorCodeSnapshot = undefined;
      this.inlineErrorCodeSnapshot = undefined;
      this.releaseReviewCleanupSettlement();
      this.scannerStageOwner = undefined;
      this.syncFromFlow();
    } finally {
      const cleanupFailed = wasLive &&
        (this.cleanupFailureDuringClear ||
          this.sessionGate.status === "unconfirmed");
      this.clearInProgress = false;
      this.stopSessionGateReaction?.();
      this.stopSessionGateReaction = undefined;
      if (cleanupFailed) {
        this.safeErrorCodeSnapshot = "ACQUISITION_DISPOSAL_FAILED";
      }
    }
  };

  public dispose = (): void => this.clear();

  /** Restart means replacing this cleared adapter with the returned instance. */
  public createFresh = (): WalletRecoveryViewState => {
    this.clear();
    return new WalletRecoveryViewState(
      this.parentNavState,
      this.dependencies,
      this.sessionGate,
    );
  };

  private ownerForAwaitingStage(
    state: Extract<RecoveryFlowState, {
      readonly kind:
        | "awaiting-first-acquisition"
        | "awaiting-second-acquisition";
    }>,
  ): WalletRecoverySessionOwner {
    const existing = this.scannerStageOwner;
    if (
      existing != null &&
      existing.epoch === state.epoch &&
      existing.kind === state.kind
    ) {
      return existing.owner;
    }
    const owner = Object.freeze({
      epoch: state.epoch,
      kind: state.kind,
    });
    this.scannerStageOwner = {
      epoch: state.epoch,
      kind: state.kind,
      owner,
    };
    return owner;
  }

  private requireIdleCleanupGate(): boolean {
    const status = this.sessionGate.status;
    if (status === "idle") return true;
    this.handleNonIdleSessionCleanup(status);
    return false;
  }

  private handleNonIdleSessionCleanup(
    status: Exclude<WalletRecoverySessionCleanupStatus, "idle">,
  ): void {
    if (this.clearInProgress) {
      if (status === "unconfirmed") {
        this.cleanupFailureDuringClear = true;
      }
      return;
    }
    if (!stateHasLiveCeremony(this.flowStateSnapshot)) return;
    if (
      status === "pending" &&
      stateAllowsPendingScannerCleanup(this.flowStateSnapshot)
    ) {
      return;
    }
    this.failTerminally("ACQUISITION_DISPOSAL_FAILED");
  }

  private performTransition(operation: () => void): boolean {
    return this.performTransitionWithResult(() => {
      operation();
      return true;
    }, false);
  }

  private performTransitionWithResult<T>(
    operation: () => T,
    failureResult: T,
  ): T {
    this.safeErrorCodeSnapshot = undefined;
    this.inlineErrorCodeSnapshot = undefined;
    const operationContext = this.flowStateSnapshot;
    try {
      const result = operation();
      this.syncFromFlow();
      return result;
    } catch (error) {
      this.recordOperationError(error, operationContext);
      this.syncFromFlow();
      return failureResult;
    }
  }

  private recordOperationError(
    error: unknown,
    operationContext: RecoveryFlowState,
  ): void {
    try {
      if (error instanceof RecoveryTransitionError) {
        const currentState = this.recoveryFlow.state;
        if (
          currentState.epoch === operationContext.epoch &&
          recoverableTransitionMatchesContext(error.code, operationContext) &&
          recoverableTransitionMatchesContext(error.code, currentState)
        ) {
          this.inlineErrorCodeSnapshot = error.code;
          return;
        }
        this.failTerminally(
          error.code === "ILLEGAL_TRANSITION"
            ? "ILLEGAL_TRANSITION"
            : "UNEXPECTED_UI_FAILURE",
        );
        return;
      }
    } catch {}
    this.failTerminally("UNEXPECTED_UI_FAILURE");
  }

  private handleScannerCallback(
    expectedEpoch: number,
    expectedOwner: WalletRecoverySessionOwner,
    result: WalletRecoveryScannerResult,
    terminal: WalletRecoveryScannerTerminal | undefined,
  ): void {
    const registeredAttempt = this.registeredScannerAttempt;
    if (
      registeredAttempt == null ||
      registeredAttempt.epoch !== expectedEpoch ||
      registeredAttempt.kind !== this.flowStateSnapshot.kind ||
      registeredAttempt.owner !== expectedOwner ||
      ownDataValue(result, "acquisitionId") !==
        registeredAttempt.token.acquisitionId
    ) {
      this.failInvalidScannerCallback(terminal, expectedOwner);
      return;
    }
    const status = isRecord(result) ? ownDataValue(result, "status") : undefined;
    if (status === "rescan") {
      const reason = ownDataValue(result, "reason");
      if (terminal != null || !isKnownRescanReason(reason)) {
        this.failInvalidScannerCallback(terminal, expectedOwner);
        return;
      }
      this.safeErrorCodeSnapshot = undefined;
      this.rescanReasonSnapshot = reason;
      return;
    }

    this.rescanReasonSnapshot = undefined;
    this.safeErrorCodeSnapshot = undefined;

    if (status === "failed") {
      if (
        ownDataValue(result, "reason") !== "scanner-attempt-failed" ||
        terminal !== registeredAttempt.token.source
      ) {
        this.failInvalidScannerCallback(terminal, expectedOwner);
        return;
      }
      this.registeredScannerAttempt = undefined;
      const cleanupForFlow = this.cleanupForFlow(registeredAttempt);
      const accepted = this.recoveryFlow.receiveAcquisitionFailure(
        expectedEpoch,
        cleanupForFlow,
      );
      this.syncFromFlow();
      if (accepted) {
        this.observeCleanupSettlement(cleanupForFlow.cleanupSettlement);
      }
      return;
    }

    const acquisitionSnapshot =
      (status !== "exact" && status !== "requires-confirmation") ||
        !isAcquisitionTerminal(terminal)
        ? undefined
        : snapshotPairedAcquisition(result, terminal, registeredAttempt);
    if (acquisitionSnapshot == null) {
      this.failInvalidScannerCallback(terminal, expectedOwner);
      return;
    }

    const acquisitionForFlow = this.acquisitionForFlow(
      acquisitionSnapshot,
      registeredAttempt,
    );
    this.registeredScannerAttempt = undefined;
    const accepted = this.recoveryFlow.receiveAcquisition(
      expectedEpoch,
      acquisitionForFlow,
    );
    this.syncFromFlow();
    if (!accepted) return;

    if (stateIsReviewingAcquisition(this.flowStateSnapshot)) {
      this.reviewFacesSnapshot = acquisitionSnapshot.faces;
      this.reviewCleanupSettlement = acquisitionForFlow.cleanupSettlement;
    } else {
      this.observeCleanupSettlement(acquisitionForFlow.cleanupSettlement);
    }
  }

  private cleanupForFlow(
    attempt: RegisteredScannerAttempt,
  ): WalletRecoveryScannerAcquisitionHandle {
    const gateOwnedDispose = (): void => {
      if (!this.sessionGate.disposeAttempt(attempt.owner, attempt.token)) {
        throw new Error("Wallet recovery scanner cleanup was not confirmed");
      }
    };
    return Object.freeze({
      acquisitionId: attempt.token.acquisitionId,
      dispose: gateOwnedDispose,
      cleanupSettlement: attempt.token.cleanupSettlement,
    });
  }

  private acquisitionForFlow(
    acquisition: PairedAcquisitionSnapshot,
    attempt: RegisteredScannerAttempt,
  ): WalletRecoveryScannerAcquisition {
    const cleanup = this.cleanupForFlow(attempt);
    const common = {
      acquisitionId: cleanup.acquisitionId,
      faces: acquisition.faces,
      dispose: cleanup.dispose,
      cleanupSettlement: cleanup.cleanupSettlement,
    } as const;
    return acquisition.confidence === "trusted"
      ? Object.freeze({
          ...common,
          confidence: "trusted" as const,
        })
      : Object.freeze({
          ...common,
          confidence: "review-required" as const,
          reviewRequiredPositions: acquisition.reviewRequiredPositions,
        });
  }

  private failInvalidScannerCallback(
    terminal: WalletRecoveryScannerTerminal | undefined,
    owner: WalletRecoverySessionOwner,
  ): void {
    this.disposeUnpairedTerminal(terminal, owner);
    this.failTerminally("SCANNER_CALLBACK_INVALID");
  }

  private disposeUnpairedTerminal(
    terminal: unknown,
    owner: WalletRecoverySessionOwner,
  ): void {
    if (terminal == null) return;
    const registeredToken = this.registeredScannerAttempt?.token;
    if (
      registeredToken != null &&
      (terminal === registeredToken.source ||
        (ownDataValue(terminal as object, "acquisitionId") ===
          registeredToken.acquisitionId &&
          ownDataValue(terminal as object, "dispose") ===
            registeredToken.dispose &&
          ownDataValue(terminal as object, "cleanupSettlement") ===
            registeredToken.cleanupSettlement))
    ) {
      return;
    }
    this.sessionGate.trackAndDisposeUnpaired(owner, terminal);
  }

  private syncFromFlow(): void {
    this.flowStateSnapshot = this.recoveryFlow.state;
    if (
      this.inlineErrorCodeSnapshot != null &&
      !recoverableTransitionMatchesContext(
        this.inlineErrorCodeSnapshot,
        this.flowStateSnapshot,
      )
    ) {
      this.inlineErrorCodeSnapshot = undefined;
    }
    if (!stateIsAwaitingAcquisition(this.flowStateSnapshot)) {
      this.rescanReasonSnapshot = undefined;
    }
    if (!stateIsReviewingAcquisition(this.flowStateSnapshot)) {
      this.reviewFacesSnapshot = undefined;
      this.releaseReviewCleanupSettlement();
    }
    const cleanupStatus = this.sessionGate.status;
    if (cleanupStatus !== "idle") {
      this.handleNonIdleSessionCleanup(cleanupStatus);
    }
  }

  private releaseReviewCleanupSettlement(): void {
    const cleanupSettlement = this.reviewCleanupSettlement;
    this.reviewCleanupSettlement = undefined;
    if (cleanupSettlement != null) {
      this.observeCleanupSettlement(cleanupSettlement);
    }
  }

  private observeCleanupSettlement(settlement: Promise<void>): void {
    const resync = (): void => {
      runInAction(() => this.syncFromFlow());
    };
    try {
      void Promise.prototype.then.call(settlement, resync, resync);
    } catch {
      runInAction(() => this.syncFromFlow());
    }
  }

  private disposeRegisteredScannerAttempt(): void {
    const registeredAttempt = this.registeredScannerAttempt;
    this.registeredScannerAttempt = undefined;
    if (registeredAttempt == null) return;
    this.sessionGate.disposeAttempt(
      registeredAttempt.owner,
      registeredAttempt.token,
    );
  }

  private failTerminally(code: WalletRecoverySafeErrorCode): void {
    this.clear();
    this.safeErrorCodeSnapshot = this.sessionGate.status === "unconfirmed"
      ? "ACQUISITION_DISPOSAL_FAILED"
      : code;
  }
}
