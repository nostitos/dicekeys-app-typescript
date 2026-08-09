import {
  action,
  computed,
  makeObservable,
  observable,
} from "mobx";

import type {
  WalletRecoveryScannerAcquisitionHandle,
} from "../LoadingDiceKeys/wallet-recovery-scanner-acquisition";

export type WalletRecoverySessionCleanupStatus =
  | "idle"
  | "pending"
  | "unconfirmed";

export type WalletRecoverySessionOwner = object;

/** The sole descriptor snapshot shared by the gate and its adapter caller. */
export interface WalletRecoveryRegisteredScannerHandle {
  readonly source: WalletRecoveryScannerAcquisitionHandle;
  readonly acquisitionId: string;
  readonly dispose: () => void;
  readonly cleanupSettlement: Promise<void>;
}

interface PendingCleanupRegistration {
  readonly owner: WalletRecoverySessionOwner;
  readonly token: WalletRecoveryRegisteredScannerHandle;
  disposalInitiated: boolean;
  settlementObserved: boolean;
  settled: boolean;
}

const isInspectableCarrier = (
  candidate: unknown,
): candidate is object | ((...args: never[]) => unknown) =>
  candidate != null &&
  (typeof candidate === "object" || typeof candidate === "function");

const isNonArrayObject = (
  candidate: unknown,
): candidate is Record<string, unknown> => {
  if (typeof candidate !== "object" || candidate == null) return false;
  try {
    return !Array.isArray(candidate);
  } catch {
    return false;
  }
};

const isGenuinePromise = (candidate: unknown): candidate is Promise<void> => {
  try {
    return candidate instanceof Promise;
  } catch {
    return false;
  }
};

const genuineOwnCleanupSettlement = (
  candidate: unknown,
): Promise<void> | undefined => {
  if (!isInspectableCarrier(candidate)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      candidate,
      "cleanupSettlement",
    );
    return descriptor != null &&
        "value" in descriptor &&
        isGenuinePromise(descriptor.value)
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
};

const observeMalformedCleanupSettlement = (candidate: unknown): void => {
  const settlement = genuineOwnCleanupSettlement(candidate);
  if (settlement == null) return;
  try {
    void Promise.prototype.then.call(
      settlement,
      () => undefined,
      () => undefined,
    );
  } catch {}
};

const snapshotExactHandle = (
  candidate: unknown,
): WalletRecoveryRegisteredScannerHandle | undefined => {
  if (!isNonArrayObject(candidate)) return undefined;
  try {
    const keys = Reflect.ownKeys(candidate);
    if (
      keys.length !== 3 ||
      !keys.includes("acquisitionId") ||
      !keys.includes("dispose") ||
      !keys.includes("cleanupSettlement")
    ) {
      return undefined;
    }
    const acquisitionIdDescriptor = Object.getOwnPropertyDescriptor(
      candidate,
      "acquisitionId",
    );
    const disposeDescriptor = Object.getOwnPropertyDescriptor(
      candidate,
      "dispose",
    );
    const cleanupDescriptor = Object.getOwnPropertyDescriptor(
      candidate,
      "cleanupSettlement",
    );
    if (
      acquisitionIdDescriptor == null ||
      !("value" in acquisitionIdDescriptor) ||
      typeof acquisitionIdDescriptor.value !== "string" ||
      acquisitionIdDescriptor.value.length === 0 ||
      acquisitionIdDescriptor.value.length > 256 ||
      disposeDescriptor == null ||
      !("value" in disposeDescriptor) ||
      typeof disposeDescriptor.value !== "function" ||
      cleanupDescriptor == null ||
      !("value" in cleanupDescriptor) ||
      !isGenuinePromise(cleanupDescriptor.value)
    ) {
      return undefined;
    }
    return Object.freeze({
      source: candidate as unknown as WalletRecoveryScannerAcquisitionHandle,
      acquisitionId: acquisitionIdDescriptor.value,
      dispose: disposeDescriptor.value as () => void,
      cleanupSettlement: cleanupDescriptor.value,
    });
  } catch {
    return undefined;
  }
};

const cleanupHandleFromUnknown = (
  candidate: unknown,
): WalletRecoveryScannerAcquisitionHandle | undefined => {
  if (!isNonArrayObject(candidate)) return undefined;
  try {
    const acquisitionId = Object.getOwnPropertyDescriptor(
      candidate,
      "acquisitionId",
    );
    const dispose = Object.getOwnPropertyDescriptor(candidate, "dispose");
    const cleanupSettlement = Object.getOwnPropertyDescriptor(
      candidate,
      "cleanupSettlement",
    );
    if (
      acquisitionId == null ||
      !("value" in acquisitionId) ||
      typeof acquisitionId.value !== "string" ||
      acquisitionId.value.length === 0 ||
      acquisitionId.value.length > 256 ||
      dispose == null ||
      !("value" in dispose) ||
      typeof dispose.value !== "function" ||
      cleanupSettlement == null ||
      !("value" in cleanupSettlement) ||
      !isGenuinePromise(cleanupSettlement.value)
    ) {
      return undefined;
    }
    return Object.freeze({
      acquisitionId: acquisitionId.value,
      dispose: dispose.value as () => void,
      cleanupSettlement: cleanupSettlement.value as Promise<void>,
    });
  } catch {
    return undefined;
  }
};

/**
 * Renderer-session authority for scanner cleanup.
 *
 * The production singleton intentionally outlives every recovery adapter. A
 * rejected cleanup poisons it until this JavaScript document/renderer is
 * actually replaced. There is deliberately no reset method.
 */
export class WalletRecoverySessionGate {
  private statusSnapshot: WalletRecoverySessionCleanupStatus = "idle";
  private cleanupUnconfirmed = false;
  private readonly pending = new Set<PendingCleanupRegistration>();
  private readonly registrationBySource = new WeakMap<
    object,
    PendingCleanupRegistration
  >();
  private readonly registrationByToken = new WeakMap<
    object,
    PendingCleanupRegistration
  >();

  public constructor() {
    makeObservable<WalletRecoverySessionGate, "statusSnapshot">(this, {
      statusSnapshot: observable.ref,
      status: computed,
      registerAttempt: action,
      disposeAttempt: action,
      trackAndDisposeUnpaired: action,
    });
  }

  public get status(): WalletRecoverySessionCleanupStatus {
    return this.statusSnapshot;
  }

  public get canBeginNewCeremony(): boolean {
    return this.statusSnapshot === "idle";
  }

  /**
   * Returns the sole immutable token only when this attempt belongs to the
   * current stage owner. StrictMode may replace an attempt while that owner's
   * prior cleanup is pending; a distinct stage owner cannot cross the window.
   */
  public registerAttempt = (
    owner: WalletRecoverySessionOwner,
    candidateHandle: WalletRecoveryScannerAcquisitionHandle,
  ): WalletRecoveryRegisteredScannerHandle | undefined => {
    const existing = isInspectableCarrier(candidateHandle)
      ? this.registrationBySource.get(candidateHandle)
      : undefined;
    if (existing != null) {
      return existing.owner === owner &&
        !this.cleanupUnconfirmed &&
        !(existing.disposalInitiated && existing.settled)
        ? existing.token
        : undefined;
    }

    const token = snapshotExactHandle(candidateHandle);
    if (token == null) {
      observeMalformedCleanupSettlement(candidateHandle);
      this.poison();
      this.disposeCandidateBestEffort(candidateHandle);
      return undefined;
    }

    const ownerMayContinue = !this.cleanupUnconfirmed &&
      [...this.pending].every((registration) => registration.owner === owner);
    const registration: PendingCleanupRegistration = {
      owner,
      token,
      disposalInitiated: false,
      settlementObserved: false,
      settled: false,
    };
    this.pending.add(registration);
    this.registrationBySource.set(token.source, registration);
    this.registrationByToken.set(token, registration);
    this.refreshStatus();
    this.observe(registration);

    if (!ownerMayContinue) {
      this.disposeAttempt(owner, token);
    }
    return ownerMayContinue ? token : undefined;
  };

  /**
   * Initiate cleanup for a handle previously accepted for this owner. A
   * synchronous disposer failure permanently makes renderer cleanup
   * unconfirmed, even if a broken handle later fulfills its settlement.
   */
  public disposeAttempt = (
    owner: WalletRecoverySessionOwner,
    candidateToken: WalletRecoveryRegisteredScannerHandle,
  ): boolean => {
    const registration = isInspectableCarrier(candidateToken)
      ? this.registrationByToken.get(candidateToken)
      : undefined;
    if (
      registration == null ||
      registration.owner !== owner
    ) {
      observeMalformedCleanupSettlement(candidateToken);
      this.poison();
      this.disposeCandidateBestEffort(candidateToken);
      return false;
    }
    registration.disposalInitiated = true;
    try {
      registration.token.dispose();
      if (registration.settlementObserved) {
        this.finish(registration);
      }
      return true;
    } catch {
      this.poison();
      if (registration.settlementObserved) {
        this.finish(registration);
      }
      return false;
    }
  };

  /** Track cleanup from a malformed/unpaired callback before making it inert. */
  public trackAndDisposeUnpaired = (
    owner: WalletRecoverySessionOwner,
    candidate: unknown,
  ): void => {
    const handle = cleanupHandleFromUnknown(candidate);
    if (handle == null) {
      observeMalformedCleanupSettlement(candidate);
      this.poison();
      this.disposeCandidateBestEffort(candidate);
      return;
    }
    const token = this.registerAttempt(owner, handle);
    if (token == null) return;
    this.disposeAttempt(owner, token);
  };

  private observe(registration: PendingCleanupRegistration): void {
    try {
      void Promise.prototype.then.call(
        registration.token.cleanupSettlement,
        () => action(() => this.observeSettlement(registration, false))(),
        () => action(() => this.observeSettlement(registration, true))(),
      );
    } catch {
      this.observeSettlement(registration, true);
    }
  }

  private observeSettlement(
    registration: PendingCleanupRegistration,
    rejected: boolean,
  ): void {
    if (registration.settled) return;
    registration.settlementObserved = true;
    if (rejected) this.cleanupUnconfirmed = true;
    if (rejected || registration.disposalInitiated) {
      this.finish(registration);
    }
    this.refreshStatus();
  }

  private finish(registration: PendingCleanupRegistration): void {
    if (registration.settled) return;
    registration.settled = true;
    this.pending.delete(registration);
    this.refreshStatus();
  }

  private poison(): void {
    this.cleanupUnconfirmed = true;
    this.refreshStatus();
  }

  private refreshStatus(): void {
    this.statusSnapshot = this.cleanupUnconfirmed
      ? "unconfirmed"
      : this.pending.size > 0
        ? "pending"
        : "idle";
  }

  private disposeCandidateBestEffort(candidate: unknown): void {
    if (!isInspectableCarrier(candidate)) return;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, "dispose");
      if (
        descriptor != null &&
        "value" in descriptor &&
        typeof descriptor.value === "function"
      ) {
        (descriptor.value as () => void)();
      }
    } catch {}
  }
}

export const walletRecoverySessionGate = new WalletRecoverySessionGate();
