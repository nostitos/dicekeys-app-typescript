import type {
  ProcessFrameRequest,
  ProcessFrameResponse,
  TerminateSessionRequest,
  TerminateSessionResponse,
  WorkerInitializationFailedMessage,
} from "../../workers/dicekey-image-frame-worker";
import { ScannerOwnedFrameBuffer } from "./wallet-recovery-scanner-frame-buffer";
import { wipeScannerFaceImageResponse } from "./wallet-recovery-scanner-worker-session-handler";

export interface ScannerWorkerLike {
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: EventListener,
  ): void;
  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener: EventListener,
  ): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface DiceKeyFrameWorkerClientOptions {
  readonly createWorker: () => ScannerWorkerLike;
  readonly createSessionId?: () => string;
  readonly createFrameBuffer?: (source: Uint8ClampedArray) => ScannerOwnedFrameBuffer;
  readonly cleanupTimeoutMs?: number;
  /** Undefined preserves the legacy unbounded readiness behavior. */
  readonly workerReadyTimeoutMs?: number;
  /** Undefined preserves the legacy unbounded per-frame behavior. */
  readonly frameResponseTimeoutMs?: number;
}

export const WALLET_RECOVERY_WORKER_READY_TIMEOUT_MS = 15000;
export const WALLET_RECOVERY_FRAME_RESPONSE_TIMEOUT_MS = 10000;

export class ScannerWorkerCleanupUnconfirmedError extends Error {
  readonly name = "ScannerWorkerCleanupUnconfirmedError";

  constructor(readonly cleanupCause?: unknown) {
    super("DiceKey scanner worker cleanup could not be confirmed");
  }
}

type PendingFrameRequest = {
  readonly resolve: (response: ProcessFrameResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timeout?: ReturnType<typeof setTimeout>;
};

let nextScannerSessionNumber = 1;

const createScannerSessionId = (): string => {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid != null) return `dicekey-scan-${randomUuid}`;
  const sessionNumber = nextScannerSessionNumber++;
  return `dicekey-scan-${Date.now().toString(36)}-${sessionNumber.toString(36)}`;
};

const validateOptionalTimeout = (
  timeoutMs: number | undefined,
  name: string,
): number | undefined => {
  if (timeoutMs == null) return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return timeoutMs;
};

const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === "object" && candidate != null;

const isReadyMessage = (candidate: unknown): boolean =>
  isRecord(candidate) && candidate.action === "workerReady";

const isWorkerInitializationFailure = (
  candidate: unknown,
): candidate is WorkerInitializationFailedMessage =>
  isRecord(candidate) &&
  candidate.action === "workerInitializationFailed" &&
  typeof candidate.message === "string";

const isMatchingFrameResponse = (
  candidate: unknown,
  sessionId: string,
): candidate is ProcessFrameResponse =>
  isRecord(candidate) &&
  candidate.action === "processRGBAImageFrame" &&
  candidate.sessionId === sessionId &&
  typeof candidate.requestId === "number";

const isMatchingTerminationResponse = (
  candidate: unknown,
  sessionId: string,
  requestId: number,
): candidate is TerminateSessionResponse =>
  isRecord(candidate) &&
  candidate.action === "sessionTerminated" &&
  candidate.sessionId === sessionId &&
  candidate.requestId === requestId;

/**
 * Owns exactly one worker and one scanner session. Responses only resolve the
 * request with the same action, session id, and request id.
 */
export class DiceKeyFrameWorkerClient {
  private readonly worker: ScannerWorkerLike;
  private readonly sessionId: string;
  private readonly cleanupTimeoutMs: number;
  private readonly workerReadyTimeoutMs?: number;
  private readonly frameResponseTimeoutMs?: number;
  private nextRequestId = 1;
  private disposed = false;
  private workerTerminated = false;
  private workerReady = false;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly workerReadyPromise: Promise<void>;
  private workerReadyTimeout?: ReturnType<typeof setTimeout>;
  private workerFailure?: Error;
  private hasPostedFrameRequest = false;
  private readonly ownedFrameBuffers = new Set<ScannerOwnedFrameBuffer>();
  private readonly pendingFrameRequests = new Map<number, PendingFrameRequest>();
  private terminationRequestId?: number;
  private terminationAcknowledged?: () => void;
  private terminationFailed?: (error: Error) => void;
  private disposePromise?: Promise<void>;
  private readonly createFrameBuffer: (
    source: Uint8ClampedArray,
  ) => ScannerOwnedFrameBuffer;

  get acquisitionId(): string {
    return this.sessionId;
  }

  get readiness(): Promise<void> {
    return this.workerReadyPromise;
  }

  constructor({
    createWorker,
    createSessionId = createScannerSessionId,
    createFrameBuffer = (source) => new ScannerOwnedFrameBuffer(source),
    cleanupTimeoutMs = 5000,
    workerReadyTimeoutMs,
    frameResponseTimeoutMs,
  }: DiceKeyFrameWorkerClientOptions) {
    this.sessionId = createSessionId();
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    this.workerReadyTimeoutMs = validateOptionalTimeout(
      workerReadyTimeoutMs,
      "workerReadyTimeoutMs",
    );
    this.frameResponseTimeoutMs = validateOptionalTimeout(
      frameResponseTimeoutMs,
      "frameResponseTimeoutMs",
    );
    this.createFrameBuffer = createFrameBuffer;
    this.workerReadyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // A worker may fail before any frame awaits readiness. Keep the promise
    // observed while still allowing each caller's await to receive the error.
    void this.workerReadyPromise.catch(() => {});
    this.worker = createWorker();
    try {
      this.worker.addEventListener("message", this.handleWorkerMessage);
      this.worker.addEventListener("error", this.handleWorkerFailure);
      this.worker.addEventListener("messageerror", this.handleWorkerFailure);
      if (this.workerReadyTimeoutMs != null) {
        this.workerReadyTimeout = setTimeout(() => {
          if (this.workerReady || this.disposed || this.workerFailure != null) {
            return;
          }
          this.failWorker(new Error(
            "DiceKey scanner worker readiness timed out",
          ));
        }, this.workerReadyTimeoutMs);
      }
    } catch (error) {
      this.clearWorkerReadyTimeout();
      this.removeWorkerListeners();
      this.workerTerminated = true;
      try { this.worker.terminate(); } catch {}
      throw error;
    }
  }

  private clearWorkerReadyTimeout = (): void => {
    if (this.workerReadyTimeout != null) {
      clearTimeout(this.workerReadyTimeout);
    }
    this.workerReadyTimeout = undefined;
  };

  private takePendingFrameRequest = (
    requestId: number,
  ): PendingFrameRequest | undefined => {
    const pendingRequest = this.pendingFrameRequests.get(requestId);
    if (pendingRequest == null) return undefined;
    this.pendingFrameRequests.delete(requestId);
    if (pendingRequest.timeout != null) clearTimeout(pendingRequest.timeout);
    return pendingRequest;
  };

  private rejectPendingFrameRequests = (error: Error): void => {
    [...this.pendingFrameRequests.keys()].forEach((requestId) => {
      this.takePendingFrameRequest(requestId)?.reject(error);
    });
  };

  private handleWorkerMessage: EventListener = (event): void => {
    const { data } = event as MessageEvent<unknown>;
    if (isWorkerInitializationFailure(data)) {
      this.failWorker(new Error(data.message));
      return;
    }
    if (this.disposed) {
      if (
        this.terminationRequestId != null &&
        isMatchingTerminationResponse(
          data,
          this.sessionId,
          this.terminationRequestId,
        )
      ) {
        this.terminationAcknowledged?.();
      }
      wipeScannerFaceImageResponse(data);
      return;
    }

    if (isReadyMessage(data)) {
      if (!this.workerReady) {
        this.workerReady = true;
        this.clearWorkerReadyTimeout();
        this.readyResolve();
        this.readyResolve = () => {};
        this.readyReject = () => {};
      }
      return;
    }

    if (!isMatchingFrameResponse(data, this.sessionId)) {
      wipeScannerFaceImageResponse(data);
      return;
    }
    const pendingRequest = this.takePendingFrameRequest(data.requestId);
    if (pendingRequest == null) {
      wipeScannerFaceImageResponse(data);
      return;
    }
    pendingRequest.resolve(data);
  };

  private failWorker = (error: Error): void => {
    if (this.workerTerminated) return;
    this.clearWorkerReadyTimeout();
    if (this.workerFailure == null) {
      this.workerFailure = error;
      this.readyReject(error);
      this.readyResolve = () => {};
      this.readyReject = () => {};
      this.rejectPendingFrameRequests(error);
    }
    if (this.hasPostedFrameRequest) {
      if (this.terminationFailed != null || this.disposePromise != null) {
        // Cleanup failed after a dirty-session termination request. Reclaim
        // the isolated realm through the bounded failure path and reject;
        // native deletion and worker-side zeroization remain unconfirmed.
        this.terminationFailed?.(error);
      } else {
        // A dirty worker may still own native state or sensitive image copies.
        // Request cooperative cleanup first; an exact acknowledgement confirms
        // it, while the bounded fallback rejects before reclaiming the realm.
        void this.dispose().catch(() => {});
      }
    } else {
      this.disposed = true;
      this.terminateWorkerExactlyOnce();
    }
  };

  private handleWorkerFailure: EventListener = (event): void => {
    if (this.workerTerminated) return;
    const errorEvent = event as ErrorEvent;
    const error = errorEvent.error instanceof Error ? errorEvent.error :
      new Error(errorEvent.message || "DiceKey scanner worker failed");
    this.failWorker(error);
  };

  processDiceKeyImageFrame = async (
    imageData: ImageData,
  ): Promise<ProcessFrameResponse> => {
    const { width, height, data } = imageData;
    let ownedFrameBuffer: ScannerOwnedFrameBuffer | undefined;
    try {
      ownedFrameBuffer = this.createFrameBuffer(data);
      this.ownedFrameBuffers.add(ownedFrameBuffer);
      if (this.disposed) {
        throw new Error("DiceKey scanner session has been disposed");
      }
      if (this.workerFailure != null) throw this.workerFailure;
      await this.workerReadyPromise;
      if (this.disposed) {
        throw new Error("DiceKey scanner session has been disposed");
      }
      if (this.workerFailure != null) throw this.workerFailure;

      const requestId = this.nextRequestId++;
      const rgbImageAsArrayBuffer = ownedFrameBuffer.arrayBuffer;
      const request: ProcessFrameRequest = {
        action: "processRGBAImageFrame",
        sessionId: this.sessionId,
        requestId,
        width,
        height,
        rgbImageAsArrayBuffer,
      };
      const responsePromise = new Promise<ProcessFrameResponse>((resolve, reject) => {
        const timeout = this.frameResponseTimeoutMs == null
          ? undefined
          : setTimeout(() => {
              if (!this.pendingFrameRequests.has(requestId)) return;
              this.failWorker(new Error(
                "DiceKey scanner frame response timed out",
              ));
            }, this.frameResponseTimeoutMs);
        this.pendingFrameRequests.set(requestId, { resolve, reject, timeout });
      });
      try {
        // Transfer only the dedicated owned copy. The source ImageData was
        // already wiped, and a successful post detaches all main-thread access
        // to the worker-owned bytes. If postMessage throws, the still-attached
        // copy is wiped by the finally block below.
        this.worker.postMessage(request, [rgbImageAsArrayBuffer]);
        this.hasPostedFrameRequest = true;
        ownedFrameBuffer.dispose();
        this.ownedFrameBuffers.delete(ownedFrameBuffer);
        ownedFrameBuffer = undefined;
      } catch (error) {
        this.takePendingFrameRequest(requestId);
        throw error;
      }
      return await responsePromise;
    } finally {
      try { data.fill(0); } catch {}
      ownedFrameBuffer?.dispose();
      if (ownedFrameBuffer != null) {
        this.ownedFrameBuffers.delete(ownedFrameBuffer);
      }
    }
  };

  private removeWorkerListeners = (): void => {
    try { this.worker.removeEventListener("message", this.handleWorkerMessage); } catch {}
    try { this.worker.removeEventListener("error", this.handleWorkerFailure); } catch {}
    try { this.worker.removeEventListener("messageerror", this.handleWorkerFailure); } catch {}
  };

  private terminateWorkerExactlyOnce = (): void => {
    if (this.workerTerminated) return;
    this.workerTerminated = true;
    this.clearWorkerReadyTimeout();
    this.removeWorkerListeners();
    this.worker.terminate();
  };

  /**
   * Ask the worker to delete its native processor, then terminate the worker.
   * Dirty workers require a cleanup acknowledgement before termination.
   */
  dispose = (): Promise<void> => {
    if (this.disposePromise != null) return this.disposePromise;
    this.disposed = true;
    this.clearWorkerReadyTimeout();
    const disposedError = new Error("DiceKey scanner session has been disposed");
    this.readyResolve();
    this.readyResolve = () => {};
    this.readyReject = () => {};
    this.rejectPendingFrameRequests(disposedError);
    this.ownedFrameBuffers.forEach((ownedFrameBuffer) => {
      ownedFrameBuffer.dispose();
    });
    this.ownedFrameBuffers.clear();

    if (this.workerTerminated) {
      this.disposePromise = Promise.resolve();
      return this.disposePromise;
    }

    // No successfully posted frame means no worker-side RGBA clone or native
    // processor can exist. Direct termination is therefore cleanup-safe.
    if (!this.hasPostedFrameRequest) {
      this.terminateWorkerExactlyOnce();
      this.disposePromise = Promise.resolve();
      return this.disposePromise;
    }

    const requestId = this.nextRequestId++;
    this.terminationRequestId = requestId;
    const terminationRequest: TerminateSessionRequest = {
      action: "terminateSession",
      sessionId: this.sessionId,
      requestId,
    };

    this.disposePromise = new Promise<void>((resolve, reject) => {
      let cleanupTimeout: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const clearTerminationState = (): void => {
        if (cleanupTimeout != null) clearTimeout(cleanupTimeout);
        cleanupTimeout = undefined;
        this.terminationAcknowledged = undefined;
        this.terminationFailed = undefined;
        this.terminationRequestId = undefined;
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTerminationState();
        try {
          this.terminateWorkerExactlyOnce();
          resolve();
        } catch (error) {
          reject(new ScannerWorkerCleanupUnconfirmedError(error));
        }
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTerminationState();
        // Standard Worker APIs cannot force a hung worker to execute its JS
        // finally blocks or native delete(). Main-thread image data is already
        // wiped/detached; terminate the isolated realm as the bounded fallback
        // and reject so cooperative cleanup is never falsely reported.
        try { this.terminateWorkerExactlyOnce(); } catch {}
        reject(new ScannerWorkerCleanupUnconfirmedError(error));
      };
      this.terminationAcknowledged = finish;
      this.terminationFailed = fail;
      cleanupTimeout = setTimeout(() => {
        fail(new Error("DiceKey scanner worker cleanup acknowledgement timed out"));
      }, this.cleanupTimeoutMs);
      try {
        this.worker.postMessage(terminationRequest);
      } catch (error) {
        // Cleanup could not be requested. Reclaim the isolated worker realm
        // within the bounded fallback, and reject rather than claiming native
        // deletion or worker-side zeroization was confirmed.
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return this.disposePromise;
  };
}
