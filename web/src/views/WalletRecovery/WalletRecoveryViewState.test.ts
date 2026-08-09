import { autorun } from "mobx";

import type { DiceKeyFaces } from "../../dicekeys/DiceKey";
import { DiceKeyWithoutKeyId } from "../../dicekeys/DiceKey";
import { NavigationPathState } from "../../state/core/NavigationPathState";
import {
  DK_BIP39_24_V1,
  type WalletMnemonicResult,
} from "../../wallet/DiceKeyBip39ProfileV1";
import type {
  WalletRecoveryScanCandidate,
  WalletRecoveryScanRequiresRescan,
} from "../LoadingDiceKeys/wallet-recovery-scanner-policy";
import {
  createWalletRecoveryScannerAttemptFailure,
  type WalletRecoveryScannerAcquisition,
  type WalletRecoveryScannerAcquisitionHandle,
  type WalletRecoveryScannerResult,
} from "../LoadingDiceKeys/wallet-recovery-scanner-acquisition";
import type {
  PhysicalFacePosition,
  RecoveryDiceKeyFace,
  RecoveryWordEntry,
  SecureGetRandomValues,
  WalletRecoveryFlowDependencies,
} from "./foundation";
import { RecoveryTransitionError } from "./foundation";
import {
  WalletRecoveryViewState,
  WalletRecoveryViewStateName,
} from "./WalletRecoveryViewState";
import { WalletRecoverySessionGate } from "./wallet-recovery-session-gate";

const baseFaces = DiceKeyWithoutKeyId.testExample.faces;
const mnemonic = "execute lemon ripple figure cage accuse poem reunion baby damp case idea miracle nephew bread trumpet parent walk draft trumpet promote vendor occur deliver";
const mnemonicWords = Object.freeze(mnemonic.split(" "));
const walletResult: WalletMnemonicResult = Object.freeze({
  profileId: DK_BIP39_24_V1.id,
  words: mnemonicWords,
  mnemonic,
});
const checkCode = "A1B2-C3D4-E5F6";

const allConsents = Object.freeze({
  computerIsOfflineAndTrusted: true,
  understandsWordsControlWallet: true,
  willRetainProfileWithPhysicalDiceKey: true,
});

let randomValue = 0;
const deterministicRng: SecureGetRandomValues = <T extends Uint32Array>(
  target: T,
): T => {
  target[0] = randomValue++;
  return target;
};

const createDependencies = (
  overrides: Partial<WalletRecoveryFlowDependencies> = {},
): WalletRecoveryFlowDependencies => ({
  deriveWalletMnemonic: async () => walletResult,
  deriveRecoveryProfileCheckCode: async () => checkCode,
  getRandomValues: deterministicRng,
  ...overrides,
});

const createViewState = (
  overrides: Partial<WalletRecoveryFlowDependencies> = {},
  sessionGate = new WalletRecoverySessionGate(),
): WalletRecoveryViewState => new WalletRecoveryViewState(
  NavigationPathState.root,
  createDependencies(overrides),
  sessionGate,
);

const deferred = <T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} => {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
};

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
};

const makeExactScan = ({
  acquisitionId,
  faces = baseFaces,
  cleanupSettlement = Promise.resolve(),
  dispose = jest.fn(),
}: {
  acquisitionId: string;
  faces?: DiceKeyFaces;
  cleanupSettlement?: Promise<void>;
  dispose?: jest.Mock<void, []>;
}): {
  readonly result: WalletRecoveryScanCandidate & Readonly<{
    acquisitionId: string;
  }>;
  readonly handle: WalletRecoveryScannerAcquisitionHandle;
  readonly terminal: WalletRecoveryScannerAcquisition;
  readonly dispose: jest.Mock<void, []>;
} => {
  const handle = Object.freeze({
    acquisitionId,
    dispose,
    cleanupSettlement,
  });
  return {
    result: Object.freeze({
      status: "exact",
      acquisitionId,
      faces,
      flaggedFaceIndexes: Object.freeze([]),
    }),
    handle,
    terminal: Object.freeze({
      acquisitionId,
      faces,
      confidence: "trusted",
      dispose,
      cleanupSettlement,
    }),
    dispose,
  };
};

const makeReviewScan = ({
  acquisitionId,
  reviewRequiredPositions,
  faces = baseFaces,
  cleanupSettlement = Promise.resolve(),
  dispose = jest.fn(),
}: {
  acquisitionId: string;
  reviewRequiredPositions: readonly PhysicalFacePosition[];
  faces?: DiceKeyFaces;
  cleanupSettlement?: Promise<void>;
  dispose?: jest.Mock<void, []>;
}): {
  readonly result: WalletRecoveryScanCandidate & Readonly<{
    acquisitionId: string;
  }>;
  readonly handle: WalletRecoveryScannerAcquisitionHandle;
  readonly terminal: WalletRecoveryScannerAcquisition;
  readonly dispose: jest.Mock<void, []>;
} => {
  const handle = Object.freeze({
    acquisitionId,
    dispose,
    cleanupSettlement,
  });
  return {
    result: Object.freeze({
      status: "requires-confirmation",
      acquisitionId,
      faces,
      flaggedFaceIndexes: Object.freeze(
        reviewRequiredPositions.map((position) => position - 1),
      ),
    }),
    handle,
    terminal: Object.freeze({
      acquisitionId,
      faces,
      confidence: "review-required",
      reviewRequiredPositions: Object.freeze([...reviewRequiredPositions]),
      dispose,
      cleanupSettlement,
    }),
    dispose,
  };
};

const makeFailureHandle = ({
  acquisitionId,
  cleanupSettlement = Promise.resolve(),
  dispose = jest.fn(),
}: {
  acquisitionId: string;
  cleanupSettlement?: Promise<void>;
  dispose?: jest.Mock<void, []>;
}): WalletRecoveryScannerAcquisitionHandle => Object.freeze({
  acquisitionId,
  dispose,
  cleanupSettlement,
});

const driveToAwaitingSecond = async (
  state: WalletRecoveryViewState,
): Promise<void> => {
  expect(state.acceptExplanation(allConsents)).toBe(true);
  const first = makeExactScan({ acquisitionId: "first-attempt" });
  expect(state.registerWalletScannerAttempt(first.handle)).toBe(true);
  state.walletScannerCallbackForCurrentAttempt()(first.result, first.terminal);
  expect(state.flowState.kind).toBe("releasing-first-acquisition");
  await flushMicrotasks();
  expect(state.flowState.kind).toBe("awaiting-physical-break");
  expect(state.acknowledgePhysicalBreak()).toBe(true);
  expect(state.flowState.kind).toBe("awaiting-second-acquisition");
};

const driveToMatched = async (
  state: WalletRecoveryViewState,
): Promise<void> => {
  await driveToAwaitingSecond(state);
  const second = makeExactScan({ acquisitionId: "second-attempt" });
  expect(state.registerWalletScannerAttempt(second.handle)).toBe(true);
  state.walletScannerCallbackForCurrentAttempt()(second.result, second.terminal);
  expect(state.flowState.kind).toBe("releasing-second-acquisition");
  await flushMicrotasks();
  expect(state.flowState.kind).toBe("matched");
};

const driveToBackupChoice = async (
  state: WalletRecoveryViewState,
): Promise<void> => {
  await driveToMatched(state);
  expect(await state.beginDerivation()).toBe(true);
  expect(state.reveal()).toBe(true);
  expect(state.continueToBackupChoice()).toBe(true);
  expect(state.flowState.kind).toBe("backup-choice");
};

describe("WalletRecoveryViewState", () => {
  beforeEach(() => {
    randomValue = 0;
  });

  test("is a constant-path MobX adapter and exposes only fixed transition errors", () => {
    const state = createViewState();
    const observedKinds: string[] = [];
    const stop = autorun(() => observedKinds.push(state.flowState.kind));

    expect(state.viewName).toBe(WalletRecoveryViewStateName);
    expect(state.navState.path).toBe("/wallet-recovery");
    expect(state.state).toBe(state.flowState);
    expect(state.acceptExplanation({
      ...allConsents,
      computerIsOfflineAndTrusted: false,
    })).toBe(false);
    expect(state.flowState.kind).toBe("explain");
    expect(state.safeErrorCode).toBeUndefined();
    expect(state.inlineErrorCode).toBe("CONSENT_REQUIRED");

    expect(state.acceptExplanation(allConsents)).toBe(true);
    expect(state.safeErrorCode).toBeUndefined();
    expect(state.inlineErrorCode).toBeUndefined();
    expect(state.flowState.kind).toBe("awaiting-first-acquisition");
    expect(state.scannerAttemptKey).toBe(
      `awaiting-first-acquisition:${state.flowState.epoch}`,
    );
    expect(observedKinds).toEqual([
      "explain",
      "awaiting-first-acquisition",
    ]);
    stop();
  });

  test("keeps nonterminal rescan feedback local and rejects a terminal/rescan pair", () => {
    const state = createViewState();
    state.acceptExplanation(allConsents);
    const cleanup = deferred<void>();
    const attemptHandle = makeFailureHandle({
      acquisitionId: "rescan-attempt",
      cleanupSettlement: cleanup.promise,
    });
    expect(state.registerWalletScannerAttempt(attemptHandle)).toBe(true);
    const callback = state.walletScannerCallbackForCurrentAttempt();
    const rescan: WalletRecoveryScanRequiresRescan & Readonly<{
      acquisitionId: string;
    }> = Object.freeze({
      status: "rescan",
      reason: "ocr-ambiguous",
      flaggedFaceIndexes: Object.freeze([0]),
      acquisitionId: "rescan-attempt",
    });

    callback(rescan);
    expect(state.flowState.kind).toBe("awaiting-first-acquisition");
    expect(state.rescanReason).toBe("ocr-ambiguous");

    const dispose = jest.fn();
    callback(rescan, makeFailureHandle({
      acquisitionId: "unexpected-terminal",
      dispose,
    }));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(state.flowState.kind).toBe("cleared");
    expect(state.rescanReason).toBeUndefined();
    expect(state.safeErrorCode).toBe("SCANNER_CALLBACK_INVALID");
  });

  test("requires exact candidate/acquisition pairing before entering the flow", () => {
    const state = createViewState();
    state.acceptExplanation(allConsents);
    const exact = makeExactScan({ acquisitionId: "pairing" });
    expect(state.registerWalletScannerAttempt(exact.handle)).toBe(true);
    const callback = state.walletScannerCallbackForCurrentAttempt();
    const mismatchedResult = Object.freeze({
      ...exact.result,
      acquisitionId: "different-attempt",
    });

    callback(mismatchedResult, exact.terminal);
    expect(exact.dispose).toHaveBeenCalledTimes(1);
    expect(state.flowState.kind).toBe("cleared");
    expect(state.safeErrorCode).toBe("SCANNER_CALLBACK_INVALID");
  });

  test("uses only the gate-issued handle snapshot from a descriptor-varying Proxy", async () => {
    const state = createViewState();
    state.acceptExplanation(allConsents);
    const authorityA = makeExactScan({ acquisitionId: "authority-a" });
    const alternateDispose = jest.fn();
    const alternateCleanup = Promise.resolve();
    const descriptorReads = new Map<PropertyKey, number>();
    const proxyTarget = {
      acquisitionId: authorityA.handle.acquisitionId,
      dispose: authorityA.handle.dispose,
      cleanupSettlement: authorityA.handle.cleanupSettlement,
    };
    const varyingHandle = new Proxy(proxyTarget, {
      getOwnPropertyDescriptor: (target, property) => {
        const readCount = (descriptorReads.get(property) ?? 0) + 1;
        descriptorReads.set(property, readCount);
        if (
          property !== "acquisitionId" &&
          property !== "dispose" &&
          property !== "cleanupSettlement"
        ) {
          return Reflect.getOwnPropertyDescriptor(target, property);
        }
        const firstValue = Reflect.get(target, property);
        const laterValue = property === "acquisitionId"
          ? "authority-b"
          : property === "dispose"
            ? alternateDispose
            : alternateCleanup;
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: readCount === 1 ? firstValue : laterValue,
        };
      },
    }) as WalletRecoveryScannerAcquisitionHandle;

    expect(state.registerWalletScannerAttempt(varyingHandle)).toBe(true);
    state.walletScannerCallbackForCurrentAttempt()(
      authorityA.result,
      authorityA.terminal,
    );
    expect(state.flowState.kind).toBe("releasing-first-acquisition");
    await flushMicrotasks();
    expect(state.flowState.kind).toBe("awaiting-physical-break");
    expect(authorityA.dispose).toHaveBeenCalledTimes(1);
    expect(alternateDispose).not.toHaveBeenCalled();
    expect(descriptorReads).toEqual(new Map<PropertyKey, number>([
      ["acquisitionId", 1],
      ["dispose", 1],
      ["cleanupSettlement", 1],
    ]));
  });

  test("does not reread a registered Proxy when it returns as the failure terminal", async () => {
    const state = createViewState();
    state.acceptExplanation(allConsents);
    const cleanup = Promise.resolve();
    const dispose = jest.fn();
    const alternateDispose = jest.fn();
    const descriptorReads = new Map<PropertyKey, number>();
    const source = new Proxy({
      acquisitionId: "failure-authority-a",
      dispose,
      cleanupSettlement: cleanup,
    }, {
      getOwnPropertyDescriptor: (target, property) => {
        const count = (descriptorReads.get(property) ?? 0) + 1;
        descriptorReads.set(property, count);
        const firstValue = Reflect.get(target, property);
        const laterValue = property === "acquisitionId"
          ? "failure-authority-b"
          : property === "dispose"
            ? alternateDispose
            : Promise.resolve();
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: count === 1 ? firstValue : laterValue,
        };
      },
    }) as WalletRecoveryScannerAcquisitionHandle;

    expect(state.registerWalletScannerAttempt(source)).toBe(true);
    state.walletScannerCallbackForCurrentAttempt()(
      createWalletRecoveryScannerAttemptFailure("failure-authority-a"),
      source,
    );
    await flushMicrotasks();

    expect(state.flowState.kind).toBe("failed");
    expect(state.safeErrorCode).toBe("ACQUISITION_FAILED");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(alternateDispose).not.toHaveBeenCalled();
    expect([...descriptorReads.entries()]).toEqual([
      ["acquisitionId", 1],
      ["dispose", 1],
      ["cleanupSettlement", 1],
    ]);
  });

  test("contains hostile scanner callback values as one fixed safe error", () => {
    const state = createViewState();
    state.acceptExplanation(allConsents);
    const dispose = jest.fn();
    const terminal = makeFailureHandle({
      acquisitionId: "hostile-callback",
      dispose,
    });
    expect(state.registerWalletScannerAttempt(terminal)).toBe(true);
    const callback = state.walletScannerCallbackForCurrentAttempt();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(() => callback(
      proxy as unknown as WalletRecoveryScannerResult,
      terminal,
    )).not.toThrow();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(state.flowState.kind).toBe("cleared");
    expect(state.safeErrorCode).toBe("SCANNER_CALLBACK_INVALID");
  });

  test("retains frozen sanitized faces only during review and resyncs a pre-settled release", async () => {
    const state = createViewState();
    state.acceptExplanation(allConsents);
    const review = makeReviewScan({
      acquisitionId: "review-first",
      reviewRequiredPositions: [1],
    });
    expect(state.registerWalletScannerAttempt(review.handle)).toBe(true);
    state.walletScannerCallbackForCurrentAttempt()(review.result, review.terminal);

    expect(state.flowState.kind).toBe("reviewing-first-acquisition");
    expect(state.reviewFaces).toBeDefined();
    expect(state.reviewFaces).not.toBe(baseFaces);
    expect(Object.isFrozen(state.reviewFaces)).toBe(true);
    expect(Object.isFrozen(state.reviewFaces![0])).toBe(true);
    await flushMicrotasks();
    expect(state.flowState.kind).toBe("reviewing-first-acquisition");

    expect(state.completeAcquisitionReview()).toBe(false);
    expect(state.safeErrorCode).toBeUndefined();
    expect(state.inlineErrorCode).toBe("REVIEW_INCOMPLETE");
    expect(state.reviewFaces).toBeDefined();
    expect(state.reviewFace(1)).toBe(true);
    expect(state.completeAcquisitionReview()).toBe(true);
    expect(state.flowState.kind).toBe("releasing-first-acquisition");
    expect(state.reviewFaces).toBeUndefined();
    expect(review.dispose).toHaveBeenCalledTimes(1);

    await flushMicrotasks();
    expect(state.flowState.kind).toBe("awaiting-physical-break");
  });

  test("uses one descriptor-read face snapshot for foundation and review UI", () => {
    const state = createViewState();
    state.acceptExplanation(allConsents);
    const review = makeReviewScan({
      acquisitionId: "descriptor-snapshot",
      reviewRequiredPositions: [1],
    });
    const alternateDigit = baseFaces[0]!.digit === "6" ? "1" : "6";
    const getterFaces = Object.freeze(baseFaces.map((face, index) =>
      Object.freeze(index === 0
        ? { ...face, digit: alternateDigit }
        : {
            letter: face.letter,
            digit: face.digit,
            orientationAsLowercaseLetterTrbl:
              face.orientationAsLowercaseLetterTrbl,
          }))) as unknown as DiceKeyFaces;
    let facesGetterReads = 0;
    const terminalTarget = {
      acquisitionId: review.terminal.acquisitionId,
      faces: baseFaces,
      confidence: "review-required" as const,
      reviewRequiredPositions: review.terminal.reviewRequiredPositions,
      dispose: review.terminal.dispose,
      cleanupSettlement: review.terminal.cleanupSettlement,
    };
    const descriptorAGetterBTerminal = new Proxy(terminalTarget, {
      get: (target, property, receiver) => {
        if (property === "faces") {
          facesGetterReads += 1;
          return getterFaces;
        }
        return Reflect.get(target, property, receiver);
      },
    }) as WalletRecoveryScannerAcquisition;

    expect(state.registerWalletScannerAttempt(review.handle)).toBe(true);
    state.walletScannerCallbackForCurrentAttempt()(
      review.result,
      descriptorAGetterBTerminal,
    );

    expect(facesGetterReads).toBe(0);
    expect(state.flowState.kind).toBe("reviewing-first-acquisition");
    expect(state.reviewFaces?.[0]?.digit).toBe(baseFaces[0]!.digit);
    expect(state.reviewFaces?.[0]?.digit).not.toBe(alternateDigit);
    const foundationFaces = (
      state as unknown as {
        readonly recoveryFlow: { readonly firstFaces?: DiceKeyFaces };
      }
    ).recoveryFlow.firstFaces;
    expect(foundationFaces).toBe(state.reviewFaces);
    state.clear();
    expect(facesGetterReads).toBe(0);
  });

  test("updates the review snapshot after an explicit correction", () => {
    const state = createViewState();
    state.acceptExplanation(allConsents);
    const review = makeReviewScan({
      acquisitionId: "correct-first",
      reviewRequiredPositions: [1],
    });
    expect(state.registerWalletScannerAttempt(review.handle)).toBe(true);
    state.walletScannerCallbackForCurrentAttempt()(review.result, review.terminal);
    const original = state.reviewFaces![0]!;
    const corrected = Object.freeze({
      letter: original.letter,
      digit: original.digit === "6" ? "1" : "6",
      orientationAsLowercaseLetterTrbl:
        original.orientationAsLowercaseLetterTrbl,
    });

    expect(state.reviewFace(1, corrected)).toBe(true);
    expect(state.reviewFaces![0]).toEqual(corrected);
    expect(Object.isFrozen(state.reviewFaces![0])).toBe(true);
  });

  test("shares one descriptor-read correction snapshot with foundation and UI", () => {
    const state = createViewState();
    state.acceptExplanation(allConsents);
    const review = makeReviewScan({
      acquisitionId: "proxy-correction",
      reviewRequiredPositions: [1],
    });
    expect(state.registerWalletScannerAttempt(review.handle)).toBe(true);
    state.walletScannerCallbackForCurrentAttempt()(review.result, review.terminal);
    const original = state.reviewFaces![0]!;
    const descriptorDigit = original.digit === "1" ? "2" : "1";
    const getterDigit = descriptorDigit === "1" ? "2" : "1";
    let getterReads = 0;
    const correctionTarget = {
      letter: original.letter,
      digit: descriptorDigit,
      orientationAsLowercaseLetterTrbl:
        original.orientationAsLowercaseLetterTrbl,
    };
    const descriptorAGetterB = new Proxy(correctionTarget, {
      get: (target, property, receiver) => {
        getterReads += 1;
        return property === "digit"
          ? getterDigit
          : Reflect.get(target, property, receiver);
      },
    }) as RecoveryDiceKeyFace;

    expect(state.reviewFace(1, descriptorAGetterB)).toBe(true);
    expect(getterReads).toBe(0);
    const displayedCorrection = state.reviewFaces![0]!;
    expect(displayedCorrection.digit).toBe(descriptorDigit);
    expect(displayedCorrection.digit).not.toBe(getterDigit);
    expect(Object.isFrozen(displayedCorrection)).toBe(true);
    const foundationFaces = (
      state as unknown as {
        readonly recoveryFlow: { readonly firstFaces?: DiceKeyFaces };
      }
    ).recoveryFlow.firstFaces;
    expect(foundationFaces?.[0]).toBe(displayedCorrection);
    state.clear();
    expect(getterReads).toBe(0);
  });

  test("does not give an invalid first correction snapshot a second read", () => {
    const state = createViewState();
    state.acceptExplanation(allConsents);
    const review = makeReviewScan({
      acquisitionId: "varying-invalid-correction",
      reviewRequiredPositions: [1],
    });
    expect(state.registerWalletScannerAttempt(review.handle)).toBe(true);
    state.walletScannerCallbackForCurrentAttempt()(review.result, review.terminal);
    const original = state.reviewFaces![0]!;
    const descriptorReads = new Map<PropertyKey, number>();
    const getterReads = jest.fn();
    const correction = new Proxy({
      letter: original.letter,
      digit: original.digit,
      orientationAsLowercaseLetterTrbl:
        original.orientationAsLowercaseLetterTrbl,
    }, {
      get: (target, property, receiver) => {
        getterReads(property);
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor: (target, property) => {
        const count = (descriptorReads.get(property) ?? 0) + 1;
        descriptorReads.set(property, count);
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        return property === "digit" && count === 1 && descriptor != null
          ? { ...descriptor, value: "9" }
          : descriptor;
      },
    }) as RecoveryDiceKeyFace;

    expect(state.reviewFace(1, correction)).toBe(false);
    expect(state.flowState.kind).toBe("cleared");
    expect(state.reviewFaces).toBeUndefined();
    expect(state.safeErrorCode).toBe("INVALID_ACQUISITION");
    expect(descriptorReads.get("digit")).toBe(1);
    expect(getterReads).not.toHaveBeenCalled();
  });

  test("resyncs scanner failure cleanup rejection to the fixed disposal code", async () => {
    const cleanup = deferred<void>();
    const state = createViewState();
    state.acceptExplanation(allConsents);
    const handle = makeFailureHandle({
      acquisitionId: "failed-attempt",
      cleanupSettlement: cleanup.promise,
    });
    expect(state.registerWalletScannerAttempt(handle)).toBe(true);

    state.walletScannerCallbackForCurrentAttempt()(
      createWalletRecoveryScannerAttemptFailure(handle.acquisitionId),
      handle,
    );
    expect(state.flowState).toEqual(expect.objectContaining({
      kind: "failed",
      code: "ACQUISITION_FAILED",
    }));
    cleanup.reject(new Error("detail must not escape"));
    await flushMicrotasks();
    expect(state.flowState.kind).toBe("cleared");
    expect(state.safeErrorCode).toBe("ACQUISITION_DISPOSAL_FAILED");
  });

  test("publishes deriving synchronously and concealed after async derivation", async () => {
    const derivation = deferred<WalletMnemonicResult>();
    const state = createViewState({
      deriveWalletMnemonic: () => derivation.promise,
    });
    await driveToMatched(state);

    const completion = state.beginDerivation();
    expect(state.flowState.kind).toBe("deriving");
    derivation.resolve(walletResult);
    await expect(completion).resolves.toBe(true);
    expect(state.flowState).toEqual(expect.objectContaining({
      kind: "concealed",
      profileId: DK_BIP39_24_V1.id,
      checkCode,
    }));
  });

  test("binds callbacks to the old epoch and requires a distinct adapter for restart", () => {
    const oldState = createViewState();
    oldState.acceptExplanation(allConsents);
    const oldCallback = oldState.walletScannerCallbackForCurrentAttempt();
    const staleScan = makeExactScan({ acquisitionId: "stale-attempt" });
    const replacement = oldState.createFresh();

    expect(replacement).not.toBe(oldState);
    expect(oldState.flowState.kind).toBe("cleared");
    expect(replacement.flowState.kind).toBe("explain");
    expect(replacement.navState.path).toBe("/wallet-recovery");
    oldCallback(staleScan.result, staleScan.terminal);
    expect(staleScan.dispose).toHaveBeenCalledTimes(1);
    expect(oldState.flowState.kind).toBe("cleared");
    expect(replacement.flowState.kind).toBe("explain");
  });

  test("createFresh cannot bypass cleanup that is still pending", async () => {
    const gate = new WalletRecoverySessionGate();
    const cleanup = deferred<void>();
    const state = createViewState({}, gate);
    state.acceptExplanation(allConsents);
    const attempt = makeExactScan({
      acquisitionId: "pending-before-restart",
      cleanupSettlement: cleanup.promise,
    });
    expect(state.registerWalletScannerAttempt(attempt.handle)).toBe(true);
    expect(state.sessionGateStatus).toBe("pending");

    const replacement = state.createFresh();
    expect(attempt.dispose).toHaveBeenCalledTimes(1);
    expect(replacement.sessionGateStatus).toBe("pending");
    expect(replacement.canBeginRecovery).toBe(false);
    expect(replacement.acceptExplanation(allConsents)).toBe(false);
    expect(replacement.flowState.kind).toBe("explain");

    cleanup.resolve(undefined);
    await flushMicrotasks();
    expect(replacement.sessionGateStatus).toBe("idle");
    expect(replacement.acceptExplanation(allConsents)).toBe(true);
  });

  test("exit clear and back-style unmount keep the renderer gate pending", async () => {
    const exerciseClear = async (
      clearState: (state: WalletRecoveryViewState) => void,
      acquisitionId: string,
    ): Promise<void> => {
      const gate = new WalletRecoverySessionGate();
      const cleanup = deferred<void>();
      const state = createViewState({}, gate);
      state.acceptExplanation(allConsents);
      const attempt = makeExactScan({ acquisitionId, cleanupSettlement: cleanup.promise });
      expect(state.registerWalletScannerAttempt(attempt.handle)).toBe(true);

      clearState(state);
      await flushMicrotasks();
      const nextState = createViewState({}, gate);
      expect(state.flowState.kind).toBe("cleared");
      expect(nextState.sessionGateStatus).toBe("pending");
      expect(nextState.acceptExplanation(allConsents)).toBe(false);
      cleanup.resolve(undefined);
      await flushMicrotasks();
      expect(nextState.sessionGateStatus).toBe("idle");
    };

    await exerciseClear((state) => state.clear(), "exit-pending");
    await exerciseClear((state) => {
      const unmount = state.mountView();
      unmount();
    }, "back-pending");
  });

  test("rejected cleanup poisons every replacement until renderer restart", async () => {
    const gate = new WalletRecoverySessionGate();
    const cleanup = deferred<void>();
    const state = createViewState({}, gate);
    state.acceptExplanation(allConsents);
    const attempt = makeExactScan({
      acquisitionId: "poisoned-attempt",
      cleanupSettlement: cleanup.promise,
    });
    expect(state.registerWalletScannerAttempt(attempt.handle)).toBe(true);
    const replacement = state.createFresh();

    cleanup.reject(new Error("cleanup unconfirmed"));
    await flushMicrotasks();
    expect(replacement.sessionGateStatus).toBe("unconfirmed");
    expect(replacement.canBeginRecovery).toBe(false);
    expect(replacement.acceptExplanation(allConsents)).toBe(false);
    const anotherReplacement = replacement.createFresh();
    expect(anotherReplacement.sessionGateStatus).toBe("unconfirmed");
    expect(anotherReplacement.acceptExplanation(allConsents)).toBe(false);
    expect(anotherReplacement.flowState.kind).toBe("explain");
  });

  test("a StrictMode orphan cannot admit a later stage or material", async () => {
    const gate = new WalletRecoverySessionGate();
    const state = createViewState({}, gate);
    await driveToAwaitingSecond(state);
    const orphanCleanup = deferred<void>();
    const orphan = makeFailureHandle({
      acquisitionId: "second-stage-strict-orphan",
      cleanupSettlement: orphanCleanup.promise,
    });
    const current = makeExactScan({
      acquisitionId: "second-stage-current",
    });
    expect(state.registerWalletScannerAttempt(orphan)).toBe(true);
    expect(state.registerWalletScannerAttempt(current.handle)).toBe(true);
    expect(orphan.dispose).toHaveBeenCalledTimes(1);

    state.walletScannerCallbackForCurrentAttempt()(
      current.result,
      current.terminal,
    );
    expect(state.flowState.kind).toBe("releasing-second-acquisition");
    expect(state.sessionGateStatus).toBe("pending");
    await flushMicrotasks();
    expect(state.flowState.kind).toBe("cleared");
    expect(state.sessionGateStatus).toBe("pending");
    expect(state.safeErrorCode).toBe("ACQUISITION_DISPOSAL_FAILED");
    await expect(state.beginDerivation()).resolves.toBe(false);
    expect(state.reveal()).toBe(false);

    orphanCleanup.reject(new Error("late orphan cleanup rejection"));
    await flushMicrotasks();
    expect(state.flowState.kind).toBe("cleared");
    expect(state.reviewFaces).toBeUndefined();
    expect(state.safeErrorCode).toBe("ACQUISITION_DISPOSAL_FAILED");
    expect(state.reveal()).toBe(false);
  });

  test("a first-stage orphan blocks the distinct second awaiting epoch", async () => {
    const gate = new WalletRecoverySessionGate();
    const state = createViewState({}, gate);
    state.acceptExplanation(allConsents);
    const orphanCleanup = deferred<void>();
    const orphan = makeFailureHandle({
      acquisitionId: "first-stage-strict-orphan",
      cleanupSettlement: orphanCleanup.promise,
    });
    const current = makeExactScan({
      acquisitionId: "first-stage-current",
    });
    expect(state.registerWalletScannerAttempt(orphan)).toBe(true);
    expect(state.registerWalletScannerAttempt(current.handle)).toBe(true);
    state.walletScannerCallbackForCurrentAttempt()(
      current.result,
      current.terminal,
    );
    expect(state.flowState.kind).toBe("releasing-first-acquisition");
    expect(state.sessionGateStatus).toBe("pending");
    await flushMicrotasks();
    expect(state.flowState.kind).toBe("cleared");
    expect(state.sessionGateStatus).toBe("pending");
    expect(state.acknowledgePhysicalBreak()).toBe(false);
    expect(state.safeErrorCode).toBe("ACQUISITION_DISPOSAL_FAILED");

    orphanCleanup.resolve(undefined);
    await flushMicrotasks();
    expect(state.sessionGateStatus).toBe("idle");
    expect(state.flowState.kind).toBe("cleared");
  });

  test("an unconfirmed renderer cleanup synchronously clears revealed words", async () => {
    const gate = new WalletRecoverySessionGate();
    const state = createViewState({}, gate);
    await driveToMatched(state);
    expect(await state.beginDerivation()).toBe(true);
    expect(state.reveal()).toBe(true);
    expect(state.flowState.kind).toBe("revealed");
    const cleanup = deferred<void>();
    const owner = Object.freeze({});
    const handle = makeFailureHandle({
      acquisitionId: "late-renderer-cleanup",
      cleanupSettlement: cleanup.promise,
    });
    const token = gate.registerAttempt(owner, handle);
    expect(token).toBeDefined();
    expect(gate.disposeAttempt(owner, token!)).toBe(true);

    cleanup.reject(new Error("late renderer cleanup rejection"));
    await Promise.resolve();
    expect(state.flowState.kind).toBe("cleared");
    expect(state.safeErrorCode).toBe("ACQUISITION_DISPOSAL_FAILED");
    expect(state.reviewFaces).toBeUndefined();
    expect("wordEntries" in state.flowState).toBe(false);
    expect((
      state as unknown as {
        readonly recoveryFlow: { readonly wordEntries?: readonly RecoveryWordEntry[] };
      }
    ).recoveryFlow.wordEntries).toBeUndefined();
    expect(state.reveal()).toBe(false);
  });

  test("a stale pending terminal clears revealed words before continue", async () => {
    const gate = new WalletRecoverySessionGate();
    const state = createViewState({}, gate);
    await driveToAwaitingSecond(state);
    const second = makeExactScan({ acquisitionId: "stale-callback-source" });
    expect(state.registerWalletScannerAttempt(second.handle)).toBe(true);
    const staleCallback = state.walletScannerCallbackForCurrentAttempt();
    staleCallback(second.result, second.terminal);
    await flushMicrotasks();
    expect(state.flowState.kind).toBe("matched");
    expect(await state.beginDerivation()).toBe(true);
    expect(state.reveal()).toBe(true);
    expect(state.flowState.kind).toBe("revealed");

    const staleCleanup = deferred<void>();
    const staleDispose = jest.fn();
    const staleTerminal = makeFailureHandle({
      acquisitionId: "late-stale-terminal",
      cleanupSettlement: staleCleanup.promise,
      dispose: staleDispose,
    });
    staleCallback(
      createWalletRecoveryScannerAttemptFailure(staleTerminal.acquisitionId),
      staleTerminal,
    );

    expect(staleDispose).toHaveBeenCalledTimes(1);
    expect(state.sessionGateStatus).toBe("pending");
    expect(state.flowState.kind).toBe("cleared");
    expect(state.safeErrorCode).toBe("ACQUISITION_DISPOSAL_FAILED");
    expect(state.reviewFaces).toBeUndefined();
    expect((
      state as unknown as {
        readonly recoveryFlow: { readonly wordEntries?: readonly RecoveryWordEntry[] };
      }
    ).recoveryFlow.wordEntries).toBeUndefined();
    expect(state.continueToBackupChoice()).toBe(false);
    expect(state.safeErrorCode).toBe("ACQUISITION_DISPOSAL_FAILED");
    staleCleanup.resolve(undefined);
    await flushMicrotasks();
    expect(state.sessionGateStatus).toBe("idle");
  });

  test("createFresh cannot hide a throwing accepted disposer behind fulfillment", async () => {
    const gate = new WalletRecoverySessionGate();
    const cleanup = deferred<void>();
    const dispose = jest.fn(() => {
      throw new Error("cleanup did not start");
    });
    const state = createViewState({}, gate);
    state.acceptExplanation(allConsents);
    const attempt = makeExactScan({
      acquisitionId: "throwing-clear-disposer",
      cleanupSettlement: cleanup.promise,
      dispose,
    });
    expect(state.registerWalletScannerAttempt(attempt.handle)).toBe(true);

    const replacement = state.createFresh();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(replacement.sessionGateStatus).toBe("unconfirmed");
    cleanup.resolve(undefined);
    await flushMicrotasks();
    expect(replacement.sessionGateStatus).toBe("unconfirmed");
    expect(replacement.acceptExplanation(allConsents)).toBe(false);
  });

  test("flow-owned disposal reports a synchronous throw to the session gate", async () => {
    const gate = new WalletRecoverySessionGate();
    const cleanup = deferred<void>();
    const dispose = jest.fn(() => {
      throw new Error("terminal cleanup did not start");
    });
    const state = createViewState({}, gate);
    state.acceptExplanation(allConsents);
    const attempt = makeExactScan({
      acquisitionId: "throwing-terminal-disposer",
      cleanupSettlement: cleanup.promise,
      dispose,
    });
    expect(state.registerWalletScannerAttempt(attempt.handle)).toBe(true);

    state.walletScannerCallbackForCurrentAttempt()(
      attempt.result,
      attempt.terminal,
    );
    expect(state.flowState.kind).toBe("cleared");
    expect(state.safeErrorCode).toBe("ACQUISITION_DISPOSAL_FAILED");
    expect(state.sessionGateStatus).toBe("unconfirmed");
    cleanup.resolve(undefined);
    await flushMicrotasks();
    expect(state.sessionGateStatus).toBe("unconfirmed");
  });

  test("defers zero-lease clear across StrictMode replay but clears a real unmount", async () => {
    const state = createViewState();
    state.acceptExplanation(allConsents);

    const releaseFirstMount = state.mountView();
    releaseFirstMount();
    const releaseStrictModeReplay = state.mountView();
    await flushMicrotasks();
    expect(state.flowState.kind).toBe("awaiting-first-acquisition");

    releaseStrictModeReplay();
    await flushMicrotasks();
    expect(state.flowState.kind).toBe("cleared");
  });

  test("forwards challenge entries transiently without storing their array", async () => {
    const state = createViewState();
    await driveToBackupChoice(state);
    expect(state.chooseBackupVerification("six-word-challenge")).toBe(true);
    if (state.flowState.kind !== "six-word-challenge") {
      throw new Error("expected six-word challenge");
    }
    const challengeEntries: readonly RecoveryWordEntry[] =
      state.flowState.positions.map((position) => ({
        position,
        word: "incorrect",
      }));

    expect(state.submitSixWordChallenge(challengeEntries)).toBe(false);
    expect(Object.values(
      state as unknown as Record<string, unknown>,
    )).not.toContain(challengeEntries);
    expect(state.flowState).toEqual(expect.objectContaining({
      kind: "six-word-challenge",
      feedbackCode: "BACKUP_WORD_MISMATCH",
    }));

    expect(state.returnToBackupChoice()).toBe(true);
    expect(state.chooseBackupVerification("full-entry")).toBe(true);
    const fullEntries = mnemonicWords.map((word, index) => ({
      position: index + 1 as RecoveryWordEntry["position"],
      word,
    }));
    expect(state.submitFullEntry(fullEntries)).toBe(true);
    expect(Object.values(
      state as unknown as Record<string, unknown>,
    )).not.toContain(fullEntries);
    expect(state.flowState).toEqual(expect.objectContaining({
      kind: "verified",
      method: "full-entry",
    }));
  });

  test("secure RNG failure stays inline and preserves private material for full entry", async () => {
    const state = createViewState({
      getRandomValues: () => {
        throw new Error("secure random unavailable");
      },
    });
    await driveToBackupChoice(state);

    expect(state.chooseBackupVerification("six-word-challenge")).toBe(false);
    expect(state.flowState.kind).toBe("backup-choice");
    expect(state.safeErrorCode).toBeUndefined();
    expect(state.inlineErrorCode).toBe("SECURE_RANDOM_UNAVAILABLE");
    expect("wordEntries" in state.flowState).toBe(false);

    expect(state.chooseBackupVerification("full-entry")).toBe(true);
    const fullEntries = mnemonicWords.map((word, index) => ({
      position: index + 1 as RecoveryWordEntry["position"],
      word,
    }));
    expect(state.submitFullEntry(fullEntries)).toBe(true);
    expect(state.flowState.kind).toBe("verified");
  });

  test("illegal transition clears retained words before terminal fixed UI", async () => {
    const state = createViewState();
    await driveToBackupChoice(state);

    expect(state.reveal()).toBe(false);
    expect(state.flowState.kind).toBe("cleared");
    expect(state.inlineErrorCode).toBeUndefined();
    expect(state.safeErrorCode).toBe("ILLEGAL_TRANSITION");
  });

  test("a recoverable code from the wrong screen clears private material", async () => {
    const state = createViewState();
    await driveToBackupChoice(state);
    const flow = (
      state as unknown as {
        readonly recoveryFlow: {
          chooseBackupVerification: (mode: string) => void;
        };
      }
    ).recoveryFlow;
    flow.chooseBackupVerification = () => {
      throw new RecoveryTransitionError("REVIEW_INCOMPLETE");
    };

    expect(state.chooseBackupVerification("full-entry")).toBe(false);
    expect(state.flowState.kind).toBe("cleared");
    expect(state.inlineErrorCode).toBeUndefined();
    expect(state.safeErrorCode).toBe("UNEXPECTED_UI_FAILURE");
  });

  test("unknown backup mode clears instead of defaulting to full entry", async () => {
    const state = createViewState();
    await driveToBackupChoice(state);

    expect(state.chooseBackupVerification(
      "unknown-mode" as unknown as "full-entry",
    )).toBe(false);
    expect(state.flowState.kind).toBe("cleared");
    expect(state.safeErrorCode).toBe("ILLEGAL_TRANSITION");
  });
});
