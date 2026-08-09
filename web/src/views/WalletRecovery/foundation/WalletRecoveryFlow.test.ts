import type {
  DiceKeyFaces,
  OrientedFace,
} from "../../../dicekeys/DiceKey";
import { DiceKeyWithoutKeyId } from "../../../dicekeys/DiceKey";
import { rotateDiceKey } from "../../../dicekeys/DiceKey/Rotation";
import {
  DK_BIP39_24_V1,
  type WalletMnemonicResult,
} from "../../../wallet/DiceKeyBip39ProfileV1";
import { WalletRecoveryFlow } from "./WalletRecoveryFlow";
import {
  selectChallengePositions,
  selectRecoveryCheckCode,
  selectRecoveryWordEntries,
} from "./selectors";
import type {
  PhysicalFacePosition,
  RecoveryWordEntry,
  SanitizedDiceKeyAcquisition,
  SecureGetRandomValues,
  WalletRecoveryFlowDependencies,
} from "./types";

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

const deterministicRng: SecureGetRandomValues = <T extends Uint32Array>(
  target: T,
): T => {
  deterministicRngCounter += 1;
  target[0] = deterministicRngCounter;
  return target;
};
let deterministicRngCounter = 0;

const createDependencies = (
  overrides: Partial<WalletRecoveryFlowDependencies> = {},
): WalletRecoveryFlowDependencies => ({
  deriveWalletMnemonic: async (_faces) => walletResult,
  deriveRecoveryProfileCheckCode: async (_result) => checkCode,
  getRandomValues: deterministicRng,
  ...overrides,
});

const makeAcquisition = (
  acquisitionId: string,
  faces: DiceKeyFaces = baseFaces,
  reviewRequiredPositions?: readonly PhysicalFacePosition[],
  dispose: () => void = jest.fn(),
  cleanupSettlement: Promise<void> = Promise.resolve(),
): SanitizedDiceKeyAcquisition => reviewRequiredPositions == null
  ? {
      acquisitionId,
      faces,
      confidence: "trusted",
      dispose,
      cleanupSettlement,
    }
  : {
      acquisitionId,
      faces,
      confidence: "review-required",
      reviewRequiredPositions,
      dispose,
      cleanupSettlement,
    };

const replaceFace = (
  faces: DiceKeyFaces,
  index: number,
  replacement: Partial<OrientedFace>,
): DiceKeyFaces => faces.map((face, faceIndex) => Object.freeze(
  faceIndex === index ? { ...face, ...replacement } : { ...face },
)) as unknown as DiceKeyFaces;

const changeEveryDigit = (faces: DiceKeyFaces): DiceKeyFaces => faces.map(
  (face) => Object.freeze({
    ...face,
    digit: face.digit === "6"
      ? "1"
      : String(Number(face.digit) + 1),
  }) as OrientedFace,
) as unknown as DiceKeyFaces;

const driveToAwaitingSecond = (
  flow: WalletRecoveryFlow,
  first = makeAcquisition("first"),
): Promise<void> => {
  flow.acceptExplanation(allConsents);
  expect(flow.receiveAcquisition(flow.state.epoch, first)).toBe(true);
  expect(flow.state.kind).toBe("releasing-first-acquisition");
  return Promise.resolve().then(() => {
    expect(flow.state.kind).toBe("awaiting-physical-break");
    flow.acknowledgePhysicalBreak();
    expect(flow.state.kind).toBe("awaiting-second-acquisition");
  });
};

const driveToMatched = async (
  flow: WalletRecoveryFlow,
  secondFaces: DiceKeyFaces = rotateDiceKey(baseFaces, 1),
): Promise<void> => {
  await driveToAwaitingSecond(flow);
  expect(flow.receiveAcquisition(
    flow.state.epoch,
    makeAcquisition("second", secondFaces),
  )).toBe(true);
  expect(flow.state.kind).toBe("releasing-second-acquisition");
  await Promise.resolve();
  expect(flow.state.kind).toBe("matched");
};

const driveToConcealed = async (flow: WalletRecoveryFlow): Promise<void> => {
  await driveToMatched(flow);
  await flow.beginDerivation();
  expect(flow.state.kind).toBe("concealed");
};

const driveToBackupChoice = async (flow: WalletRecoveryFlow): Promise<void> => {
  await driveToConcealed(flow);
  flow.reveal();
  flow.continueToBackupChoice();
  expect(flow.state.kind).toBe("backup-choice");
};

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
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

const answerEntries = (
  positions: readonly number[],
  mutatePosition?: number,
): readonly RecoveryWordEntry[] => positions.map((position) => ({
  position: position as RecoveryWordEntry["position"],
  word: position === mutatePosition
    ? "wrong"
    : mnemonicWords[position - 1]!,
}));

describe("WalletRecoveryFlow", () => {
  beforeEach(() => {
    deterministicRngCounter = 0;
  });

  test("requires all explanation consents before accepting a first acquisition", () => {
    const flow = new WalletRecoveryFlow(createDependencies());
    expect(Object.isFrozen(flow.state)).toBe(true);
    expect(() => flow.acceptExplanation({
      ...allConsents,
      computerIsOfflineAndTrusted: false,
    })).toThrow(expect.objectContaining({ code: "CONSENT_REQUIRED" }));
    expect(flow.state).toEqual({ kind: "explain", epoch: 0 });

    flow.acceptExplanation(allConsents);
    expect(flow.state.kind).toBe("awaiting-first-acquisition");
    expect(() => flow.acknowledgePhysicalBreak()).toThrow(
      expect.objectContaining({ code: "ILLEGAL_TRANSITION" }),
    );
  });

  test("gates the physical break on successful first-acquisition cleanup", async () => {
    const disposalOrder: string[] = [];
    const cleanup = deferred<void>();
    const flow = new WalletRecoveryFlow(createDependencies());
    flow.acceptExplanation(allConsents);
    const acquisition = makeAcquisition(
      "first",
      baseFaces,
      undefined,
      () => disposalOrder.push("disposed"),
      cleanup.promise,
    );

    flow.receiveAcquisition(flow.state.epoch, acquisition);
    disposalOrder.push(flow.state.kind);

    expect(disposalOrder).toEqual([
      "disposed",
      "releasing-first-acquisition",
    ]);
    expect(() => flow.acknowledgePhysicalBreak()).toThrow(
      expect.objectContaining({ code: "ILLEGAL_TRANSITION" }),
    );
    cleanup.resolve(undefined);
    await cleanup.promise;
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "awaiting-physical-break",
      firstAcquisitionDisposed: true,
    }));
  });

  test("claims the release epoch before invoking a reentrant disposer", async () => {
    const outerCleanup = deferred<void>();
    const nestedCleanup = deferred<void>();
    const nestedDispose = jest.fn();
    const flow = new WalletRecoveryFlow(createDependencies());
    flow.acceptExplanation(allConsents);
    let nestedAccepted: boolean | undefined;
    const outerDispose = jest.fn(() => {
      nestedAccepted = flow.receiveAcquisition(
        flow.state.epoch,
        makeAcquisition(
          "nested-first",
          changeEveryDigit(baseFaces),
          undefined,
          nestedDispose,
          nestedCleanup.promise,
        ),
      );
    });

    flow.receiveAcquisition(
      flow.state.epoch,
      makeAcquisition(
        "first",
        baseFaces,
        undefined,
        outerDispose,
        outerCleanup.promise,
      ),
    );

    expect(flow.state.kind).toBe("releasing-first-acquisition");
    expect(outerDispose).toHaveBeenCalledTimes(1);
    expect(nestedAccepted).toBe(false);
    expect(nestedDispose).toHaveBeenCalledTimes(1);
    nestedCleanup.reject(new Error("stale nested cleanup"));
    await expect(nestedCleanup.promise).rejects.toThrow(
      "stale nested cleanup",
    );
    expect(flow.state.kind).toBe("releasing-first-acquisition");

    outerCleanup.resolve(undefined);
    await outerCleanup.promise;
    expect(flow.state.kind).toBe("awaiting-physical-break");
    flow.acknowledgePhysicalBreak();
    flow.receiveAcquisition(
      flow.state.epoch,
      makeAcquisition("second", rotateDiceKey(baseFaces, 1)),
    );
    await Promise.resolve();
    expect(flow.state.kind).toBe("matched");
  });

  test("cleanup rejection fails closed before physical break or scan two", async () => {
    const cleanup = deferred<void>();
    const deriveWalletMnemonic = jest.fn(async (_faces: DiceKeyFaces) =>
      walletResult);
    const dispose = jest.fn();
    const flow = new WalletRecoveryFlow(createDependencies({
      deriveWalletMnemonic,
    }));
    flow.acceptExplanation(allConsents);
    flow.receiveAcquisition(
      flow.state.epoch,
      makeAcquisition(
        "first",
        baseFaces,
        undefined,
        dispose,
        cleanup.promise,
      ),
    );

    expect(flow.state.kind).toBe("releasing-first-acquisition");
    const rejectedSecondDispose = jest.fn();
    expect(flow.receiveAcquisition(
      flow.state.epoch,
      makeAcquisition(
        "second",
        rotateDiceKey(baseFaces, 1),
        undefined,
        rejectedSecondDispose,
      ),
    )).toBe(false);
    expect(rejectedSecondDispose).toHaveBeenCalledTimes(1);

    cleanup.reject(new Error("private cleanup failure"));
    await expect(cleanup.promise).rejects.toThrow("private cleanup failure");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "ACQUISITION_DISPOSAL_FAILED",
    }));
    expect(Object.keys(flow.state).sort()).toEqual(["code", "epoch", "kind"]);
    expect(deriveWalletMnemonic).not.toHaveBeenCalled();
  });

  test("scanner-attempt failure uses one fixed code and owns its cleanup", async () => {
    const cleanup = deferred<void>();
    const dispose = jest.fn();
    const deriveWalletMnemonic = jest.fn(async (_faces: DiceKeyFaces) =>
      walletResult);
    const flow = new WalletRecoveryFlow(createDependencies({
      deriveWalletMnemonic,
    }));
    flow.acceptExplanation(allConsents);

    expect(flow.receiveAcquisitionFailure(flow.state.epoch, {
      acquisitionId: "failed-first-attempt",
      dispose,
      cleanupSettlement: cleanup.promise,
    })).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "ACQUISITION_FAILED",
    }));
    expect(Object.keys(flow.state).sort()).toEqual(["code", "epoch", "kind"]);
    expect(deriveWalletMnemonic).not.toHaveBeenCalled();

    cleanup.resolve(undefined);
    await cleanup.promise;
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "ACQUISITION_FAILED",
    }));
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("scanner-attempt cleanup rejection escalates and stale failure is absorbing", async () => {
    const cleanup = deferred<void>();
    const flow = new WalletRecoveryFlow(createDependencies());
    flow.acceptExplanation(allConsents);
    expect(flow.receiveAcquisitionFailure(flow.state.epoch, {
      acquisitionId: "unconfirmed-failed-attempt",
      dispose: jest.fn(),
      cleanupSettlement: cleanup.promise,
    })).toBe(true);
    cleanup.reject(new Error("private scanner cleanup detail"));
    await expect(cleanup.promise).rejects.toThrow(
      "private scanner cleanup detail",
    );
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "ACQUISITION_DISPOSAL_FAILED",
    }));
    expect(JSON.stringify(flow.state)).not.toContain("private scanner");

    flow.clear();
    const clearedState = flow.state;
    const staleCleanup = deferred<void>();
    const staleDispose = jest.fn();
    expect(flow.receiveAcquisitionFailure(clearedState.epoch, {
      acquisitionId: "stale-failed-attempt",
      dispose: staleDispose,
      cleanupSettlement: staleCleanup.promise,
    })).toBe(false);
    expect(staleDispose).toHaveBeenCalledTimes(1);
    staleCleanup.reject(new Error("late stale scanner cleanup"));
    await expect(staleCleanup.promise).rejects.toThrow(
      "late stale scanner cleanup",
    );
    expect(flow.state).toBe(clearedState);
  });

  test("gates comparison and derivation on second-acquisition cleanup", async () => {
    const cleanup = deferred<void>();
    const deriveWalletMnemonic = jest.fn(async (_faces: DiceKeyFaces) =>
      walletResult);
    const flow = new WalletRecoveryFlow(createDependencies({
      deriveWalletMnemonic,
    }));
    await driveToAwaitingSecond(flow);
    flow.receiveAcquisition(
      flow.state.epoch,
      makeAcquisition(
        "second",
        rotateDiceKey(baseFaces, 1),
        undefined,
        jest.fn(),
        cleanup.promise,
      ),
    );

    expect(flow.state.kind).toBe("releasing-second-acquisition");
    expect("comparison" in flow.state).toBe(false);
    expect(() => flow.beginDerivation()).toThrow(
      expect.objectContaining({ code: "ILLEGAL_TRANSITION" }),
    );
    expect(deriveWalletMnemonic).not.toHaveBeenCalled();

    cleanup.resolve(undefined);
    await cleanup.promise;
    expect(flow.state.kind).toBe("matched");
    await flow.beginDerivation();
    expect(deriveWalletMnemonic).toHaveBeenCalledTimes(1);
  });

  test("second-acquisition cleanup rejection never compares or derives", async () => {
    const cleanup = deferred<void>();
    const deriveWalletMnemonic = jest.fn(async (_faces: DiceKeyFaces) =>
      walletResult);
    const flow = new WalletRecoveryFlow(createDependencies({
      deriveWalletMnemonic,
    }));
    await driveToAwaitingSecond(flow);
    flow.receiveAcquisition(
      flow.state.epoch,
      makeAcquisition(
        "second",
        rotateDiceKey(baseFaces, 1),
        undefined,
        jest.fn(),
        cleanup.promise,
      ),
    );

    cleanup.reject(new Error("second cleanup failed"));
    await expect(cleanup.promise).rejects.toThrow("second cleanup failed");
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "ACQUISITION_DISPOSAL_FAILED",
    }));
    expect("comparison" in flow.state).toBe(false);
    expect(deriveWalletMnemonic).not.toHaveBeenCalled();
  });

  test("invalid cleanup promise fails closed without invoking hostile accessors", () => {
    const thenGetter = jest.fn(() => {
      throw new Error("hostile then getter");
    });
    const invalidSettlement: Record<string, unknown> = {};
    Object.defineProperty(invalidSettlement, "then", {
      get: thenGetter,
      enumerable: true,
    });
    const dispose = jest.fn();
    const acquisition = {
      ...makeAcquisition("first", baseFaces, undefined, dispose),
      cleanupSettlement: invalidSettlement as unknown as Promise<void>,
    };
    const flow = new WalletRecoveryFlow(createDependencies());
    flow.acceptExplanation(allConsents);

    expect(() => flow.receiveAcquisition(
      flow.state.epoch,
      acquisition,
    )).not.toThrow();
    expect(thenGetter).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "ACQUISITION_DISPOSAL_FAILED",
    }));
  });

  test("observes cleanup rejection even when dispose is missing or non-callable", async () => {
    const malformedCleanup = deferred<void>();
    const flow = new WalletRecoveryFlow(createDependencies());
    flow.acceptExplanation(allConsents);
    const malformed = {
      ...makeAcquisition("malformed-dispose"),
      dispose: "not-callable",
      cleanupSettlement: malformedCleanup.promise,
    } as unknown as SanitizedDiceKeyAcquisition;

    expect(flow.receiveAcquisition(flow.state.epoch, malformed)).toBe(true);
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "ACQUISITION_DISPOSAL_FAILED",
    }));
    malformedCleanup.reject(new Error("malformed cleanup rejected"));
    await expect(malformedCleanup.promise).rejects.toThrow(
      "malformed cleanup rejected",
    );
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "ACQUISITION_DISPOSAL_FAILED",
    }));

    flow.clear();
    const clearedState = flow.state;
    const staleCleanup = deferred<void>();
    const missingDispose = {
      acquisitionId: "stale-missing-dispose",
      faces: baseFaces,
      confidence: "trusted",
      cleanupSettlement: staleCleanup.promise,
    } as unknown as SanitizedDiceKeyAcquisition;
    expect(flow.receiveAcquisition(clearedState.epoch, missingDispose)).toBe(false);
    staleCleanup.reject(new Error("stale cleanup rejected"));
    await expect(staleCleanup.promise).rejects.toThrow(
      "stale cleanup rejected",
    );
    expect(flow.state).toBe(clearedState);
  });

  test("clear absorbs active and stale cleanup settlement and disposes once", async () => {
    const activeCleanup = deferred<void>();
    const activeDispose = jest.fn();
    const flow = new WalletRecoveryFlow(createDependencies());
    flow.acceptExplanation(allConsents);
    flow.receiveAcquisition(
      flow.state.epoch,
      makeAcquisition(
        "first",
        baseFaces,
        [1],
        activeDispose,
        activeCleanup.promise,
      ),
    );
    flow.clear();
    const clearedState = flow.state;
    flow.clear();
    flow.dispose();
    expect(activeDispose).toHaveBeenCalledTimes(1);
    expect((flow as unknown as {
      activeAcquisitionCleanup?: unknown;
    }).activeAcquisitionCleanup).toBeUndefined();

    activeCleanup.reject(new Error("late active cleanup"));
    await expect(activeCleanup.promise).rejects.toThrow("late active cleanup");
    expect(flow.state).toBe(clearedState);

    const staleCleanup = deferred<void>();
    const staleDispose = jest.fn();
    expect(flow.receiveAcquisition(
      clearedState.epoch,
      makeAcquisition(
        "stale",
        baseFaces,
        undefined,
        staleDispose,
        staleCleanup.promise,
      ),
    )).toBe(false);
    expect(staleDispose).toHaveBeenCalledTimes(1);
    staleCleanup.reject(new Error("late stale cleanup"));
    await expect(staleCleanup.promise).rejects.toThrow("late stale cleanup");
    expect(flow.state).toBe(clearedState);
  });

  test("parses acquisitions through own data properties without invoking accessors", () => {
    const confidenceGetter = jest.fn(() => {
      throw new Error("caller-controlled getter payload");
    });
    const dispose = jest.fn();
    const hostile: Record<string, unknown> = {};
    Object.defineProperties(hostile, {
      acquisitionId: { value: "first", enumerable: true },
      faces: { value: baseFaces, enumerable: true },
      confidence: { get: confidenceGetter, enumerable: true },
      dispose: { value: dispose, enumerable: true },
      cleanupSettlement: { value: Promise.resolve(), enumerable: true },
    });
    const flow = new WalletRecoveryFlow(createDependencies());
    flow.acceptExplanation(allConsents);

    expect(() => flow.receiveAcquisition(
      flow.state.epoch,
      hostile as unknown as SanitizedDiceKeyAcquisition,
    )).not.toThrow();
    expect(confidenceGetter).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "INVALID_ACQUISITION",
    }));
    expect(JSON.stringify(flow.state)).not.toContain("getter payload");
  });

  test("rejects accessors in faces without invoking them", () => {
    const letterGetter = jest.fn(() => {
      throw new Error("face getter payload");
    });
    const hostileFace: Record<string, unknown> = {};
    Object.defineProperties(hostileFace, {
      letter: { get: letterGetter, enumerable: true },
      digit: { value: baseFaces[0]!.digit, enumerable: true },
      orientationAsLowercaseLetterTrbl: {
        value: baseFaces[0]!.orientationAsLowercaseLetterTrbl,
        enumerable: true,
      },
    });
    const hostileFaces = [...baseFaces];
    hostileFaces[0] = hostileFace as unknown as OrientedFace;
    const dispose = jest.fn();
    const flow = new WalletRecoveryFlow(createDependencies());
    flow.acceptExplanation(allConsents);

    expect(() => flow.receiveAcquisition(
      flow.state.epoch,
      makeAcquisition(
        "first",
        hostileFaces as unknown as DiceKeyFaces,
        undefined,
        dispose,
      ),
    )).not.toThrow();
    expect(letterGetter).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "INVALID_ACQUISITION",
    }));
  });

  test("rejects contradictory trusted metadata and non-exact review positions", () => {
    const candidates: SanitizedDiceKeyAcquisition[] = [
      {
        ...makeAcquisition("contradictory"),
        reviewRequiredPositions: [1],
      } as unknown as SanitizedDiceKeyAcquisition,
      makeAcquisition("empty-review", baseFaces, []),
      makeAcquisition("duplicate-review", baseFaces, [1, 1]),
    ];

    for (const candidate of candidates) {
      const flow = new WalletRecoveryFlow(createDependencies());
      flow.acceptExplanation(allConsents);
      expect(() => flow.receiveAcquisition(
        flow.state.epoch,
        candidate,
      )).not.toThrow();
      expect(flow.state).toEqual(expect.objectContaining({
        kind: "failed",
        code: "INVALID_ACQUISITION",
      }));
    }
  });

  test("does not invoke accessors in the review-position array", () => {
    const positionGetter = jest.fn(() => {
      throw new Error("review-position getter payload");
    });
    const positions: unknown[] = [1];
    Object.defineProperty(positions, "0", {
      get: positionGetter,
      enumerable: true,
    });
    const dispose = jest.fn();
    const flow = new WalletRecoveryFlow(createDependencies());
    flow.acceptExplanation(allConsents);

    expect(() => flow.receiveAcquisition(
      flow.state.epoch,
      makeAcquisition(
        "review-accessor",
        baseFaces,
        positions as readonly PhysicalFacePosition[],
        dispose,
      ),
    )).not.toThrow();
    expect(positionGetter).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "INVALID_ACQUISITION",
    }));
  });

  test("revalidates every acquired face array with the Phase 3 validator", () => {
    const duplicateLetterFaces = replaceFace(baseFaces, 0, {
      letter: baseFaces[1]!.letter,
    });
    const dispose = jest.fn();
    const flow = new WalletRecoveryFlow(createDependencies());
    flow.acceptExplanation(allConsents);

    expect(() => flow.receiveAcquisition(
      flow.state.epoch,
      makeAcquisition(
        "duplicate-letter",
        duplicateLetterFaces,
        undefined,
        dispose,
      ),
    )).not.toThrow();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "INVALID_ACQUISITION",
    }));
  });

  test("contains proxy trap failures as fixed payload-free acquisition errors", () => {
    const revoked = Proxy.revocable(makeAcquisition("first"), {});
    revoked.revoke();
    const flow = new WalletRecoveryFlow(createDependencies());
    flow.acceptExplanation(allConsents);

    expect(() => flow.receiveAcquisition(
      flow.state.epoch,
      revoked.proxy,
    )).not.toThrow();
    expect(flow.state.kind).toBe("failed");
    if (flow.state.kind !== "failed") throw new Error("expected failure");
    expect([
      "INVALID_ACQUISITION",
      "ACQUISITION_DISPOSAL_FAILED",
    ]).toContain(flow.state.code);
    expect(Object.keys(flow.state).sort()).toEqual(["code", "epoch", "kind"]);
  });

  test.each(["first", "second"] as const)(
    "requires complete explicit uncertainty review for the %s acquisition",
    async (stage) => {
      const dispose = jest.fn();
      const flow = new WalletRecoveryFlow(createDependencies());
      if (stage === "first") {
        flow.acceptExplanation(allConsents);
      } else {
        await driveToAwaitingSecond(flow);
      }
      flow.receiveAcquisition(
        flow.state.epoch,
        makeAcquisition(
          stage,
          stage === "first" ? baseFaces : rotateDiceKey(baseFaces, 2),
          [1, 25],
          dispose,
        ),
      );
      expect(flow.state.kind).toBe(`reviewing-${stage}-acquisition`);
      expect(dispose).not.toHaveBeenCalled();
      expect(() => flow.completeAcquisitionReview()).toThrow(
        expect.objectContaining({ code: "REVIEW_INCOMPLETE" }),
      );
      flow.reviewFace(1);
      expect(() => flow.reviewFace(2)).toThrow(
        expect.objectContaining({ code: "POSITION_NOT_REVIEWABLE" }),
      );
      expect(() => flow.completeAcquisitionReview()).toThrow(
        expect.objectContaining({ code: "REVIEW_INCOMPLETE" }),
      );
      flow.reviewFace(25);
      flow.reviewFace(25);
      flow.completeAcquisitionReview();

      expect(dispose).toHaveBeenCalledTimes(1);
      expect(flow.state.kind).toBe(
        `releasing-${stage}-acquisition`,
      );
      await Promise.resolve();
      expect(flow.state.kind).toBe(
        stage === "first" ? "awaiting-physical-break" : "matched",
      );
    },
  );

  test("can replace a reviewed face and revalidates the corrected DiceKey", async () => {
    const correctedFace = Object.freeze({
      ...baseFaces[0]!,
      digit: baseFaces[0]!.digit === "1" ? "2" : "1",
    }) as OrientedFace;
    const correctedFaces = replaceFace(baseFaces, 0, correctedFace);
    const deriveWalletMnemonic = jest.fn(async (_faces: DiceKeyFaces) =>
      walletResult);
    const flow = new WalletRecoveryFlow(createDependencies({
      deriveWalletMnemonic,
    }));
    flow.acceptExplanation(allConsents);
    flow.receiveAcquisition(
      flow.state.epoch,
      makeAcquisition("first", baseFaces, [1]),
    );
    flow.reviewFace(1, correctedFace);
    flow.completeAcquisitionReview();
    expect(flow.state.kind).toBe("releasing-first-acquisition");
    await Promise.resolve();
    flow.acknowledgePhysicalBreak();
    flow.receiveAcquisition(
      flow.state.epoch,
      makeAcquisition("second", rotateDiceKey(correctedFaces, 1)),
    );
    expect(flow.state.kind).toBe("releasing-second-acquisition");
    await Promise.resolve();
    expect(flow.state.kind).toBe("matched");

    await flow.beginDerivation();
    expect(deriveWalletMnemonic).toHaveBeenCalledTimes(1);
    expect(deriveWalletMnemonic.mock.calls[0]![0][0]).toEqual(correctedFace);
  });

  test("invalid reviewed-face correction fails with a fixed code and invokes no accessor", () => {
    const getter = jest.fn(() => {
      throw new Error("correction getter payload");
    });
    const correction: Record<string, unknown> = {};
    Object.defineProperties(correction, {
      letter: { get: getter, enumerable: true },
      digit: { value: "1", enumerable: true },
      orientationAsLowercaseLetterTrbl: { value: "t", enumerable: true },
    });
    const dispose = jest.fn();
    const flow = new WalletRecoveryFlow(createDependencies());
    flow.acceptExplanation(allConsents);
    flow.receiveAcquisition(
      flow.state.epoch,
      makeAcquisition("first", baseFaces, [1], dispose),
    );

    expect(() => flow.reviewFace(
      1,
      correction as unknown as OrientedFace,
    )).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "INVALID_ACQUISITION",
    }));
    expect(Object.keys(flow.state).sort()).toEqual(["code", "epoch", "kind"]);
  });

  test("final review validation rejects a duplicate corrected letter", () => {
    const dispose = jest.fn();
    const flow = new WalletRecoveryFlow(createDependencies());
    flow.acceptExplanation(allConsents);
    flow.receiveAcquisition(
      flow.state.epoch,
      makeAcquisition("first", baseFaces, [1], dispose),
    );
    flow.reviewFace(1, Object.freeze({
      ...baseFaces[0]!,
      letter: baseFaces[1]!.letter,
    }));
    expect(() => flow.completeAcquisitionReview()).not.toThrow();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "INVALID_ACQUISITION",
    }));
  });

  test("requires a fresh acquisition id and object for the second scan", async () => {
    const flowWithSameId = new WalletRecoveryFlow(createDependencies());
    await driveToAwaitingSecond(flowWithSameId);
    const repeatedId = makeAcquisition("first", rotateDiceKey(baseFaces, 1));
    flowWithSameId.receiveAcquisition(flowWithSameId.state.epoch, repeatedId);
    expect(flowWithSameId.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "ACQUISITION_REUSED",
    }));

    const flowWithSameObject = new WalletRecoveryFlow(createDependencies());
    const reusedObject = makeAcquisition("first");
    await driveToAwaitingSecond(flowWithSameObject, reusedObject);
    (reusedObject as { acquisitionId: string }).acquisitionId = "second";
    flowWithSameObject.receiveAcquisition(
      flowWithSameObject.state.epoch,
      reusedObject,
    );
    expect(flowWithSameObject.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "ACQUISITION_REUSED",
    }));
  });

  test("disposes and ignores stale scan callbacks after the epoch advances or clears", async () => {
    const flow = new WalletRecoveryFlow(createDependencies());
    flow.acceptExplanation(allConsents);
    const staleEpoch = flow.state.epoch;
    flow.receiveAcquisition(staleEpoch, makeAcquisition("first"));
    const staleDispose = jest.fn();
    expect(flow.receiveAcquisition(
      staleEpoch,
      makeAcquisition("late", baseFaces, undefined, staleDispose),
    )).toBe(false);
    expect(staleDispose).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(flow.state.kind).toBe("awaiting-physical-break");

    flow.clear();
    const clearedState = flow.state;
    const afterClearDispose = jest.fn();
    expect(flow.receiveAcquisition(
      staleEpoch,
      makeAcquisition("later", baseFaces, undefined, afterClearDispose),
    )).toBe(false);
    expect(afterClearDispose).toHaveBeenCalledTimes(1);
    expect(flow.state).toBe(clearedState);
  });

  test("stops on mismatch, reports exact aligned faces, and never derives", async () => {
    const deriveWalletMnemonic = jest.fn(async (_faces: DiceKeyFaces) =>
      walletResult);
    const flow = new WalletRecoveryFlow(createDependencies({
      deriveWalletMnemonic,
    }));
    await driveToAwaitingSecond(flow);
    const changed = replaceFace(baseFaces, 6, {
      digit: baseFaces[6]!.digit === "1" ? "2" : "1",
    });
    flow.receiveAcquisition(flow.state.epoch, makeAcquisition("second", changed));
    expect(flow.state.kind).toBe("releasing-second-acquisition");
    await Promise.resolve();

    expect(flow.state.kind).toBe("mismatch");
    expect(deriveWalletMnemonic).not.toHaveBeenCalled();
    expect(() => flow.beginDerivation()).toThrow(
      expect.objectContaining({ code: "ILLEGAL_TRANSITION" }),
    );
    if (flow.state.kind !== "mismatch") throw new Error("expected mismatch");
    expect(flow.state.comparison.bestComparison.differences).toEqual([{
      position: 7,
      row: 2,
      column: 2,
      fields: ["digit"],
      firstScanFace: baseFaces[6],
      secondScanFace: changed[6],
    }]);
    expect(Object.keys(flow.state.comparison).sort()).toEqual([
      "bestComparison",
      "kind",
    ]);
    flow.clear();
    expect("comparison" in flow.state).toBe(false);
    const newFlow = new WalletRecoveryFlow(createDependencies());
    expect("comparison" in newFlow.state).toBe(false);
  });

  test("surfaces tied minimum mismatches as alignment-ambiguous", async () => {
    const flow = new WalletRecoveryFlow(createDependencies());
    await driveToAwaitingSecond(flow);
    flow.receiveAcquisition(
      flow.state.epoch,
      makeAcquisition("second", changeEveryDigit(baseFaces)),
    );
    await Promise.resolve();

    expect(flow.state.kind).toBe("alignment-ambiguous");
    if (flow.state.kind !== "alignment-ambiguous") {
      throw new Error("expected ambiguous comparison");
    }
    expect(flow.state.comparison.tiedComparisons).toHaveLength(4);
    expect(Object.keys(flow.state.comparison).sort()).toEqual([
      "kind",
      "tiedComparisons",
    ]);
  });

  test("starts derivation exactly once and drops acquisition state synchronously", async () => {
    const pendingResult = deferred<WalletMnemonicResult>();
    const deriveWalletMnemonic = jest.fn(
      (_faces: DiceKeyFaces) => pendingResult.promise,
    );
    const flow = new WalletRecoveryFlow(createDependencies({
      deriveWalletMnemonic,
    }));
    await driveToMatched(flow);

    const firstCall = flow.beginDerivation();
    const secondCall = flow.beginDerivation();
    expect(firstCall).toBe(secondCall);
    expect(deriveWalletMnemonic).toHaveBeenCalledTimes(1);
    expect(flow.state).toEqual(expect.objectContaining({ kind: "deriving" }));
    expect(JSON.stringify(flow.state)).not.toMatch(/faces|acquisition/i);
    const privateState = flow as unknown as {
      readonly firstFaces?: DiceKeyFaces;
      readonly secondFaces?: DiceKeyFaces;
    };
    expect(privateState.firstFaces).toBeUndefined();
    expect(privateState.secondFaces).toBeUndefined();

    pendingResult.resolve(walletResult);
    await firstCall;
    expect(flow.state.kind).toBe("concealed");
  });

  test("clear invalidates a late derivation result before check-code work", async () => {
    const pendingResult = deferred<WalletMnemonicResult>();
    const deriveCheckCode = jest.fn(async (_result: WalletMnemonicResult) =>
      checkCode);
    const flow = new WalletRecoveryFlow(createDependencies({
      deriveWalletMnemonic: (_faces) => pendingResult.promise,
      deriveRecoveryProfileCheckCode: deriveCheckCode,
    }));
    await driveToMatched(flow);
    const derivation = flow.beginDerivation();
    flow.clear();
    const clearedState = flow.state;
    expect((flow as unknown as { inFlightDerivation?: Promise<void> })
      .inFlightDerivation).toBeUndefined();

    pendingResult.resolve(walletResult);
    await derivation;
    expect(deriveCheckCode).not.toHaveBeenCalled();
    expect(flow.state).toBe(clearedState);
    expect(flow.state.kind).toBe("cleared");
  });

  test("clear invalidates a late check-code result", async () => {
    const pendingCheckCode = deferred<string>();
    const deriveCheckCode = jest.fn(
      (_result: WalletMnemonicResult) => pendingCheckCode.promise,
    );
    const flow = new WalletRecoveryFlow(createDependencies({
      deriveRecoveryProfileCheckCode: deriveCheckCode,
    }));
    await driveToMatched(flow);
    const derivation = flow.beginDerivation();
    await Promise.resolve();
    expect(deriveCheckCode).toHaveBeenCalledTimes(1);
    flow.clear();
    const clearedState = flow.state;
    expect((flow as unknown as { inFlightDerivation?: Promise<void> })
      .inFlightDerivation).toBeUndefined();

    pendingCheckCode.resolve(checkCode);
    await derivation;
    expect(flow.state).toBe(clearedState);
    expect(selectRecoveryWordEntries(flow.state)).toBeUndefined();
  });

  test("clear releases references to never-settling derivation and check-code work", async () => {
    const neverDerives = new Promise<WalletMnemonicResult>(() => undefined);
    const derivationFlow = new WalletRecoveryFlow(createDependencies({
      deriveWalletMnemonic: (_faces) => neverDerives,
    }));
    await driveToMatched(derivationFlow);
    void derivationFlow.beginDerivation();
    derivationFlow.clear();
    expect((derivationFlow as unknown as {
      inFlightDerivation?: Promise<void>;
    }).inFlightDerivation).toBeUndefined();
    expect(derivationFlow.state.kind).toBe("cleared");

    const neverChecks = new Promise<string>(() => undefined);
    const checkCodeFlow = new WalletRecoveryFlow(createDependencies({
      deriveRecoveryProfileCheckCode: (_result) => neverChecks,
    }));
    await driveToMatched(checkCodeFlow);
    void checkCodeFlow.beginDerivation();
    await Promise.resolve();
    checkCodeFlow.clear();
    expect((checkCodeFlow as unknown as {
      inFlightDerivation?: Promise<void>;
    }).inFlightDerivation).toBeUndefined();
    expect(checkCodeFlow.state.kind).toBe("cleared");
    await Promise.resolve();
    expect(checkCodeFlow.state.kind).toBe("cleared");
  });

  test("passes the exact derivation result to check-code and retains no mnemonic copy", async () => {
    const deriveCheckCode = jest.fn(async (_result: WalletMnemonicResult) =>
      checkCode);
    const flow = new WalletRecoveryFlow(createDependencies({
      deriveRecoveryProfileCheckCode: deriveCheckCode,
    }));
    await driveToConcealed(flow);

    expect(deriveCheckCode).toHaveBeenCalledWith(walletResult);
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "concealed",
      profileId: DK_BIP39_24_V1.id,
      checkCode,
    }));
    expect(Object.keys(flow.state)).not.toContain("mnemonic");
    expect(selectRecoveryWordEntries(flow.state)).toBeUndefined();
    expect(selectRecoveryCheckCode(flow.state)).toBe(checkCode);
  });

  test("uses the frozen production check-code helper when no override is injected", async () => {
    const flow = new WalletRecoveryFlow(createDependencies({
      deriveRecoveryProfileCheckCode: undefined,
    }));
    await driveToConcealed(flow);

    expect(selectRecoveryCheckCode(flow.state)).toBe("521C-BB8C-FD07");
  });

  test.each([
    ["derive", "DERIVATION_FAILED"],
    ["check-code", "CHECK_CODE_FAILED"],
  ] as const)("maps a caught %s error to a fixed code only", async (
    failurePoint,
    expectedCode,
  ) => {
    const secretError = new Error("private error payload");
    const flow = new WalletRecoveryFlow(createDependencies({
      deriveWalletMnemonic: failurePoint === "derive"
        ? async (_faces) => { throw secretError; }
        : async (_faces) => walletResult,
      deriveRecoveryProfileCheckCode: failurePoint === "check-code"
        ? async (_result) => { throw secretError; }
        : async (_result) => checkCode,
    }));
    await driveToMatched(flow);
    await flow.beginDerivation();

    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: expectedCode,
    }));
    expect(Object.keys(flow.state).sort()).toEqual(["code", "epoch", "kind"]);
    expect(JSON.stringify(flow.state)).not.toContain(secretError.message);
  });

  test("rejects mutable or malformed derivation output with no retained words", async () => {
    const mutableResult = {
      profileId: DK_BIP39_24_V1.id,
      words: [...mnemonicWords],
      mnemonic,
    } as WalletMnemonicResult;
    const deriveCheckCode = jest.fn(async (_result: WalletMnemonicResult) =>
      checkCode);
    const flow = new WalletRecoveryFlow(createDependencies({
      deriveWalletMnemonic: async (_faces) => mutableResult,
      deriveRecoveryProfileCheckCode: deriveCheckCode,
    }));
    await driveToMatched(flow);
    await flow.beginDerivation();

    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "INVALID_DERIVATION_RESULT",
    }));
    expect(deriveCheckCode).not.toHaveBeenCalled();
    expect(selectRecoveryWordEntries(flow.state)).toBeUndefined();
  });

  test("never reads a descriptor-validated frozen result through its get trap", async () => {
    const profileGetTrap = jest.fn((): never => {
      throw new Error("proxy get payload");
    });
    const proxiedResult = new Proxy(walletResult, {
      get: (target, property, receiver) => property === "profileId"
        ? profileGetTrap()
        : Reflect.get(target, property, receiver),
    }) as WalletMnemonicResult;
    const flow = new WalletRecoveryFlow(createDependencies({
      deriveWalletMnemonic: async (_faces) => proxiedResult,
    }));
    await driveToMatched(flow);

    await expect(flow.beginDerivation()).resolves.toBeUndefined();
    expect(profileGetTrap).not.toHaveBeenCalled();
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "concealed",
      profileId: DK_BIP39_24_V1.id,
    }));
  });

  test("maps a malformed frozen Proxy result to INVALID_DERIVATION_RESULT", async () => {
    const ownKeysTrap = jest.fn((): never => {
      throw new Error("proxy descriptor payload");
    });
    const proxiedResult = new Proxy(walletResult, {
      ownKeys: ownKeysTrap,
    }) as WalletMnemonicResult;
    const deriveCheckCode = jest.fn(async (_result: WalletMnemonicResult) =>
      checkCode);
    const flow = new WalletRecoveryFlow(createDependencies({
      deriveWalletMnemonic: async (_faces) => proxiedResult,
      deriveRecoveryProfileCheckCode: deriveCheckCode,
    }));
    await driveToMatched(flow);

    await expect(flow.beginDerivation()).resolves.toBeUndefined();
    expect(ownKeysTrap).toHaveBeenCalled();
    expect(deriveCheckCode).not.toHaveBeenCalled();
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "INVALID_DERIVATION_RESULT",
    }));
    expect(Object.keys(flow.state).sort()).toEqual(["code", "epoch", "kind"]);
    expect(JSON.stringify(flow.state)).not.toContain("proxy descriptor payload");
  });

  test("reveals one frozen, stably numbered word-entry array and no mnemonic field", async () => {
    const flow = new WalletRecoveryFlow(createDependencies());
    await driveToConcealed(flow);
    flow.reveal();

    const entries = selectRecoveryWordEntries(flow.state);
    expect(entries).toHaveLength(24);
    expect(entries?.map(({ position }) => position)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    expect(entries?.map(({ word }) => word)).toEqual(mnemonicWords);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(entries?.every(Object.isFrozen)).toBe(true);
    expect(Object.keys(flow.state)).not.toContain("mnemonic");

    flow.continueToBackupChoice();
    expect(selectRecoveryWordEntries(flow.state)).toBeUndefined();
    expect("wordEntries" in flow.state).toBe(false);
  });

  test("conceals entries during a six-word challenge and verifies exact positions", async () => {
    const flow = new WalletRecoveryFlow(createDependencies());
    await driveToBackupChoice(flow);
    flow.chooseBackupVerification("six-word-challenge");

    const positions = selectChallengePositions(flow.state);
    expect(positions).toHaveLength(6);
    expect(selectRecoveryWordEntries(flow.state)).toBeUndefined();
    expect(flow.submitSixWordChallenge(answerEntries(positions!, positions![0])))
      .toBe(false);
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "six-word-challenge",
      feedbackCode: "BACKUP_WORD_MISMATCH",
    }));
    expect(JSON.stringify(flow.state)).not.toContain("wrong");
    expect(flow.submitSixWordChallenge(answerEntries(positions!))).toBe(true);
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "verified",
      method: "six-word-challenge",
    }));
    expect((flow as unknown as { wordEntries?: readonly RecoveryWordEntry[] })
      .wordEntries).toBeUndefined();
  });

  test("switching modes or returning clears feedback and the old challenge", async () => {
    const flow = new WalletRecoveryFlow(createDependencies());
    await driveToBackupChoice(flow);
    flow.chooseBackupVerification("six-word-challenge");
    const firstPositions = selectChallengePositions(flow.state);
    flow.submitSixWordChallenge([]);
    expect(flow.state).toEqual(expect.objectContaining({
      feedbackCode: "BACKUP_ENTRY_INCOMPLETE",
    }));

    flow.chooseBackupVerification("full-entry");
    expect(flow.state).toEqual(expect.objectContaining({ kind: "full-entry" }));
    expect("feedbackCode" in flow.state).toBe(false);
    expect(selectChallengePositions(flow.state)).toBeUndefined();

    flow.returnToBackupChoice();
    expect(flow.state.kind).toBe("backup-choice");
    expect(selectRecoveryWordEntries(flow.state)).toBeUndefined();
    expect("wordEntries" in flow.state).toBe(false);
    flow.chooseBackupVerification("six-word-challenge");
    expect(selectChallengePositions(flow.state)).not.toEqual(firstPositions);
    expect("feedbackCode" in flow.state).toBe(false);
  });

  test("full-entry mode requires all 24 positions and verifies word order", async () => {
    const flow = new WalletRecoveryFlow(createDependencies());
    await driveToBackupChoice(flow);
    flow.chooseBackupVerification("full-entry");

    expect(flow.submitFullEntry(answerEntries([1, 2, 3]))).toBe(false);
    expect(flow.state).toEqual(expect.objectContaining({
      feedbackCode: "BACKUP_ENTRY_INCOMPLETE",
    }));
    const allPositions = Array.from({ length: 24 }, (_, index) => index + 1);
    expect(flow.submitFullEntry(answerEntries(allPositions, 24))).toBe(false);
    expect(flow.state).toEqual(expect.objectContaining({
      feedbackCode: "BACKUP_WORD_MISMATCH",
    }));
    expect(flow.submitFullEntry(answerEntries(allPositions))).toBe(true);
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "verified",
      method: "full-entry",
    }));
  });

  test("acquisition disposal failure produces only its fixed failure code", () => {
    const flow = new WalletRecoveryFlow(createDependencies());
    flow.acceptExplanation(allConsents);
    flow.receiveAcquisition(
      flow.state.epoch,
      makeAcquisition("first", baseFaces, undefined, () => {
        throw new Error("device-specific secret");
      }),
    );

    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "ACQUISITION_DISPOSAL_FAILED",
    }));
    expect(Object.keys(flow.state).sort()).toEqual(["code", "epoch", "kind"]);
    expect(JSON.stringify(flow.state)).not.toContain("device-specific secret");
  });

  test("clear and dispose are legal from every union state and cleared is absorbing", async () => {
    const flows = new Map<string, WalletRecoveryFlow>();
    const record = (flow: WalletRecoveryFlow): WalletRecoveryFlow => {
      flows.set(flow.state.kind, flow);
      return flow;
    };

    record(new WalletRecoveryFlow(createDependencies()));

    const awaitingFirst = new WalletRecoveryFlow(createDependencies());
    awaitingFirst.acceptExplanation(allConsents);
    record(awaitingFirst);

    const reviewingFirst = new WalletRecoveryFlow(createDependencies());
    reviewingFirst.acceptExplanation(allConsents);
    reviewingFirst.receiveAcquisition(
      reviewingFirst.state.epoch,
      makeAcquisition("first", baseFaces, [1]),
    );
    record(reviewingFirst);

    const firstRelease = deferred<void>();
    const releasingFirst = new WalletRecoveryFlow(createDependencies());
    releasingFirst.acceptExplanation(allConsents);
    releasingFirst.receiveAcquisition(
      releasingFirst.state.epoch,
      makeAcquisition(
        "first",
        baseFaces,
        undefined,
        jest.fn(),
        firstRelease.promise,
      ),
    );
    record(releasingFirst);

    const physicalBreak = new WalletRecoveryFlow(createDependencies());
    physicalBreak.acceptExplanation(allConsents);
    physicalBreak.receiveAcquisition(
      physicalBreak.state.epoch,
      makeAcquisition("first"),
    );
    await Promise.resolve();
    record(physicalBreak);

    const awaitingSecond = new WalletRecoveryFlow(createDependencies());
    await driveToAwaitingSecond(awaitingSecond);
    record(awaitingSecond);

    const reviewingSecond = new WalletRecoveryFlow(createDependencies());
    await driveToAwaitingSecond(reviewingSecond);
    reviewingSecond.receiveAcquisition(
      reviewingSecond.state.epoch,
      makeAcquisition("second", baseFaces, [2]),
    );
    record(reviewingSecond);

    const secondRelease = deferred<void>();
    const releasingSecond = new WalletRecoveryFlow(createDependencies());
    await driveToAwaitingSecond(releasingSecond);
    releasingSecond.receiveAcquisition(
      releasingSecond.state.epoch,
      makeAcquisition(
        "second",
        rotateDiceKey(baseFaces, 1),
        undefined,
        jest.fn(),
        secondRelease.promise,
      ),
    );
    record(releasingSecond);

    const matched = new WalletRecoveryFlow(createDependencies());
    await driveToMatched(matched);
    record(matched);

    const mismatch = new WalletRecoveryFlow(createDependencies());
    await driveToAwaitingSecond(mismatch);
    mismatch.receiveAcquisition(
      mismatch.state.epoch,
      makeAcquisition("second", replaceFace(baseFaces, 0, { digit: "6" })),
    );
    await Promise.resolve();
    record(mismatch);

    const ambiguous = new WalletRecoveryFlow(createDependencies());
    await driveToAwaitingSecond(ambiguous);
    ambiguous.receiveAcquisition(
      ambiguous.state.epoch,
      makeAcquisition("second", changeEveryDigit(baseFaces)),
    );
    await Promise.resolve();
    record(ambiguous);

    const neverCompletes = deferred<WalletMnemonicResult>();
    const deriving = new WalletRecoveryFlow(createDependencies({
      deriveWalletMnemonic: (_faces) => neverCompletes.promise,
    }));
    await driveToMatched(deriving);
    void deriving.beginDerivation();
    record(deriving);

    const concealed = new WalletRecoveryFlow(createDependencies());
    await driveToConcealed(concealed);
    record(concealed);

    const revealed = new WalletRecoveryFlow(createDependencies());
    await driveToConcealed(revealed);
    revealed.reveal();
    record(revealed);

    const backupChoice = new WalletRecoveryFlow(createDependencies());
    await driveToBackupChoice(backupChoice);
    record(backupChoice);

    const challenge = new WalletRecoveryFlow(createDependencies());
    await driveToBackupChoice(challenge);
    challenge.chooseBackupVerification("six-word-challenge");
    record(challenge);

    const fullEntry = new WalletRecoveryFlow(createDependencies());
    await driveToBackupChoice(fullEntry);
    fullEntry.chooseBackupVerification("full-entry");
    record(fullEntry);

    const verified = new WalletRecoveryFlow(createDependencies());
    await driveToBackupChoice(verified);
    verified.chooseBackupVerification("full-entry");
    verified.submitFullEntry(answerEntries(
      Array.from({ length: 24 }, (_, index) => index + 1),
    ));
    record(verified);

    const failed = new WalletRecoveryFlow(createDependencies());
    failed.acceptExplanation(allConsents);
    failed.receiveAcquisition(
      failed.state.epoch,
      makeAcquisition("", baseFaces),
    );
    record(failed);

    const alreadyCleared = new WalletRecoveryFlow(createDependencies());
    alreadyCleared.clear();
    record(alreadyCleared);

    expect([...flows.keys()].sort()).toEqual([
      "alignment-ambiguous",
      "awaiting-first-acquisition",
      "awaiting-physical-break",
      "awaiting-second-acquisition",
      "backup-choice",
      "cleared",
      "concealed",
      "deriving",
      "explain",
      "failed",
      "full-entry",
      "matched",
      "mismatch",
      "releasing-first-acquisition",
      "releasing-second-acquisition",
      "revealed",
      "reviewing-first-acquisition",
      "reviewing-second-acquisition",
      "six-word-challenge",
      "verified",
    ]);

    for (const flow of flows.values()) {
      expect(() => flow.clear()).not.toThrow();
      const cleared = flow.state;
      expect(cleared.kind).toBe("cleared");
      expect(() => flow.dispose()).not.toThrow();
      expect(() => flow.acceptExplanation(allConsents)).toThrow(
        expect.objectContaining({ code: "ILLEGAL_TRANSITION" }),
      );
      expect(flow.state).toBe(cleared);
      expect(selectRecoveryWordEntries(flow.state)).toBeUndefined();
    }
  });
});
