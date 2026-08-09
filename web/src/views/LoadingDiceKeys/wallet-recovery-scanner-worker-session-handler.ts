import {
  type NativeDeletable,
  ScannerNativeProcessorStore,
} from "./wallet-recovery-scanner-worker-resource";

export interface ScannerWorkerProcessRequest {
  readonly action: "processRGBAImageFrame";
  readonly sessionId: string;
  readonly requestId: number;
}

export interface ScannerWorkerSessionPort {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
}

export interface ScannerWorkerSessionHandlerOptions<
  Processor extends NativeDeletable,
  Request extends ScannerWorkerProcessRequest,
  Response,
> {
  readonly port: ScannerWorkerSessionPort;
  readonly createProcessor: () => Processor;
  readonly isProcessRequest: (candidate: unknown) => candidate is Request;
  readonly processFrame: (request: Request, processor: Processor) => Response;
  readonly cleanupProcessRequest?: (request: Request) => void;
  readonly cleanupProcessResponse?: (response: Response) => void;
}

const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === "object" && candidate != null;

const isTerminateSessionRequest = (candidate: unknown): candidate is {
  readonly action: "terminateSession";
  readonly sessionId: string;
  readonly requestId: number;
} =>
  isRecord(candidate) &&
  candidate.action === "terminateSession" &&
  typeof candidate.sessionId === "string" &&
  typeof candidate.requestId === "number" &&
  Number.isSafeInteger(candidate.requestId) &&
  candidate.requestId >= 1;

const wipeScannerRgbaValue = (candidate: unknown): void => {
  try {
    if (ArrayBuffer.isView(candidate)) {
      // The structured-cloned backing store belongs to this worker message;
      // wipe it in full, not just the exposed subview.
      new Uint8Array(candidate.buffer).fill(0);
      return;
    }
    new Uint8Array(candidate as ArrayBufferLike).fill(0);
  } catch {}
};

export const wipeScannerRgbaRequest = (request: {
  readonly rgbImageAsArrayBuffer: ArrayBufferLike | ArrayBufferView;
}): void => {
  wipeScannerRgbaValue(request.rgbImageAsArrayBuffer);
};

const wipeDiscardedProcessMessage = (candidate: unknown): void => {
  if (
    !isRecord(candidate) ||
    candidate.action !== "processRGBAImageFrame" ||
    !("rgbImageAsArrayBuffer" in candidate)
  ) return;
  wipeScannerRgbaValue(candidate.rgbImageAsArrayBuffer);
};

export const wipeScannerFaceImageResponse = (response: unknown): void => {
  if (!isRecord(response)) return;
  const { facesReadObjectArray } = response;
  if (!Array.isArray(facesReadObjectArray)) return;
  facesReadObjectArray.forEach((candidate) => {
    if (!isRecord(candidate)) return;
    const image = candidate.squareImageAsRgbaArray;
    if (image instanceof Uint8ClampedArray) {
      try { image.fill(0); } catch {}
    }
    try { candidate.squareImageAsRgbaArray = undefined; } catch {}
  });
};

/**
 * Production worker message/session lifecycle, separated from WASM loading so
 * its correlation and native-resource behavior can be regression tested.
 */
export class ScannerWorkerSessionHandler<
  Processor extends NativeDeletable,
  Request extends ScannerWorkerProcessRequest,
  Response,
> {
  private readonly processors: ScannerNativeProcessorStore<Processor>;
  private listenerAttached = true;
  private closed = false;
  private activeSessionId?: string;
  private lastRequestId = 0;

  constructor(
    private readonly options: ScannerWorkerSessionHandlerOptions<
      Processor,
      Request,
      Response
    >,
  ) {
    this.processors = new ScannerNativeProcessorStore(options.createProcessor);
    options.port.addEventListener("message", this.handleMessage);
    options.port.postMessage({ action: "workerReady" });
  }

  private detachListener = (): void => {
    if (!this.listenerAttached) return;
    this.listenerAttached = false;
    this.options.port.removeEventListener("message", this.handleMessage);
  };

  private closeExactlyOnce = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.options.port.close();
  };

  private handleMessage = (event: MessageEvent<unknown>): void => {
    const { data } = event;
    if (isTerminateSessionRequest(data)) {
      if (
        (this.activeSessionId != null && data.sessionId !== this.activeSessionId) ||
        data.requestId <= this.lastRequestId
      ) {
        return;
      }
      this.activeSessionId ??= data.sessionId;
      this.lastRequestId = data.requestId;
      this.detachListener();
      try {
        try {
          this.processors.deleteSession(data.sessionId);
        } finally {
          // A worker belongs to one scanner attempt. Delete any unexpected
          // session processor before acknowledging termination.
          this.processors.dispose();
        }
        this.options.port.postMessage({
          action: "sessionTerminated",
          sessionId: data.sessionId,
          requestId: data.requestId,
        });
      } finally {
        this.closeExactlyOnce();
      }
      return;
    }

    if (!this.options.isProcessRequest(data)) {
      wipeDiscardedProcessMessage(data);
      return;
    }
    if (
      !Number.isSafeInteger(data.requestId) ||
      data.requestId < 1 ||
      (this.activeSessionId != null && data.sessionId !== this.activeSessionId) ||
      data.requestId <= this.lastRequestId
    ) {
      this.options.cleanupProcessRequest?.(data);
      return;
    }
    this.activeSessionId ??= data.sessionId;
    this.lastRequestId = data.requestId;
    let response: Response | undefined;
    try {
      const processor = this.processors.getOrCreate(data.sessionId);
      response = this.options.processFrame(data, processor);
      this.options.port.postMessage(response, []);
    } finally {
      if (response != null) {
        this.options.cleanupProcessResponse?.(response);
      }
      this.options.cleanupProcessRequest?.(data);
    }
  };

  dispose = (): void => {
    this.detachListener();
    try {
      this.processors.dispose();
    } finally {
      this.closeExactlyOnce();
    }
  };
}
