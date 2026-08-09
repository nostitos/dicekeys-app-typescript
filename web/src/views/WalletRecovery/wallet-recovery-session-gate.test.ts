import { autorun } from "mobx";

import type {
  WalletRecoveryScannerAcquisitionHandle,
} from "../LoadingDiceKeys/wallet-recovery-scanner-acquisition";
import {
  WalletRecoverySessionGate,
} from "./wallet-recovery-session-gate";

const deferred = (): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
} => {
  let resolvePromise!: () => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

const handle = (
  acquisitionId: string,
  cleanupSettlement: Promise<void>,
  dispose = jest.fn(),
): WalletRecoveryScannerAcquisitionHandle => Object.freeze({
  acquisitionId,
  dispose,
  cleanupSettlement,
});

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
};

describe("WalletRecoverySessionGate", () => {
  test("allows StrictMode replacement for one owner but blocks another owner", async () => {
    const gate = new WalletRecoverySessionGate();
    const owner = {};
    const otherOwner = {};
    const firstCleanup = deferred();
    const replayCleanup = deferred();
    const blockedCleanup = deferred();
    const blockedDispose = jest.fn();
    const observed: string[] = [];
    const stop = autorun(() => observed.push(gate.status));

    const firstHandle = handle("strict-first", firstCleanup.promise);
    const replayHandle = handle("strict-replay", replayCleanup.promise);
    const firstToken = gate.registerAttempt(owner, firstHandle);
    expect(firstToken).toBeDefined();
    expect(gate.status).toBe("pending");
    expect(gate.disposeAttempt(owner, firstToken!)).toBe(true);
    const replayToken = gate.registerAttempt(owner, replayHandle);
    expect(replayToken).toBeDefined();
    expect(gate.registerAttempt(
      otherOwner,
      handle("blocked-fresh", blockedCleanup.promise, blockedDispose),
    )).toBeUndefined();
    expect(blockedDispose).toHaveBeenCalledTimes(1);

    blockedCleanup.resolve();
    firstCleanup.resolve();
    await flushMicrotasks();
    expect(gate.status).toBe("pending");
    expect(gate.disposeAttempt(owner, replayToken!)).toBe(true);
    replayCleanup.resolve();
    await flushMicrotasks();
    expect(gate.status).toBe("idle");
    expect(observed).toEqual(["idle", "pending", "idle"]);
    stop();
  });

  test("returns one canonical snapshot when the same source is registered twice", async () => {
    const gate = new WalletRecoverySessionGate();
    const owner = {};
    const cleanup = deferred();
    const descriptorReads = new Map<PropertyKey, number>();
    const source = new Proxy({
      acquisitionId: "canonical-source",
      dispose: jest.fn(),
      cleanupSettlement: cleanup.promise,
    }, {
      getOwnPropertyDescriptor: (target, property) => {
        descriptorReads.set(property, (descriptorReads.get(property) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    }) as WalletRecoveryScannerAcquisitionHandle;

    const firstToken = gate.registerAttempt(owner, source);
    const repeatedToken = gate.registerAttempt(owner, source);
    expect(firstToken).toBeDefined();
    expect(repeatedToken).toBe(firstToken);
    expect(Object.isFrozen(firstToken)).toBe(true);
    expect([...descriptorReads.entries()]).toEqual([
      ["acquisitionId", 1],
      ["dispose", 1],
      ["cleanupSettlement", 1],
    ]);

    expect(gate.disposeAttempt(owner, firstToken!)).toBe(true);
    cleanup.resolve();
    await flushMicrotasks();
    expect(gate.status).toBe("idle");
  });

  test("cleanup rejection is sticky and disposes every later attempt", async () => {
    const gate = new WalletRecoverySessionGate();
    const failedCleanup = deferred();
    const laterCleanup = deferred();
    const laterDispose = jest.fn();

    expect(gate.registerAttempt(
      {},
      handle("will-reject", failedCleanup.promise),
    )).toBeDefined();
    failedCleanup.reject(new Error("unconfirmed cleanup"));
    await flushMicrotasks();
    expect(gate.status).toBe("unconfirmed");
    expect(gate.canBeginNewCeremony).toBe(false);

    expect(gate.registerAttempt(
      {},
      handle("later", laterCleanup.promise, laterDispose),
    )).toBeUndefined();
    expect(laterDispose).toHaveBeenCalledTimes(1);
    laterCleanup.resolve();
    await flushMicrotasks();
    expect(gate.status).toBe("unconfirmed");
  });

  test("a throwing accepted disposer stays unconfirmed after settlement fulfills", async () => {
    const gate = new WalletRecoverySessionGate();
    const owner = {};
    const cleanup = deferred();
    const throwingDispose = jest.fn(() => {
      throw new Error("cleanup did not start");
    });
    const attempt = handle(
      "throwing-disposer",
      cleanup.promise,
      throwingDispose,
    );

    const token = gate.registerAttempt(owner, attempt);
    expect(token).toBeDefined();
    expect(gate.disposeAttempt(owner, token!)).toBe(false);
    expect(gate.status).toBe("unconfirmed");
    cleanup.resolve();
    await flushMicrotasks();
    expect(gate.status).toBe("unconfirmed");
    expect(gate.canBeginNewCeremony).toBe(false);
  });

  test("invalid cleanup authority poisons the renderer session", () => {
    const gate = new WalletRecoverySessionGate();
    const dispose = jest.fn();
    const invalid = Object.freeze({
      acquisitionId: "invalid",
      dispose,
      cleanupSettlement: "not-a-promise",
    });

    expect(gate.registerAttempt(
      {},
      invalid as unknown as WalletRecoveryScannerAcquisitionHandle,
    )).toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(gate.status).toBe("unconfirmed");
  });

  test("observes a genuine settlement salvaged from an extra-key handle", async () => {
    const gate = new WalletRecoverySessionGate();
    const cleanup = deferred();
    const dispose = jest.fn();
    const unhandledRejection = jest.fn();
    process.on("unhandledRejection", unhandledRejection);
    const malformed = Object.freeze({
      acquisitionId: "extra-key-handle",
      dispose,
      cleanupSettlement: cleanup.promise,
      unexpected: true,
    });

    try {
      expect(gate.registerAttempt(
        {},
        malformed as unknown as WalletRecoveryScannerAcquisitionHandle,
      )).toBeUndefined();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(gate.status).toBe("unconfirmed");
      cleanup.reject(new Error("must be observed by the gate"));
      await flushMicrotasks();
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
    }
  });

  test.each(["array", "function"] as const)(
    "salvages cleanup from a rejected %s carrier without an unhandled rejection",
    async (carrierKind) => {
      const gate = new WalletRecoverySessionGate();
      const cleanup = deferred();
      const dispose = jest.fn();
      const unhandledRejection = jest.fn();
      process.on("unhandledRejection", unhandledRejection);
      const carrier: object = carrierKind === "array" ? [] : (() => undefined);
      Object.assign(carrier, {
        acquisitionId: `${carrierKind}-carrier`,
        dispose,
        cleanupSettlement: cleanup.promise,
      });

      try {
        expect(gate.registerAttempt(
          {},
          carrier as WalletRecoveryScannerAcquisitionHandle,
        )).toBeUndefined();
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(gate.status).toBe("unconfirmed");
        cleanup.reject(new Error(`${carrierKind} cleanup rejection`));
        await flushMicrotasks();
        expect(unhandledRejection).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandledRejection);
      }
    },
  );

  test("malformed cleanup salvage invokes neither accessors nor thenables", () => {
    const gate = new WalletRecoverySessionGate();
    const disposeAccessor = jest.fn();
    const settlementAccessor = jest.fn();
    const accessorCarrier = {};
    Object.defineProperties(accessorCarrier, {
      acquisitionId: { configurable: true, value: "accessor-carrier" },
      dispose: { configurable: true, get: disposeAccessor },
      cleanupSettlement: {
        configurable: true,
        get: settlementAccessor,
      },
    });
    expect(gate.registerAttempt(
      {},
      accessorCarrier as WalletRecoveryScannerAcquisitionHandle,
    )).toBeUndefined();
    expect(disposeAccessor).not.toHaveBeenCalled();
    expect(settlementAccessor).not.toHaveBeenCalled();

    const dispose = jest.fn();
    const then = jest.fn();
    const thenableCarrier = Object.freeze({
      acquisitionId: "thenable-carrier",
      dispose,
      cleanupSettlement: Object.freeze({ then }),
    });
    expect(gate.registerAttempt(
      {},
      thenableCarrier as unknown as WalletRecoveryScannerAcquisitionHandle,
    )).toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(then).not.toHaveBeenCalled();
    expect(gate.status).toBe("unconfirmed");
  });
});
