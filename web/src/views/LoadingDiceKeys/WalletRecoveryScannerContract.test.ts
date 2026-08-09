/** @jest-environment jsdom */

jest.mock("../../images/Scanning Overlay.svg", () => "scanning-overlay.svg");
jest.mock("../../workers/dicekey-image-frame-worker?worker", () => ({
  __esModule: true,
  default: jest.fn(),
}), { virtual: true });
jest.mock("./renderFacesRead", () => ({ renderFacesRead: jest.fn() }));
jest.mock("../../state/stores/DiceKeyMemoryStore", () => ({
  DiceKeyMemoryStore: {
    addCenterFaceOrientationWhenScanned: jest.fn(),
  },
}));
jest.mock("react-dom/server", () => {
  const util = jest.requireActual("util") as typeof import("util");
  if (!("TextEncoder" in globalThis)) {
    Object.defineProperty(globalThis, "TextEncoder", {
      configurable: true,
      value: util.TextEncoder,
    });
  }
  if (!("TextDecoder" in globalThis)) {
    Object.defineProperty(globalThis, "TextDecoder", {
      configurable: true,
      value: util.TextDecoder,
    });
  }
  return jest.requireActual("react-dom/server");
});

import React from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { act } from "react-dom/test-utils";
import { FaceRead } from "@dicekeys/read-dicekey-js";
import { DiceKeyWithoutKeyId } from "../../dicekeys/DiceKey";
import { DiceKeyMemoryStore } from "../../state/stores/DiceKeyMemoryStore";
import { WalletRecoveryFlow } from "../WalletRecovery/foundation";
import type {
  ProcessFrameRequest,
  ProcessFrameResponse,
  TerminateSessionRequest,
} from "../../workers/dicekey-image-frame-worker";
import {
  CameraCaptureWithOverlayComponent,
} from "./CameraCaptureWithOverlay";
import {
  type DiceKeyScannerMode,
  DiceKeyFrameProcessorState,
  scannerAttemptKeyForMode,
} from "./DiceKeyFrameProcessorState";
import { FrameGrabberFromVideoElement } from "./FrameGrabberFromVideoElement";
import { FrameGrabberUsingImageCapture } from "./FrameGrabberUsingImageCapture";
import { MediaStreamState } from "./MediaStreamState";
import { CameraSelectionView } from "./CameraSelectionView";
import { CamerasOnThisDevice, type Camera } from "./CamerasOnThisDevice";
import {
  deliverWalletRecoveryScannerResult,
  mountScannerAttemptWithCleanup,
  processCapturedFrameForScannerAttempt,
  ScanDiceKeyView,
} from "./ScanDiceKeyView";
import {
  evaluateWalletRecoveryScannerRead,
  type WalletRecoveryScanResult,
} from "./wallet-recovery-scanner-policy";
import { ScannerAttemptLifecycle } from "./wallet-recovery-scanner-attempt-lifecycle";
import { ScannerOwnedFrameBuffer } from "./wallet-recovery-scanner-frame-buffer";
import {
  WALLET_RECOVERY_SCANNER_ATTEMPT_FAILED,
  createWalletRecoveryScannerAcquisitionHandle,
  scannerCandidateToSanitizedAcquisition,
  type WalletRecoveryScannerAcquisitionHandle,
  type WalletRecoveryScannerResult,
  type WalletRecoveryScannerTerminal,
} from "./wallet-recovery-scanner-acquisition";
import {
  DiceKeyFrameWorkerClient,
  ScannerWorkerCleanupUnconfirmedError,
  ScannerWorkerLike,
} from "./wallet-recovery-scanner-worker-client";
import { ScannerNativeProcessorStore } from "./wallet-recovery-scanner-worker-resource";
import {
  ScannerWorkerSessionHandler,
  type ScannerWorkerSessionPort,
  wipeScannerFaceImageResponse,
  wipeScannerRgbaRequest,
} from "./wallet-recovery-scanner-worker-session-handler";

type ScannerFace = {
  letter?: string;
  digit?: string;
  orientationAsLowercaseLetterTrbl: string;
  errors: Array<{ type: string }>;
  squareImageAsRgbaArray?: Uint8ClampedArray;
  scannerMetadata?: string;
};

const scannerFaces = (): ScannerFace[] =>
  DiceKeyWithoutKeyId.testExample.faces.map((face) => ({
    ...face,
    errors: [],
    squareImageAsRgbaArray: new Uint8ClampedArray([7, 8, 9]),
    scannerMetadata: "must-not-escape",
  }));

const processFacesRead = (
  state: DiceKeyFrameProcessorState,
  faces: ScannerFace[],
): boolean =>
  (state as unknown as {
    processFacesRead: (candidate: FaceRead[]) => boolean;
  }).processFacesRead(faces as unknown as FaceRead[]);

const frameResponse = (
  request: ProcessFrameRequest,
  overrides: Partial<ProcessFrameResponse> = {},
): ProcessFrameResponse => ({
  action: "processRGBAImageFrame",
  sessionId: request.sessionId,
  requestId: request.requestId,
  width: request.width,
  height: request.height,
  isFinished: false,
  facesReadObjectArray: undefined,
  ...overrides,
});

const frameResponseWithFaceImage = (
  request: ProcessFrameRequest,
  image: Uint8ClampedArray,
): {
  response: ProcessFrameResponse;
  faceObject: { squareImageAsRgbaArray?: Uint8ClampedArray };
} => {
  const faceObject = { squareImageAsRgbaArray: image };
  return {
    response: frameResponse(request, {
      facesReadObjectArray: [faceObject] as unknown as
        ProcessFrameResponse["facesReadObjectArray"],
    }),
    faceObject,
  };
};

const { MessageChannel: NodeMessageChannel } = jest.requireActual(
  "worker_threads",
) as typeof import("worker_threads");

const clonePostedMessage = <T>(
  value: T,
  transfer: readonly Transferable[] = [],
): T => {
  if (value instanceof ArrayBuffer) {
    const clone = value.slice(0);
    if (transfer.includes(value)) {
      const { port1, port2 } = new NodeMessageChannel();
      port1.postMessage(value, [value]);
      port1.close();
      port2.close();
    }
    return clone as T;
  }
  if (value instanceof Uint8ClampedArray) {
    return new Uint8ClampedArray(value) as T;
  }
  if (value instanceof Uint8Array) {
    return new Uint8Array(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => clonePostedMessage(item, transfer)) as T;
  }
  if (typeof value === "object" && value != null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        clonePostedMessage(item, transfer),
      ]),
    ) as T;
  }
  return value;
};

class FakeWorker implements ScannerWorkerLike {
  readonly listeners: Record<
    "message" | "error" | "messageerror",
    Set<EventListener>
  > = {
    message: new Set<EventListener>(),
    error: new Set<EventListener>(),
    messageerror: new Set<EventListener>(),
  };
  readonly posted: unknown[] = [];
  readonly transfers: Array<Transferable[] | undefined> = [];
  readonly terminate = jest.fn();
  readonly removeEventListener = jest.fn((
    type: "message" | "error" | "messageerror",
    listener: EventListener,
  ) => {
    this.listeners[type].delete(listener);
  });

  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: EventListener,
  ): void {
    this.listeners[type].add(listener);
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.transfers.push(transfer);
    this.posted.push(clonePostedMessage(message, transfer));
  }

  emit(data: unknown): void {
    this.listeners.message.forEach((listener) =>
      listener({ data } as MessageEvent<unknown>));
  }

  emitFailure(
    type: "error" | "messageerror",
    error: Error,
  ): void {
    this.listeners[type].forEach((listener) => listener({
      error,
      message: error.message,
    } as ErrorEvent));
  }
}

class FakeWorkerSessionPort implements ScannerWorkerSessionPort {
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly posted: unknown[] = [];
  readonly close = jest.fn();
  readonly removeEventListener = jest.fn((
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ) => {
    this.listeners.delete(listener);
  });

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listeners.add(listener);
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push(clonePostedMessage(message, transfer));
  }

  emit(data: unknown): void {
    this.listeners.forEach((listener) => listener({ data } as MessageEvent<unknown>));
  }
}

const isProcessFrameRequestForTest = (
  candidate: unknown,
): candidate is ProcessFrameRequest =>
  typeof candidate === "object" &&
  candidate != null &&
  "action" in candidate &&
  candidate.action === "processRGBAImageFrame" &&
  "sessionId" in candidate &&
  typeof candidate.sessionId === "string" &&
  "requestId" in candidate &&
  typeof candidate.requestId === "number" &&
  "width" in candidate &&
  "height" in candidate &&
  "rgbImageAsArrayBuffer" in candidate;

const testImageData = (): ImageData => ({
  width: 1,
  height: 1,
  data: new Uint8ClampedArray([1, 2, 3, 4]),
  colorSpace: "srgb",
} as ImageData);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const fakeCamera = (
  deviceId: string,
  capabilities?: MediaTrackCapabilities,
): Camera => ({
  deviceId,
  groupId: "camera-group",
  kind: "videoinput",
  label: deviceId,
  name: deviceId,
  capabilities,
  toJSON: () => ({}),
} as Camera);

const fakeCamerasOnThisDevice = (cameras: Camera[]): CamerasOnThisDevice => ({
  cameras,
  camerasByDeviceId: new Map(cameras.map((camera) => [camera.deviceId, camera])),
} as unknown as CamerasOnThisDevice);

const fakeMediaStream = () => {
  const videoTrack = { stop: jest.fn() } as unknown as MediaStreamTrack;
  const audioTrack = { stop: jest.fn() } as unknown as MediaStreamTrack;
  const stop = jest.fn();
  const mediaStream = {
    getTracks: () => [videoTrack, audioTrack],
    getVideoTracks: () => [videoTrack],
    stop,
  } as unknown as MediaStream;
  return { mediaStream, videoTrack, audioTrack, stop };
};

describe("wallet recovery scanner policy", () => {
  test("returns a frozen exact candidate containing only sanitized face fields", () => {
    const source = scannerFaces();
    const result = evaluateWalletRecoveryScannerRead(source);

    expect(result.status).toBe("exact");
    if (result.status === "rescan") throw new Error("expected a candidate");
    expect(result.flaggedFaceIndexes).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.faces)).toBe(true);
    result.faces.forEach((face, index) => {
      expect(face).not.toBe(source[index]);
      expect(Object.keys(face).sort()).toEqual([
        "digit",
        "letter",
        "orientationAsLowercaseLetterTrbl",
      ]);
      expect(Object.isFrozen(face)).toBe(true);
    });
  });

  test("bit-read errors always require explicit confirmation with exact indexes", () => {
    const source = scannerFaces();
    source[3]!.errors = [{ type: "undoverline-missing" }];
    source[19]!.errors = [{ type: "undoverline-bit-mismatch" }];

    for (let frame = 0; frame < 10; frame += 1) {
      const result = evaluateWalletRecoveryScannerRead(source);
      expect(result.status).toBe("requires-confirmation");
      expect(result.flaggedFaceIndexes).toEqual([3, 19]);
    }
  });

  test.each([
    ["incomplete", scannerFaces().slice(0, 24), "incomplete"],
    ["no majority", (() => {
      const faces = scannerFaces();
      faces[4]!.letter = undefined;
      faces[4]!.errors = [{ type: "no-majority-agreement" }];
      return faces;
    })(), "no-majority"],
    ["OCR ambiguity", (() => {
      const faces = scannerFaces();
      faces[8]!.errors = [{ type: "ocr-second-choice" }];
      return faces;
    })(), "ocr-ambiguous"],
    ["strict wallet invalidity", (() => {
      const faces = scannerFaces();
      faces[1]!.letter = faces[0]!.letter;
      return faces;
    })(), "strict-wallet-invalid"],
  ])("requires rescan for %s and returns no candidate faces", (_label, faces, reason) => {
    const result = evaluateWalletRecoveryScannerRead(faces);
    expect(result).toMatchObject({ status: "rescan", reason });
    expect("faces" in result).toBe(false);
  });

  test("wallet mode never invokes legacy acceptance or the global DiceKey store", () => {
    const storeCall = DiceKeyMemoryStore.addCenterFaceOrientationWhenScanned as jest.Mock;
    storeCall.mockClear();
    const onDiceKeyRead = jest.fn();
    const onWalletRecoveryScan = jest.fn<void, [WalletRecoveryScanResult]>();
    const state = new DiceKeyFrameProcessorState({
      scanMode: "wallet-recovery",
      onDiceKeyRead,
      onWalletRecoveryScan,
    });
    const faces = scannerFaces();
    faces[12]!.errors = [{ type: "undoverline-missing" }];

    expect(processFacesRead(state, faces)).toBe(true);
    expect(onWalletRecoveryScan).toHaveBeenCalledWith(expect.objectContaining({
      status: "requires-confirmation",
      flaggedFaceIndexes: [12],
    }));
    expect(onDiceKeyRead).not.toHaveBeenCalled();
    expect(storeCall).not.toHaveBeenCalled();
  });

  test("clears a terminal wallet callback before throw or reentrant processing", () => {
    const faces = scannerFaces();
    const onWalletRecoveryScan = jest.fn(() => {
      expect(processFacesRead(state, faces)).toBe(true);
      throw new Error("consumer failed");
    });
    const state = new DiceKeyFrameProcessorState({
      scanMode: "wallet-recovery",
      onWalletRecoveryScan,
    });

    expect(() => processFacesRead(state, faces)).toThrow("consumer failed");
    expect(onWalletRecoveryScan).toHaveBeenCalledTimes(1);
    expect(state.onWalletRecoveryScan).toBeUndefined();
  });

  test("legacy mode retains exact-read callback and orientation-store behavior", () => {
    const storeCall = DiceKeyMemoryStore.addCenterFaceOrientationWhenScanned as jest.Mock;
    storeCall.mockClear();
    const onDiceKeyRead = jest.fn();
    const state = new DiceKeyFrameProcessorState({ onDiceKeyRead });

    expect(processFacesRead(state, scannerFaces())).toBe(true);
    expect(onDiceKeyRead).toHaveBeenCalledTimes(1);
    expect(storeCall).toHaveBeenCalledTimes(1);
  });

  test("wipes a displaced legacy best frame when a later error frame replaces it", () => {
    const state = new DiceKeyFrameProcessorState({});
    const firstFrame = scannerFaces();
    const secondFrame = scannerFaces();
    const firstImage = new Uint8ClampedArray([8, 7, 6]);
    const secondImage = new Uint8ClampedArray([5, 4, 3]);
    firstFrame[0]!.errors = [{ type: "undoverline-missing" }];
    firstFrame[0]!.squareImageAsRgbaArray = firstImage;
    secondFrame[0]!.errors = [{ type: "undoverline-missing" }];
    secondFrame[0]!.squareImageAsRgbaArray = secondImage;

    expect(processFacesRead(state, firstFrame)).toBe(false);
    expect([...firstImage]).toEqual([8, 7, 6]);
    expect(processFacesRead(state, secondFrame)).toBe(false);
    expect([...firstImage]).toEqual([0, 0, 0]);
    expect(state.bestFacesRead).toHaveLength(25);
    expect([...secondImage]).toEqual([5, 4, 3]);

    state.dispose();
    expect([...secondImage]).toEqual([0, 0, 0]);
  });

  test("processor disposal clears callbacks, FaceRead references, and image bytes once", () => {
    const image = new Uint8ClampedArray([11, 12, 13]);
    const face = {
      ...scannerFaces()[0],
      squareImageAsRgbaArray: image,
    } as unknown as FaceRead;
    const state = new DiceKeyFrameProcessorState({
      onDiceKeyRead: jest.fn(),
      onWalletRecoveryScan: jest.fn(),
      scanMode: "wallet-recovery",
    });
    state.facesRead = [face];
    state.bestFacesRead = state.facesRead;

    state.dispose();
    state.dispose();

    expect([...image]).toEqual([0, 0, 0]);
    expect(state.facesRead).toBeUndefined();
    expect(state.bestFacesRead).toBeUndefined();
    expect(state.onDiceKeyRead).toBeUndefined();
    expect(state.onWalletRecoveryScan).toBeUndefined();
  });

  test("wipes response face images on disposed and conversion-failure paths", () => {
    const overlay = {
      canvas: { width: 1, height: 1 },
      clearRect: jest.fn(),
    } as unknown as CanvasRenderingContext2D;
    const makeMalformedResponse = () => {
      const images = Array.from(
        { length: 25 },
        (_, index) => new Uint8ClampedArray([index + 1]),
      );
      const facesReadObjectArray = images.map((squareImageAsRgbaArray) => ({
        squareImageAsRgbaArray,
        ocrLetterCharsFromMostToLeastLikely: undefined,
      }));
      return {
        images,
        response: {
          action: "processRGBAImageFrame",
          sessionId: "face-image-cleanup",
          requestId: 1,
          width: 1,
          height: 1,
          isFinished: false,
          facesReadObjectArray,
        } as unknown as ProcessFrameResponse,
        faceObjects: facesReadObjectArray,
      };
    };

    const disposedCase = makeMalformedResponse();
    const disposedState = new DiceKeyFrameProcessorState({});
    disposedState.dispose();
    disposedState.handleProcessedCameraFrame(disposedCase.response, overlay);
    disposedCase.images.forEach((image) => expect([...image]).toEqual([0]));
    disposedCase.faceObjects.forEach((face) =>
      expect(face.squareImageAsRgbaArray).toBeUndefined());

    const conversionCase = makeMalformedResponse();
    const onWalletRecoveryScan = jest.fn();
    const walletState = new DiceKeyFrameProcessorState({
      scanMode: "wallet-recovery",
      onWalletRecoveryScan,
    });
    walletState.handleProcessedCameraFrame(conversionCase.response, overlay);
    expect(onWalletRecoveryScan).toHaveBeenCalledWith(expect.objectContaining({
      status: "rescan",
    }));
    conversionCase.images.forEach((image) => expect([...image]).toEqual([0]));
    conversionCase.faceObjects.forEach((face) =>
      expect(face.squareImageAsRgbaArray).toBeUndefined());

    const shortImages = Array.from(
      { length: 24 },
      (_, index) => new Uint8ClampedArray([index + 1]),
    );
    const shortFaceObjects = shortImages.map((squareImageAsRgbaArray) => ({
      underline: undefined,
      overline: undefined,
      orientationAsLowercaseLetterTrbl: "t",
      ocrLetterCharsFromMostToLeastLikely: "A",
      ocrDigitCharsFromMostToLeastLikely: "1",
      center: { x: 0, y: 0 },
      squareImageAsRgbaArray,
    }));
    walletState.handleProcessedCameraFrame({
      action: "processRGBAImageFrame",
      sessionId: "short-face-image-cleanup",
      requestId: 2,
      width: 1,
      height: 1,
      isFinished: false,
      facesReadObjectArray: shortFaceObjects,
    } as unknown as ProcessFrameResponse, overlay);
    shortImages.forEach((image) => expect([...image]).toEqual([0]));
    shortFaceObjects.forEach((face) =>
      expect(face.squareImageAsRgbaArray).toBeUndefined());
  });

  test("delivers exactly 25 converted faces as one wallet candidate", () => {
    const sourceFaces = scannerFaces();
    const images = sourceFaces.map(
      (_, index) => new Uint8ClampedArray([index + 1]),
    );
    const faceObjects = sourceFaces.map((testFace, index) => ({
      testFace,
      squareImageAsRgbaArray: images[index],
    }));
    const fromJsonObject = jest.spyOn(FaceRead, "fromJsonObject").mockImplementation(
      (candidate) => ({
        ...(candidate as unknown as { testFace: ScannerFace }).testFace,
      } as unknown as FaceRead),
    );
    const onWalletRecoveryScan = jest.fn();
    const state = new DiceKeyFrameProcessorState({
      scanMode: "wallet-recovery",
      onWalletRecoveryScan,
    });
    const overlay = {
      canvas: { width: 1, height: 1 },
      clearRect: jest.fn(),
    } as unknown as CanvasRenderingContext2D;

    try {
      state.handleProcessedCameraFrame({
        action: "processRGBAImageFrame",
        sessionId: "exact-25",
        requestId: 1,
        width: 1,
        height: 1,
        isFinished: true,
        facesReadObjectArray: faceObjects,
      } as unknown as ProcessFrameResponse, overlay);
      expect(state.facesRead).toHaveLength(25);
      expect(onWalletRecoveryScan).toHaveBeenCalledWith(expect.objectContaining({
        status: "exact",
        faces: expect.any(Array),
      }));
      expect(onWalletRecoveryScan.mock.calls[0]![0].faces).toHaveLength(25);
      faceObjects.forEach((face) =>
        expect(face.squareImageAsRgbaArray).toBeUndefined());
    } finally {
      state.dispose();
      fromJsonObject.mockRestore();
    }
    images.forEach((image) => expect([...image]).toEqual([0]));
  });
});

describe("render-safe scanner-attempt ownership", () => {
  test("server/abandoned render allocates nothing and commit/StrictMode cycles allocate once", async () => {
    const clients: Array<{
      acquisitionId: string;
      processDiceKeyImageFrame: jest.Mock;
      dispose: jest.Mock;
    }> = [];
    const createClient = jest.fn(() => {
      const client = {
        acquisitionId: `lifecycle-attempt-${clients.length + 1}`,
        processDiceKeyImageFrame: jest.fn(),
        dispose: jest.fn(() => Promise.resolve()),
      };
      clients.push(client);
      return client;
    });

    expect(() => {
      new ScannerAttemptLifecycle(createClient);
      throw new Error("render abandoned");
    }).toThrow("render abandoned");
    expect(createClient).not.toHaveBeenCalled();

    const lifecycle = new ScannerAttemptLifecycle(createClient);
    const uncommittedFrame = testImageData();
    await expect(
      lifecycle.processDiceKeyImageFrame(uncommittedFrame),
    ).rejects.toThrow("not mounted");
    expect([...uncommittedFrame.data]).toEqual([0, 0, 0, 0]);
    expect(createClient).not.toHaveBeenCalled();

    lifecycle.mount();
    lifecycle.mount();
    expect(createClient).toHaveBeenCalledTimes(1);
    await lifecycle.unmount();
    await lifecycle.unmount();
    expect(clients[0]!.dispose).toHaveBeenCalledTimes(1);

    // React StrictMode replays effect setup after cleanup on the same state.
    lifecycle.mount();
    expect(createClient).toHaveBeenCalledTimes(2);
    await lifecycle.unmount();
    expect(clients[1]!.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("scanner attempt completion ownership", () => {
  test("synchronous mount failure observes rejected lifecycle cleanup", async () => {
    const mountFailure = new Error("worker construction failed");
    const scannerAttempt = {
      mount: jest.fn(() => { throw mountFailure; }),
      unmount: jest.fn(() => Promise.reject(new Error("cleanup also failed"))),
    } as unknown as ScannerAttemptLifecycle;
    const frameProcessorState = {
      dispose: jest.fn(),
    } as unknown as DiceKeyFrameProcessorState;
    const mediaStreamState = {
      dispose: jest.fn(),
    } as unknown as MediaStreamState;

    expect(() => mountScannerAttemptWithCleanup(
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
    )).toThrow(mountFailure);
    expect(frameProcessorState.dispose).toHaveBeenCalledTimes(1);
    expect(mediaStreamState.dispose).toHaveBeenCalledTimes(1);
    expect(scannerAttempt.unmount).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });

  test("terminal wallet processing stops every owner even when its consumer throws", async () => {
    const request: ProcessFrameRequest = {
      action: "processRGBAImageFrame",
      sessionId: "terminal-cleanup-session",
      requestId: 1,
      width: 1,
      height: 1,
      rgbImageAsArrayBuffer: new ArrayBuffer(4),
    };
    const scannerAttempt = {
      acquisitionId: request.sessionId,
      processDiceKeyImageFrame: jest.fn(() => Promise.resolve(frameResponse(request))),
      unmount: jest.fn(() => Promise.reject(new Error("terminal cleanup failed"))),
    } as unknown as ScannerAttemptLifecycle;
    const frameProcessorState = {
      scanningSuccessfulEnoughToTerminate: false,
      handleProcessedCameraFrame: jest.fn(),
      dispose: jest.fn(),
    } as unknown as DiceKeyFrameProcessorState;
    (frameProcessorState.handleProcessedCameraFrame as jest.Mock)
      .mockImplementation(() => {
        frameProcessorState.scanningSuccessfulEnoughToTerminate = true;
        throw new Error("terminal consumer failed");
      });
    const mediaStreamState = {
      dispose: jest.fn(),
    } as unknown as MediaStreamState;
    const disposeCapture = jest.fn();
    const onWalletAttemptCompleted = jest.fn();

    await processCapturedFrameForScannerAttempt({
      framesImageData: testImageData(),
      canvasRenderingContext: {} as CanvasRenderingContext2D,
      scanMode: "wallet-recovery",
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
      onWalletAttemptCompleted,
    });

    expect(onWalletAttemptCompleted).toHaveBeenCalledTimes(1);
    expect(disposeCapture).toHaveBeenCalledTimes(1);
    expect(frameProcessorState.dispose).toHaveBeenCalledTimes(1);
    expect(mediaStreamState.dispose).toHaveBeenCalledTimes(1);
    expect(scannerAttempt.unmount).toHaveBeenCalledTimes(1);
  });

  test("pre-ready bootstrap failure emits one fixed failure after synchronous cleanup", async () => {
    const worker = new FakeWorker();
    const client = new DiceKeyFrameWorkerClient({
      createWorker: () => worker,
      createSessionId: () => "bootstrap-failure-session",
    });
    const scannerAttempt = new ScannerAttemptLifecycle(() => client);
    scannerAttempt.mount();
    const frameProcessorState = {
      scanningSuccessfulEnoughToTerminate: false,
      handleProcessedCameraFrame: jest.fn(),
      dispose: jest.fn(),
    } as unknown as DiceKeyFrameProcessorState;
    const mediaStreamState = {
      dispose: jest.fn(),
    } as unknown as MediaStreamState;
    const disposeCapture = jest.fn();
    const onWalletAttemptCompleted = jest.fn();
    const frame = testImageData();
    const flow = new WalletRecoveryFlow({
      deriveWalletMnemonic: async () => {
        throw new Error("must not derive after scanner failure");
      },
    });
    flow.acceptExplanation({
      computerIsOfflineAndTrusted: true,
      understandsWordsControlWallet: true,
      willRetainProfileWithPhysicalDiceKey: true,
    });
    const expectedEpoch = flow.state.epoch;
    let deliveredResult: WalletRecoveryScannerResult | undefined;
    let failureHandle: WalletRecoveryScannerAcquisitionHandle | undefined;

    const processing = processCapturedFrameForScannerAttempt({
      framesImageData: frame,
      canvasRenderingContext: {} as CanvasRenderingContext2D,
      scanMode: "wallet-recovery",
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
      onWalletAttemptCompleted,
      onAcquisitionHandleCreated: (handle) => {
        failureHandle = handle;
      },
      onWalletRecoveryScan: (result, terminal) => {
        expect(disposeCapture).toHaveBeenCalledTimes(1);
        expect(frameProcessorState.dispose).toHaveBeenCalledTimes(1);
        expect(mediaStreamState.dispose).toHaveBeenCalledTimes(1);
        expect(onWalletAttemptCompleted).toHaveBeenCalledTimes(1);
        deliveredResult = result;
        if (
          result.status !== "failed" ||
          terminal == null ||
          "faces" in terminal
        ) {
          throw new Error("expected scanner-attempt failure handle");
        }
        expect(flow.receiveAcquisitionFailure(expectedEpoch, terminal)).toBe(true);
      },
    });
    worker.emit({
      action: "workerInitializationFailed",
      message: "sensitive bootstrap detail",
    });
    await processing;

    expect(deliveredResult).toEqual(WALLET_RECOVERY_SCANNER_ATTEMPT_FAILED);
    expect(Object.keys(deliveredResult!).sort()).toEqual(["reason", "status"]);
    expect(JSON.stringify(deliveredResult)).not.toContain("sensitive");
    expect(Object.isFrozen(deliveredResult)).toBe(true);
    expect(failureHandle?.acquisitionId).toBe("bootstrap-failure-session");
    expect(Object.keys(failureHandle!).sort()).toEqual([
      "acquisitionId",
      "cleanupSettlement",
      "dispose",
    ]);
    expect([...frame.data]).toEqual([0, 0, 0, 0]);
    expect(frameProcessorState.handleProcessedCameraFrame).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(failureHandle!.cleanupSettlement).resolves.toBeUndefined();
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "ACQUISITION_FAILED",
    }));
  });

  test("resolved WASM exception is terminal in wallet mode and wipes its response", async () => {
    const worker = new FakeWorker();
    const client = new DiceKeyFrameWorkerClient({
      createWorker: () => worker,
      createSessionId: () => "wasm-exception-session",
    });
    const scannerAttempt = new ScannerAttemptLifecycle(() => client);
    scannerAttempt.mount();
    worker.emit({ action: "workerReady" });
    const frameProcessorState = {
      scanningSuccessfulEnoughToTerminate: false,
      handleProcessedCameraFrame: jest.fn(),
      dispose: jest.fn(),
    } as unknown as DiceKeyFrameProcessorState;
    const mediaStreamState = {
      dispose: jest.fn(),
    } as unknown as MediaStreamState;
    const disposeCapture = jest.fn();
    const onWalletAttemptCompleted = jest.fn();
    let deliveredResult: WalletRecoveryScannerResult | undefined;
    let failureHandle: WalletRecoveryScannerAcquisitionHandle | undefined;
    const processing = processCapturedFrameForScannerAttempt({
      framesImageData: testImageData(),
      canvasRenderingContext: {} as CanvasRenderingContext2D,
      scanMode: "wallet-recovery",
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
      onWalletAttemptCompleted,
      onAcquisitionHandleCreated: (handle) => {
        failureHandle = handle;
      },
      onWalletRecoveryScan: (result) => {
        deliveredResult = result;
      },
    });
    await Promise.resolve();
    const processRequest = worker.posted.find(
      (candidate): candidate is ProcessFrameRequest =>
        typeof candidate === "object" &&
        candidate != null &&
        "action" in candidate &&
        candidate.action === "processRGBAImageFrame",
    );
    expect(processRequest).toBeDefined();
    const responseImage = new Uint8ClampedArray([9, 8, 7, 6]);
    const faceObject = { squareImageAsRgbaArray: responseImage };
    worker.emit(frameResponse(processRequest!, {
      exception: new Error("sensitive native processing detail"),
      facesReadObjectArray: [faceObject] as unknown as
        ProcessFrameResponse["facesReadObjectArray"],
    }));
    await processing;

    expect(deliveredResult).toEqual(WALLET_RECOVERY_SCANNER_ATTEMPT_FAILED);
    expect(JSON.stringify(deliveredResult)).not.toContain("sensitive");
    expect(frameProcessorState.handleProcessedCameraFrame).not.toHaveBeenCalled();
    expect(disposeCapture).toHaveBeenCalledTimes(1);
    expect(frameProcessorState.dispose).toHaveBeenCalledTimes(1);
    expect(mediaStreamState.dispose).toHaveBeenCalledTimes(1);
    expect(onWalletAttemptCompleted).toHaveBeenCalledTimes(1);
    expect([...responseImage]).toEqual([0, 0, 0, 0]);
    expect(faceObject.squareImageAsRgbaArray).toBeUndefined();

    const terminationRequest = worker.posted.find(
      (candidate): candidate is TerminateSessionRequest =>
        typeof candidate === "object" &&
        candidate != null &&
        "action" in candidate &&
        candidate.action === "terminateSession",
    );
    expect(terminationRequest).toBeDefined();
    new Uint8Array(processRequest!.rgbImageAsArrayBuffer).fill(0);
    worker.emit({
      action: "sessionTerminated",
      sessionId: terminationRequest!.sessionId,
      requestId: terminationRequest!.requestId,
    });
    await expect(failureHandle!.cleanupSettlement).resolves.toBeUndefined();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  test("active worker rejection surfaces failure and waits for exact cleanup ACK", async () => {
    const worker = new FakeWorker();
    const client = new DiceKeyFrameWorkerClient({
      createWorker: () => worker,
      createSessionId: () => "active-failure-session",
    });
    const scannerAttempt = new ScannerAttemptLifecycle(() => client);
    scannerAttempt.mount();
    worker.emit({ action: "workerReady" });
    const frameProcessorState = {
      scanningSuccessfulEnoughToTerminate: false,
      handleProcessedCameraFrame: jest.fn(),
      dispose: jest.fn(),
    } as unknown as DiceKeyFrameProcessorState;
    const mediaStreamState = {
      dispose: jest.fn(),
    } as unknown as MediaStreamState;
    const disposeCapture = jest.fn();
    const onWalletAttemptCompleted = jest.fn();
    let deliveredResult: WalletRecoveryScannerResult | undefined;
    let failureHandle: WalletRecoveryScannerAcquisitionHandle | undefined;

    const processing = processCapturedFrameForScannerAttempt({
      framesImageData: testImageData(),
      canvasRenderingContext: {} as CanvasRenderingContext2D,
      scanMode: "wallet-recovery",
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
      onWalletAttemptCompleted,
      onAcquisitionHandleCreated: (handle) => {
        failureHandle = handle;
      },
      onWalletRecoveryScan: (result, terminal) => {
        deliveredResult = result;
        if (terminal != null && !("faces" in terminal)) {
          failureHandle = terminal;
        }
      },
    });
    await Promise.resolve();
    const processRequest = worker.posted.find(
      (candidate): candidate is ProcessFrameRequest =>
        typeof candidate === "object" &&
        candidate != null &&
        "action" in candidate &&
        candidate.action === "processRGBAImageFrame",
    );
    expect(processRequest).toBeDefined();

    worker.emitFailure(
      "error",
      new Error("sensitive active worker detail"),
    );
    await processing;

    expect(deliveredResult).toEqual(WALLET_RECOVERY_SCANNER_ATTEMPT_FAILED);
    expect(JSON.stringify(deliveredResult)).not.toContain("sensitive");
    expect(disposeCapture).toHaveBeenCalledTimes(1);
    expect(frameProcessorState.dispose).toHaveBeenCalledTimes(1);
    expect(mediaStreamState.dispose).toHaveBeenCalledTimes(1);
    expect(onWalletAttemptCompleted).toHaveBeenCalledTimes(1);
    expect(worker.terminate).not.toHaveBeenCalled();
    const terminationRequest = worker.posted.find(
      (candidate): candidate is TerminateSessionRequest =>
        typeof candidate === "object" &&
        candidate != null &&
        "action" in candidate &&
        candidate.action === "terminateSession",
    );
    expect(terminationRequest).toBeDefined();
    let cleanupSettled = false;
    void failureHandle!.cleanupSettlement.then(() => {
      cleanupSettled = true;
    });
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);

    new Uint8Array(processRequest!.rgbImageAsArrayBuffer).fill(0);
    worker.emit({
      action: "sessionTerminated",
      sessionId: terminationRequest!.sessionId,
      requestId: terminationRequest!.requestId,
    });
    await expect(failureHandle!.cleanupSettlement).resolves.toBeUndefined();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  test("legacy frame rejection retains legacy non-terminal behavior", async () => {
    const scannerAttempt = {
      processDiceKeyImageFrame: jest.fn(() =>
        Promise.reject(new Error("legacy worker failure"))),
      unmount: jest.fn(() => Promise.resolve()),
    } as unknown as ScannerAttemptLifecycle;
    const frameProcessorState = {
      scanningSuccessfulEnoughToTerminate: false,
      handleProcessedCameraFrame: jest.fn(),
      dispose: jest.fn(),
    } as unknown as DiceKeyFrameProcessorState;
    const mediaStreamState = {
      dispose: jest.fn(),
    } as unknown as MediaStreamState;
    const disposeCapture = jest.fn();
    const onWalletAttemptCompleted = jest.fn();
    const onWalletRecoveryScan = jest.fn();

    await processCapturedFrameForScannerAttempt({
      framesImageData: testImageData(),
      canvasRenderingContext: {} as CanvasRenderingContext2D,
      scanMode: "legacy",
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
      onWalletAttemptCompleted,
      onWalletRecoveryScan,
    });

    expect(disposeCapture).not.toHaveBeenCalled();
    expect(frameProcessorState.dispose).not.toHaveBeenCalled();
    expect(mediaStreamState.dispose).not.toHaveBeenCalled();
    expect(scannerAttempt.unmount).not.toHaveBeenCalled();
    expect(onWalletAttemptCompleted).not.toHaveBeenCalled();
    expect(onWalletRecoveryScan).not.toHaveBeenCalled();
  });

  test("legacy resolved exception retains legacy frame-response handling", async () => {
    const request: ProcessFrameRequest = {
      action: "processRGBAImageFrame",
      sessionId: "legacy-exception-session",
      requestId: 1,
      width: 1,
      height: 1,
      rgbImageAsArrayBuffer: new ArrayBuffer(4),
    };
    const response = frameResponse(request, {
      exception: new Error("legacy native exception"),
    });
    const scannerAttempt = {
      acquisitionId: request.sessionId,
      processDiceKeyImageFrame: jest.fn(() => Promise.resolve(response)),
      unmount: jest.fn(() => Promise.resolve()),
    } as unknown as ScannerAttemptLifecycle;
    const frameProcessorState = {
      scanningSuccessfulEnoughToTerminate: false,
      handleProcessedCameraFrame: jest.fn(),
      dispose: jest.fn(),
    } as unknown as DiceKeyFrameProcessorState;
    const mediaStreamState = {
      dispose: jest.fn(),
    } as unknown as MediaStreamState;
    const disposeCapture = jest.fn();

    await processCapturedFrameForScannerAttempt({
      framesImageData: testImageData(),
      canvasRenderingContext: {} as CanvasRenderingContext2D,
      scanMode: "legacy",
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
      onWalletAttemptCompleted: jest.fn(),
      onWalletRecoveryScan: jest.fn(),
    });

    expect(frameProcessorState.handleProcessedCameraFrame)
      .toHaveBeenCalledWith(response, expect.anything());
    expect(disposeCapture).not.toHaveBeenCalled();
    expect(frameProcessorState.dispose).not.toHaveBeenCalled();
    expect(mediaStreamState.dispose).not.toHaveBeenCalled();
    expect(scannerAttempt.unmount).not.toHaveBeenCalled();
  });

  test("late rejection from an already-unmounted wallet attempt is ignored", async () => {
    const frameResult = deferred<ProcessFrameResponse>();
    const client = {
      acquisitionId: "unmounted-failure-session",
      processDiceKeyImageFrame: jest.fn(() => frameResult.promise),
      dispose: jest.fn(() => Promise.resolve()),
    };
    const scannerAttempt = new ScannerAttemptLifecycle(() => client);
    scannerAttempt.mount();
    const frameProcessorState = {
      scanningSuccessfulEnoughToTerminate: false,
      handleProcessedCameraFrame: jest.fn(),
      dispose: jest.fn(),
    } as unknown as DiceKeyFrameProcessorState;
    const mediaStreamState = {
      dispose: jest.fn(),
    } as unknown as MediaStreamState;
    const disposeCapture = jest.fn();
    const onWalletAttemptCompleted = jest.fn();
    const onWalletRecoveryScan = jest.fn();
    const processing = processCapturedFrameForScannerAttempt({
      framesImageData: testImageData(),
      canvasRenderingContext: {} as CanvasRenderingContext2D,
      scanMode: "wallet-recovery",
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
      onWalletAttemptCompleted,
      onWalletRecoveryScan,
    });

    await scannerAttempt.unmount();
    frameResult.reject(new Error("late stale rejection"));
    await processing;

    expect(client.dispose).toHaveBeenCalledTimes(1);
    expect(disposeCapture).not.toHaveBeenCalled();
    expect(frameProcessorState.dispose).not.toHaveBeenCalled();
    expect(mediaStreamState.dispose).not.toHaveBeenCalled();
    expect(onWalletAttemptCompleted).not.toHaveBeenCalled();
    expect(onWalletRecoveryScan).not.toHaveBeenCalled();
  });

  test("late resolved response cannot cross an unmount/remount attempt boundary", async () => {
    const firstFrameResult = deferred<ProcessFrameResponse>();
    const clients = [
      {
        acquisitionId: "resolved-old-session",
        processDiceKeyImageFrame: jest.fn((imageData: ImageData) => {
          imageData.data.fill(0);
          return firstFrameResult.promise;
        }),
        dispose: jest.fn(() => Promise.resolve()),
      },
      {
        acquisitionId: "resolved-new-session",
        processDiceKeyImageFrame: jest.fn(),
        dispose: jest.fn(() => Promise.resolve()),
      },
    ];
    let nextClient = 0;
    const scannerAttempt = new ScannerAttemptLifecycle(
      () => clients[nextClient++]!,
    );
    scannerAttempt.mount();
    const frameProcessorState = {
      scanningSuccessfulEnoughToTerminate: false,
      handleProcessedCameraFrame: jest.fn(),
      dispose: jest.fn(),
    } as unknown as DiceKeyFrameProcessorState;
    const mediaStreamState = {
      dispose: jest.fn(),
    } as unknown as MediaStreamState;
    const disposeCapture = jest.fn();
    const onWalletAttemptCompleted = jest.fn();
    const onWalletRecoveryScan = jest.fn();
    const responseImage = new Uint8ClampedArray([5, 6, 7, 8]);
    const faceObject = { squareImageAsRgbaArray: responseImage };
    const processing = processCapturedFrameForScannerAttempt({
      framesImageData: testImageData(),
      canvasRenderingContext: {} as CanvasRenderingContext2D,
      scanMode: "wallet-recovery",
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
      onWalletAttemptCompleted,
      onWalletRecoveryScan,
    });
    const response = frameResponse({
      action: "processRGBAImageFrame",
      sessionId: "resolved-old-session",
      requestId: 1,
      width: 1,
      height: 1,
      rgbImageAsArrayBuffer: new ArrayBuffer(4),
    }, {
      facesReadObjectArray: [faceObject] as unknown as
        ProcessFrameResponse["facesReadObjectArray"],
    });

    firstFrameResult.resolve(response);
    const oldCleanup = scannerAttempt.unmount();
    scannerAttempt.mount();
    await oldCleanup;
    await processing;

    expect(scannerAttempt.acquisitionId).toBe("resolved-new-session");
    expect(frameProcessorState.handleProcessedCameraFrame).not.toHaveBeenCalled();
    expect(onWalletRecoveryScan).not.toHaveBeenCalled();
    expect(onWalletAttemptCompleted).not.toHaveBeenCalled();
    expect(disposeCapture).not.toHaveBeenCalled();
    expect(frameProcessorState.dispose).not.toHaveBeenCalled();
    expect(mediaStreamState.dispose).not.toHaveBeenCalled();
    expect([...responseImage]).toEqual([0, 0, 0, 0]);
    expect(faceObject.squareImageAsRgbaArray).toBeUndefined();
    await scannerAttempt.unmount();
    expect(clients[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(clients[1]!.dispose).toHaveBeenCalledTimes(1);
  });

  test("attempt-bound acquisition is inert before delivery and settles exactly once", async () => {
    const cleanup = deferred<void>();
    let attemptUsable = true;
    const scannerAttempt = {
      acquisitionId: "actual-worker-session-id",
      unmount: jest.fn(() => {
        attemptUsable = false;
        return cleanup.promise;
      }),
    } as unknown as ScannerAttemptLifecycle;
    const frameProcessorState = {
      dispose: jest.fn(),
    } as unknown as DiceKeyFrameProcessorState;
    const mediaStreamState = {
      dispose: jest.fn(),
    } as unknown as MediaStreamState;
    const disposeCapture = jest.fn();
    const onWalletAttemptCompleted = jest.fn();
    const onWalletRecoveryScan = jest.fn((
      result: WalletRecoveryScannerResult,
      terminal?: WalletRecoveryScannerTerminal,
    ) => {
      expect(result.status).toBe("exact");
      if (terminal == null || !("faces" in terminal)) {
        throw new Error("expected acquisition");
      }
      const acquisition = terminal;
      expect(attemptUsable).toBe(false);
      expect(disposeCapture).toHaveBeenCalledTimes(1);
      expect(frameProcessorState.dispose).toHaveBeenCalledTimes(1);
      expect(mediaStreamState.dispose).toHaveBeenCalledTimes(1);
      expect(acquisition.acquisitionId).toBe("actual-worker-session-id");
      expect(Object.isFrozen(acquisition)).toBe(true);
      expect(Object.keys(acquisition).sort()).toEqual([
        "acquisitionId",
        "cleanupSettlement",
        "confidence",
        "dispose",
        "faces",
      ]);
      acquisition.dispose();
    });
    const result = evaluateWalletRecoveryScannerRead(scannerFaces());
    if (result.status === "rescan") throw new Error("expected candidate");

    const handle = deliverWalletRecoveryScannerResult({
      result,
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
      onWalletAttemptCompleted,
      onWalletRecoveryScan,
    });

    expect(handle).toBeDefined();
    expect(handle!.acquisitionId).toBe("actual-worker-session-id");
    expect(Object.isFrozen(handle)).toBe(true);
    expect(onWalletAttemptCompleted).toHaveBeenCalledTimes(1);
    expect(disposeCapture).toHaveBeenCalledTimes(1);
    expect(scannerAttempt.unmount).toHaveBeenCalledTimes(1);
    let settled = false;
    void handle!.cleanupSettlement.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    handle!.dispose();
    expect(scannerAttempt.unmount).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    await expect(handle!.cleanupSettlement).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  test("terminal callback failure cannot bypass attempt disposal", async () => {
    const scannerAttempt = {
      acquisitionId: "throwing-terminal-session",
      unmount: jest.fn(() => Promise.resolve()),
    } as unknown as ScannerAttemptLifecycle;
    const frameProcessorState = {
      dispose: jest.fn(),
    } as unknown as DiceKeyFrameProcessorState;
    const mediaStreamState = {
      dispose: jest.fn(),
    } as unknown as MediaStreamState;
    let acquisition:
      | ReturnType<typeof scannerCandidateToSanitizedAcquisition>
      | undefined;
    const result = evaluateWalletRecoveryScannerRead(scannerFaces());
    if (result.status === "rescan") throw new Error("expected candidate");

    expect(() => deliverWalletRecoveryScannerResult({
      result,
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      onWalletAttemptCompleted: jest.fn(),
      onWalletRecoveryScan: (_result, deliveredAcquisition) => {
        if (deliveredAcquisition != null && "faces" in deliveredAcquisition) {
          acquisition = deliveredAcquisition;
        }
        expect(scannerAttempt.unmount).toHaveBeenCalledTimes(1);
        throw new Error("terminal consumer failed");
      },
    })).toThrow("terminal consumer failed");

    expect(frameProcessorState.dispose).toHaveBeenCalledTimes(1);
    expect(mediaStreamState.dispose).toHaveBeenCalledTimes(1);
    expect(scannerAttempt.unmount).toHaveBeenCalledTimes(1);
    if (acquisition == null) throw new Error("expected acquisition");
    await expect(acquisition.cleanupSettlement).resolves.toBeUndefined();
  });

  test("completion notification failure rejects only after cleanup runs", async () => {
    const scannerAttempt = {
      acquisitionId: "throwing-completion-session",
      unmount: jest.fn(() => Promise.resolve()),
    } as unknown as ScannerAttemptLifecycle;
    const frameProcessorState = {
      dispose: jest.fn(),
    } as unknown as DiceKeyFrameProcessorState;
    const mediaStreamState = {
      dispose: jest.fn(),
    } as unknown as MediaStreamState;
    const result = evaluateWalletRecoveryScannerRead(scannerFaces());
    if (result.status === "rescan") throw new Error("expected candidate");

    const handle = deliverWalletRecoveryScannerResult({
      result,
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      onWalletAttemptCompleted: () => {
        throw new Error("completion notification failed");
      },
      onWalletRecoveryScan: jest.fn(),
    });

    expect(frameProcessorState.dispose).toHaveBeenCalledTimes(1);
    expect(mediaStreamState.dispose).toHaveBeenCalledTimes(1);
    expect(scannerAttempt.unmount).toHaveBeenCalledTimes(1);
    if (handle == null) throw new Error("expected acquisition handle");
    await expect(handle.cleanupSettlement).rejects.toThrow(
      "completion notification failed",
    );
  });

  test("candidate adapter maps flagged indexes to physical positions", () => {
    const result = evaluateWalletRecoveryScannerRead((() => {
      const faces = scannerFaces();
      faces[0]!.errors = [{ type: "undoverline-missing" }];
      faces[24]!.errors = [{ type: "undoverline-bit-mismatch" }];
      return faces;
    })());
    if (result.status !== "requires-confirmation") {
      throw new Error("expected review candidate");
    }
    const handle = createWalletRecoveryScannerAcquisitionHandle(
      "review-attempt",
      () => Promise.resolve(),
    );
    const acquisition = scannerCandidateToSanitizedAcquisition(result, handle);

    expect(acquisition).toMatchObject({
      acquisitionId: "review-attempt",
      confidence: "review-required",
      reviewRequiredPositions: [1, 25],
    });
    expect(Object.isFrozen(acquisition)).toBe(true);
    expect(Object.isFrozen(acquisition.reviewRequiredPositions)).toBe(true);
  });
});

describe("per-attempt worker client", () => {
  test("transfer-aware harness performs real ArrayBuffer detachment", () => {
    const source = new Uint8Array([4, 3, 2, 1]);
    const cloned = clonePostedMessage(
      { buffer: source.buffer },
      [source.buffer],
    );
    expect(source.buffer.byteLength).toBe(0);
    expect([...new Uint8Array(cloned.buffer)]).toEqual([4, 3, 2, 1]);
  });

  test("two scanner attempts own distinct sessions and request sequences", async () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    let firstSenderCopy: ArrayBuffer | undefined;
    let secondSenderCopy: ArrayBuffer | undefined;
    const first = new DiceKeyFrameWorkerClient({
      createWorker: () => firstWorker,
      createFrameBuffer: (source) => {
        const owned = new ScannerOwnedFrameBuffer(source);
        firstSenderCopy = owned.arrayBuffer;
        return owned;
      },
    });
    const second = new DiceKeyFrameWorkerClient({
      createWorker: () => secondWorker,
      createFrameBuffer: (source) => {
        const owned = new ScannerOwnedFrameBuffer(source);
        secondSenderCopy = owned.arrayBuffer;
        return owned;
      },
    });
    firstWorker.emit({ action: "workerReady" });
    secondWorker.emit({ action: "workerReady" });

    const firstImage = testImageData();
    const secondImage = testImageData();
    const firstPromise = first.processDiceKeyImageFrame(firstImage);
    const secondPromise = second.processDiceKeyImageFrame(secondImage);
    expect([...firstImage.data]).toEqual([0, 0, 0, 0]);
    expect([...secondImage.data]).toEqual([0, 0, 0, 0]);
    await Promise.resolve();
    const firstRequest = firstWorker.posted[0] as ProcessFrameRequest;
    const secondRequest = secondWorker.posted[0] as ProcessFrameRequest;
    expect(firstRequest.sessionId).not.toBe(secondRequest.sessionId);
    expect(firstRequest.requestId).toBe(1);
    expect(secondRequest.requestId).toBe(1);
    expect(firstWorker.transfers[0]).toHaveLength(1);
    expect(secondWorker.transfers[0]).toHaveLength(1);
    expect(firstWorker.transfers[0]![0]).toBe(firstSenderCopy);
    expect(secondWorker.transfers[0]![0]).toBe(secondSenderCopy);
    expect(firstSenderCopy!.byteLength).toBe(0);
    expect(secondSenderCopy!.byteLength).toBe(0);
    expect([...new Uint8Array(firstRequest.rgbImageAsArrayBuffer)]).toEqual([1, 2, 3, 4]);
    expect([...new Uint8Array(secondRequest.rgbImageAsArrayBuffer)]).toEqual([1, 2, 3, 4]);

    firstWorker.emit(frameResponse(firstRequest));
    secondWorker.emit(frameResponse(secondRequest));
    await expect(firstPromise).resolves.toMatchObject({ requestId: 1 });
    await expect(secondPromise).resolves.toMatchObject({ requestId: 1 });

    const firstDispose = first.dispose();
    const firstTerminate = firstWorker.posted.at(-1) as TerminateSessionRequest;
    firstWorker.emit({
      action: "sessionTerminated",
      sessionId: firstTerminate.sessionId,
      requestId: firstTerminate.requestId,
    });
    const secondDispose = second.dispose();
    const secondTerminate = secondWorker.posted.at(-1) as TerminateSessionRequest;
    secondWorker.emit({
      action: "sessionTerminated",
      sessionId: secondTerminate.sessionId,
      requestId: secondTerminate.requestId,
    });
    await Promise.all([firstDispose, secondDispose]);
  });

  test("dispose before workerReady rejects and wipes source plus owned copy", async () => {
    const worker = new FakeWorker();
    let copiedBuffer: ArrayBuffer | undefined;
    const client = new DiceKeyFrameWorkerClient({
      createWorker: () => worker,
      createFrameBuffer: (source) => {
        const owned = new ScannerOwnedFrameBuffer(source);
        copiedBuffer = owned.arrayBuffer;
        return owned;
      },
    });
    const image = testImageData();
    const pending = client.processDiceKeyImageFrame(image);
    expect([...image.data]).toEqual([0, 0, 0, 0]);

    const disposal = client.dispose();
    await expect(pending).rejects.toThrow("disposed");
    await disposal;

    expect(copiedBuffer).toBeDefined();
    expect([...new Uint8Array(copiedBuffer!)]).toEqual([0, 0, 0, 0]);
    expect(worker.posted).toHaveLength(0);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.removeEventListener).toHaveBeenCalledTimes(3);
  });

  test("active native session waits for worker cleanup acknowledgement before termination", async () => {
    const worker = new FakeWorker();
    let senderCopy: ArrayBuffer | undefined;
    const client = new DiceKeyFrameWorkerClient({
      createWorker: () => worker,
      createFrameBuffer: (source) => {
        const owned = new ScannerOwnedFrameBuffer(source);
        senderCopy = owned.arrayBuffer;
        return owned;
      },
    });
    worker.emit({ action: "workerReady" });
    const pending = client.processDiceKeyImageFrame(testImageData());
    await Promise.resolve();
    const workerRequest = worker.posted[0] as ProcessFrameRequest;

    expect(worker.transfers[0]).toHaveLength(1);
    expect(worker.transfers[0]![0]).toBe(senderCopy);
    expect(senderCopy!.byteLength).toBe(0);
    expect([...new Uint8Array(workerRequest.rgbImageAsArrayBuffer)]).toEqual([1, 2, 3, 4]);

    const disposal = client.dispose();
    await expect(pending).rejects.toThrow("disposed");
    await Promise.resolve();

    expect(worker.terminate).not.toHaveBeenCalled();
    expect([...new Uint8Array(workerRequest.rgbImageAsArrayBuffer)])
      .toEqual([1, 2, 3, 4]);

    wipeScannerRgbaRequest(workerRequest);
    const termination = worker.posted.at(-1) as TerminateSessionRequest;
    worker.emit({
      action: "sessionTerminated",
      sessionId: termination.sessionId,
      requestId: termination.requestId,
    });
    await disposal;

    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect([...new Uint8Array(workerRequest.rgbImageAsArrayBuffer)]).toEqual([0, 0, 0, 0]);
  });

  test("pristine worker terminates directly without native state", async () => {
    const worker = new FakeWorker();
    const client = new DiceKeyFrameWorkerClient({ createWorker: () => worker });

    await client.dispose();

    expect(worker.posted).toEqual([]);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.removeEventListener).toHaveBeenCalledTimes(3);
  });

  test.each(["error", "messageerror"] as const)(
    "worker %s rejects pre-ready work, wipes owned bytes, and terminates once",
    async (eventType) => {
      const worker = new FakeWorker();
      let copiedBuffer: ArrayBuffer | undefined;
      const client = new DiceKeyFrameWorkerClient({
        createWorker: () => worker,
        createFrameBuffer: (source) => {
          const owned = new ScannerOwnedFrameBuffer(source);
          copiedBuffer = owned.arrayBuffer;
          return owned;
        },
      });
      const image = testImageData();
      const pending = client.processDiceKeyImageFrame(image);
      const failure = new Error(`${eventType} failure`);

      worker.emitFailure(eventType, failure);

      await expect(pending).rejects.toBe(failure);
      expect([...image.data]).toEqual([0, 0, 0, 0]);
      expect([...new Uint8Array(copiedBuffer!)]).toEqual([0, 0, 0, 0]);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(worker.removeEventListener).toHaveBeenCalledTimes(3);

      await client.dispose();
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    },
  );

  test("explicit WASM bootstrap failure settles readiness and wipes owned bytes", async () => {
    const worker = new FakeWorker();
    let copiedBuffer: ArrayBuffer | undefined;
    const client = new DiceKeyFrameWorkerClient({
      createWorker: () => worker,
      createFrameBuffer: (source) => {
        const owned = new ScannerOwnedFrameBuffer(source);
        copiedBuffer = owned.arrayBuffer;
        return owned;
      },
    });
    const image = testImageData();
    const pending = client.processDiceKeyImageFrame(image);

    worker.emit({
      action: "workerInitializationFailed",
      message: "WASM bootstrap rejected",
    });

    await expect(pending).rejects.toThrow("WASM bootstrap rejected");
    expect([...image.data]).toEqual([0, 0, 0, 0]);
    expect([...new Uint8Array(copiedBuffer!)]).toEqual([0, 0, 0, 0]);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await client.dispose();
  });

  test.each(["error", "messageerror"] as const)(
    "active worker %s waits for correlated cleanup acknowledgement",
    async (eventType) => {
      const worker = new FakeWorker();
      const client = new DiceKeyFrameWorkerClient({ createWorker: () => worker });
      worker.emit({ action: "workerReady" });
      const pending = client.processDiceKeyImageFrame(testImageData());
      await Promise.resolve();
      const request = worker.posted[0] as ProcessFrameRequest;
      const failure = new Error(`active ${eventType} failure`);

      worker.emitFailure(eventType, failure);
      await expect(pending).rejects.toBe(failure);
      const disposal = client.dispose();
      const termination = worker.posted.at(-1) as TerminateSessionRequest;
      expect(termination.action).toBe("terminateSession");
      expect(worker.terminate).not.toHaveBeenCalled();

      wipeScannerRgbaRequest(request);
      worker.emit({
        action: "sessionTerminated",
        sessionId: termination.sessionId,
        requestId: termination.requestId,
      });
      await disposal;
      expect([...new Uint8Array(request.rgbImageAsArrayBuffer)])
        .toEqual([0, 0, 0, 0]);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    },
  );

  test("dirty termination-post failure force-terminates with an unconfirmed result", async () => {
    const worker = new FakeWorker();
    const originalPostMessage = worker.postMessage.bind(worker);
    const postMessage = jest.spyOn(worker, "postMessage");
    postMessage.mockImplementation((message, transfer) => {
      if ((message as { action?: unknown }).action === "terminateSession") {
        throw new Error("terminate post failed");
      }
      originalPostMessage(message, transfer);
    });
    const client = new DiceKeyFrameWorkerClient({ createWorker: () => worker });
    worker.emit({ action: "workerReady" });
    const pending = client.processDiceKeyImageFrame(testImageData());
    await Promise.resolve();

    const disposal = client.dispose();
    await expect(pending).rejects.toThrow("disposed");
    await expect(disposal).rejects.toBeInstanceOf(
      ScannerWorkerCleanupUnconfirmedError,
    );
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.removeEventListener).toHaveBeenCalledTimes(3);
  });

  test("dirty cleanup error rejects disposal and reclaims the isolated worker", async () => {
    const worker = new FakeWorker();
    const client = new DiceKeyFrameWorkerClient({ createWorker: () => worker });
    worker.emit({ action: "workerReady" });
    const pending = client.processDiceKeyImageFrame(testImageData());
    await Promise.resolve();
    const request = worker.posted[0] as ProcessFrameRequest;

    const disposal = client.dispose();
    await expect(pending).rejects.toThrow("disposed");
    const cleanupFailure = new Error("native cleanup failed");
    worker.emitFailure("error", cleanupFailure);

    const cleanupResult = await disposal.catch((error: unknown) => error);
    expect(cleanupResult).toBeInstanceOf(ScannerWorkerCleanupUnconfirmedError);
    expect((cleanupResult as ScannerWorkerCleanupUnconfirmedError).cleanupCause)
      .toBe(cleanupFailure);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.removeEventListener).toHaveBeenCalledTimes(3);
    wipeScannerRgbaRequest(request);
  });

  test("missing cleanup acknowledgement has a bounded cleanup timeout", async () => {
    jest.useFakeTimers();
    const worker = new FakeWorker();
    let detachedSenderCopy: ArrayBuffer | undefined;
    const client = new DiceKeyFrameWorkerClient({
      createWorker: () => worker,
      cleanupTimeoutMs: 5,
      createFrameBuffer: (source) => {
        const owned = new ScannerOwnedFrameBuffer(source);
        detachedSenderCopy = owned.arrayBuffer;
        return owned;
      },
    });
    worker.emit({ action: "workerReady" });
    const source = testImageData();
    const pending = client.processDiceKeyImageFrame(source);
    await Promise.resolve();
    const request = worker.posted[0] as ProcessFrameRequest;

    const disposal = client.dispose();
    const cleanupResultPromise = disposal.catch((error: unknown) => error);
    await expect(pending).rejects.toThrow("disposed");
    expect([...source.data]).toEqual([0, 0, 0, 0]);
    expect(detachedSenderCopy!.byteLength).toBe(0);

    jest.advanceTimersByTime(4);
    await Promise.resolve();
    expect(worker.terminate).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    const cleanupResult = await cleanupResultPromise;

    expect(cleanupResult).toBeInstanceOf(ScannerWorkerCleanupUnconfirmedError);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.removeEventListener).toHaveBeenCalledTimes(3);
    // The fake retains its cloned object for inspection; a real terminated
    // Worker makes this isolated backing store unreachable with its realm.
    expect([...new Uint8Array(request.rgbImageAsArrayBuffer)])
      .toEqual([1, 2, 3, 4]);
    wipeScannerRgbaRequest(request);
    jest.useRealTimers();
  });

  test("ignores stale replies until action, session id, and request id all match", async () => {
    const worker = new FakeWorker();
    const client = new DiceKeyFrameWorkerClient({ createWorker: () => worker });
    worker.emit({ action: "workerReady" });
    const responsePromise = client.processDiceKeyImageFrame(testImageData());
    await Promise.resolve();
    const request = worker.posted[0] as ProcessFrameRequest;
    let resolved = false;
    void responsePromise.then(() => { resolved = true; });

    const wrongSessionImage = new Uint8ClampedArray([9, 8]);
    const wrongSessionResponse = frameResponseWithFaceImage(
      { ...request, sessionId: "stale-session" },
      wrongSessionImage,
    );
    worker.emit(wrongSessionResponse.response);
    expect([...wrongSessionImage]).toEqual([0, 0]);
    expect(wrongSessionResponse.faceObject.squareImageAsRgbaArray).toBeUndefined();

    const wrongRequestImage = new Uint8ClampedArray([7, 6]);
    const wrongRequestResponse = frameResponseWithFaceImage(
      { ...request, requestId: request.requestId + 1 },
      wrongRequestImage,
    );
    worker.emit(wrongRequestResponse.response);
    expect([...wrongRequestImage]).toEqual([0, 0]);
    expect(wrongRequestResponse.faceObject.squareImageAsRgbaArray).toBeUndefined();
    worker.emit({ ...frameResponse(request), action: "unrelated-action" });
    await Promise.resolve();
    expect(resolved).toBe(false);

    worker.emit(frameResponse(request));
    await expect(responsePromise).resolves.toMatchObject({
      sessionId: request.sessionId,
      requestId: request.requestId,
    });
    const disposal = client.dispose();
    const termination = worker.posted.at(-1) as TerminateSessionRequest;
    worker.emit({
      action: "sessionTerminated",
      sessionId: termination.sessionId,
      requestId: termination.requestId,
    });
    await disposal;
  });

  test("dispose rejects pending work and removes listener/terminates exactly once", async () => {
    const worker = new FakeWorker();
    const client = new DiceKeyFrameWorkerClient({ createWorker: () => worker });
    worker.emit({ action: "workerReady" });
    const pending = client.processDiceKeyImageFrame(testImageData());
    await Promise.resolve();
    const request = worker.posted[0] as ProcessFrameRequest;
    const disposal = client.dispose();
    const sameDisposal = client.dispose();
    const termination = worker.posted.at(-1) as TerminateSessionRequest;

    await expect(pending).rejects.toThrow("disposed");
    const disposedImage = new Uint8ClampedArray([5, 4]);
    const disposedResponse = frameResponseWithFaceImage(request, disposedImage);
    worker.emit(disposedResponse.response);
    expect([...disposedImage]).toEqual([0, 0]);
    expect(disposedResponse.faceObject.squareImageAsRgbaArray).toBeUndefined();
    worker.emit({
      action: "sessionTerminated",
      sessionId: termination.sessionId,
      requestId: termination.requestId + 1,
    });
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.emit({
      action: "sessionTerminated",
      sessionId: termination.sessionId,
      requestId: termination.requestId,
    });
    await Promise.all([disposal, sameDisposal]);
    expect(worker.removeEventListener).toHaveBeenCalledTimes(3);
    expect(worker.terminate).toHaveBeenCalledTimes(1);

    worker.emit(frameResponse(worker.posted[0] as ProcessFrameRequest));
    await client.dispose();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});

describe("native processor ownership", () => {
  test("deletes each native processor exactly once on session termination or cleanup", () => {
    const processors = [
      { delete: jest.fn() },
      { delete: jest.fn() },
    ];
    const store = new ScannerNativeProcessorStore(() => processors.shift()!);
    const first = store.getOrCreate("first");
    expect(store.getOrCreate("first")).toBe(first);
    const second = store.getOrCreate("second");

    store.deleteSession("first");
    store.deleteSession("first");
    store.dispose();
    store.dispose();

    expect(first.delete).toHaveBeenCalledTimes(1);
    expect(second.delete).toHaveBeenCalledTimes(1);
  });
});

describe("production worker session message handler", () => {
  test("correlates frame and termination messages, acknowledges, and deletes once", () => {
    const port = new FakeWorkerSessionPort();
    const processor = { delete: jest.fn(() => {
      expect(port.posted).not.toContainEqual(expect.objectContaining({
        action: "sessionTerminated",
      }));
    }) };
    const processFrame = jest.fn((request: ProcessFrameRequest) =>
      frameResponse(request, { isFinished: true }));
    const handler = new ScannerWorkerSessionHandler({
      port,
      createProcessor: () => processor,
      isProcessRequest: isProcessFrameRequestForTest,
      processFrame,
      cleanupProcessRequest: wipeScannerRgbaRequest,
    });
    expect(port.posted).toEqual([{ action: "workerReady" }]);

    const request: ProcessFrameRequest = {
      action: "processRGBAImageFrame",
      sessionId: "production-session",
      requestId: 41,
      width: 1,
      height: 1,
      rgbImageAsArrayBuffer: new ArrayBuffer(4),
    };
    port.emit(request);
    expect(processFrame).toHaveBeenCalledWith(request, processor);
    expect(port.posted[1]).toMatchObject({
      action: "processRGBAImageFrame",
      sessionId: "production-session",
      requestId: 41,
    });

    port.emit({
      action: "terminateSession",
      sessionId: "production-session",
      requestId: 41,
    });
    expect(processor.delete).not.toHaveBeenCalled();
    expect(port.close).not.toHaveBeenCalled();

    const wrongSessionBuffer = new Uint8Array([9, 8, 7, 6]);
    port.emit({
      ...request,
      sessionId: "wrong-session",
      requestId: 42,
      rgbImageAsArrayBuffer: wrongSessionBuffer.buffer,
    });
    expect(processFrame).toHaveBeenCalledTimes(1);
    expect([...wrongSessionBuffer]).toEqual([0, 0, 0, 0]);

    port.emit({
      action: "terminateSession",
      sessionId: "wrong-session",
      requestId: 42,
    });
    expect(processor.delete).not.toHaveBeenCalled();
    expect(port.close).not.toHaveBeenCalled();

    port.emit({
      action: "terminateSession",
      sessionId: "production-session",
      requestId: "malformed",
    });
    expect(processor.delete).not.toHaveBeenCalled();

    port.emit({
      action: "terminateSession",
      sessionId: "production-session",
      requestId: 42,
    });
    expect(port.posted.at(-1)).toEqual({
      action: "sessionTerminated",
      sessionId: "production-session",
      requestId: 42,
    });
    expect(processor.delete).toHaveBeenCalledTimes(1);
    expect(port.removeEventListener).toHaveBeenCalledTimes(1);
    expect(port.close).toHaveBeenCalledTimes(1);

    port.emit({ ...request, requestId: 43 });
    handler.dispose();
    handler.dispose();
    expect(processFrame).toHaveBeenCalledTimes(1);
    expect(processor.delete).toHaveBeenCalledTimes(1);
    expect(port.close).toHaveBeenCalledTimes(1);
  });

  test("never acknowledges cleanup when native deletion throws", () => {
    const port = new FakeWorkerSessionPort();
    const deleteFailure = new Error("native delete failed");
    const processor = {
      delete: jest.fn(() => { throw deleteFailure; }),
    };
    const handler = new ScannerWorkerSessionHandler({
      port,
      createProcessor: () => processor,
      isProcessRequest: isProcessFrameRequestForTest,
      processFrame: (request: ProcessFrameRequest) => frameResponse(request),
    });
    port.emit({
      action: "processRGBAImageFrame",
      sessionId: "delete-failure-session",
      requestId: 1,
      width: 1,
      height: 1,
      rgbImageAsArrayBuffer: new ArrayBuffer(4),
    });

    expect(() => port.emit({
      action: "terminateSession",
      sessionId: "delete-failure-session",
      requestId: 2,
    })).toThrow(deleteFailure);
    expect(processor.delete).toHaveBeenCalledTimes(1);
    expect(port.posted).not.toContainEqual(expect.objectContaining({
      action: "sessionTerminated",
    }));
    expect(port.close).toHaveBeenCalledTimes(1);

    handler.dispose();
    expect(processor.delete).toHaveBeenCalledTimes(1);
    expect(port.close).toHaveBeenCalledTimes(1);
  });

  test("wipes a frame request even when native processor construction throws", () => {
    const port = new FakeWorkerSessionPort();
    const requestBytes = new Uint8Array([6, 5, 4, 3]);
    const handler = new ScannerWorkerSessionHandler({
      port,
      createProcessor: () => { throw new Error("native constructor failed"); },
      isProcessRequest: isProcessFrameRequestForTest,
      processFrame: (request: ProcessFrameRequest, _processor: {delete(): void}) =>
        frameResponse(request),
      cleanupProcessRequest: wipeScannerRgbaRequest,
    });

    expect(() => port.emit({
      action: "processRGBAImageFrame",
      sessionId: "constructor-failure-session",
      requestId: 1,
      width: 1,
      height: 1,
      rgbImageAsArrayBuffer: requestBytes.buffer,
    })).toThrow("native constructor failed");
    expect([...requestBytes]).toEqual([0, 0, 0, 0]);

    handler.dispose();
    expect(port.close).toHaveBeenCalledTimes(1);
  });

  test("wipes malformed process-message RGBA before rejecting the message", () => {
    const port = new FakeWorkerSessionPort();
    const processor = { delete: jest.fn() };
    const processFrame = jest.fn();
    const malformedBytes = new Uint8Array([4, 5, 6, 7]);
    const handler = new ScannerWorkerSessionHandler({
      port,
      createProcessor: () => processor,
      isProcessRequest: isProcessFrameRequestForTest,
      processFrame,
    });

    port.emit({
      action: "processRGBAImageFrame",
      sessionId: "malformed-process-session",
      requestId: "not-a-number",
      width: 1,
      height: 1,
      rgbImageAsArrayBuffer: malformedBytes.buffer,
    });

    expect([...malformedBytes]).toEqual([0, 0, 0, 0]);
    const malformedBacking = new Uint8Array([9, 8, 7, 6, 5, 4]);
    const malformedView = new Uint8ClampedArray(
      malformedBacking.buffer,
      1,
      4,
    );
    port.emit({
      action: "processRGBAImageFrame",
      sessionId: "malformed-process-session",
      requestId: "still-not-a-number",
      width: 1,
      height: 1,
      rgbImageAsArrayBuffer: malformedView,
    });
    expect([...malformedBacking]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(processFrame).not.toHaveBeenCalled();
    expect(processor.delete).not.toHaveBeenCalled();
    handler.dispose();
  });

  test("wipes worker response face-image copies only after postMessage clones them", () => {
    const port = new FakeWorkerSessionPort();
    const requestBytes = new Uint8Array([1, 2, 3, 4]);
    const responseImage = new Uint8ClampedArray([10, 11, 12, 13]);
    const response = {
      action: "processRGBAImageFrame" as const,
      sessionId: "face-image-session",
      requestId: 1,
      facesReadObjectArray: [{ squareImageAsRgbaArray: responseImage }],
    };
    const handler = new ScannerWorkerSessionHandler({
      port,
      createProcessor: () => ({ delete: jest.fn() }),
      isProcessRequest: isProcessFrameRequestForTest,
      processFrame: () => response,
      cleanupProcessRequest: wipeScannerRgbaRequest,
      cleanupProcessResponse: wipeScannerFaceImageResponse,
    });
    port.emit({
      action: "processRGBAImageFrame",
      sessionId: "face-image-session",
      requestId: 1,
      width: 1,
      height: 1,
      rgbImageAsArrayBuffer: requestBytes.buffer,
    });

    expect([...requestBytes]).toEqual([0, 0, 0, 0]);
    expect([...responseImage]).toEqual([0, 0, 0, 0]);
    expect(response.facesReadObjectArray[0]!.squareImageAsRgbaArray).toBeUndefined();
    const postedResponse = port.posted[1] as typeof response;
    expect([...postedResponse.facesReadObjectArray[0]!.squareImageAsRgbaArray!])
      .toEqual([10, 11, 12, 13]);
    handler.dispose();
  });

  test("worker cleanup without terminateSession deletes native state once", () => {
    const port = new FakeWorkerSessionPort();
    const processor = { delete: jest.fn() };
    const handler = new ScannerWorkerSessionHandler({
      port,
      createProcessor: () => processor,
      isProcessRequest: isProcessFrameRequestForTest,
      processFrame: (request: ProcessFrameRequest) => frameResponse(request),
    });
    port.emit({
      action: "processRGBAImageFrame",
      sessionId: "cleanup-session",
      requestId: 1,
      width: 1,
      height: 1,
      rgbImageAsArrayBuffer: new ArrayBuffer(4),
    });

    handler.dispose();
    handler.dispose();

    expect(processor.delete).toHaveBeenCalledTimes(1);
    expect(port.removeEventListener).toHaveBeenCalledTimes(1);
    expect(port.close).toHaveBeenCalledTimes(1);
    expect(port.posted).not.toContainEqual(expect.objectContaining({
      action: "sessionTerminated",
    }));
  });
});

describe("camera acquisition lifecycle", () => {
  const originalMediaDevicesDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "mediaDevices",
  );
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const originalActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    if (originalMediaDevicesDescriptor == null) {
      Reflect.deleteProperty(navigator, "mediaDevices");
    } else {
      Object.defineProperty(
        navigator,
        "mediaDevices",
        originalMediaDevicesDescriptor,
      );
    }
  });

  afterAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });

  const installGetUserMedia = (getUserMedia: jest.Mock): void => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
  };

  test("camera selection remains presentation-only during render and commit", async () => {
    const camera = fakeCamera("default-camera");
    const mediaStreamState = {
      deviceId: undefined,
      defaultDevice: camera,
      activate: jest.fn(),
      setCamera: jest.fn(() => Promise.resolve()),
      setDeviceId: jest.fn(() => Promise.resolve()),
    } as unknown as MediaStreamState;
    const cameraSelection = React.createElement(CameraSelectionView, {
      cameras: [camera],
      mediaStreamState,
    });
    const ThrowDuringRender = (): React.ReactElement => {
      throw new Error("render abandoned");
    };

    expect(() => renderToString(React.createElement(
      React.Fragment,
      null,
      cameraSelection,
      React.createElement(ThrowDuringRender),
    ))).toThrow("render abandoned");
    expect(mediaStreamState.activate).not.toHaveBeenCalled();
    expect(mediaStreamState.setCamera).not.toHaveBeenCalled();

    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(cameraSelection);
      await Promise.resolve();
    });
    expect(mediaStreamState.activate).not.toHaveBeenCalled();
    expect(mediaStreamState.setCamera).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  test("production scanner defers camera discovery until a committed mount", async () => {
    const cameras = Object.assign(fakeCamerasOnThisDevice([]), {
      ready: true,
      readyAndNonEmpty: false,
    });
    const instanceSpy = jest.spyOn(CamerasOnThisDevice, "instance")
      .mockReturnValue(cameras);
    const scanner = React.createElement(ScanDiceKeyView, {
      height: "100%",
      scanMode: "wallet-recovery",
      onWalletRecoveryScan: jest.fn(),
    });
    const ThrowDuringRender = (): React.ReactElement => {
      throw new Error("production render abandoned");
    };

    expect(() => renderToString(React.createElement(
      React.Fragment,
      null,
      scanner,
      React.createElement(ThrowDuringRender),
    ))).toThrow("production render abandoned");
    expect(instanceSpy).not.toHaveBeenCalled();

    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(scanner);
      await Promise.resolve();
    });
    expect(instanceSpy).toHaveBeenCalledTimes(1);
    expect(instanceSpy).toHaveBeenCalledWith(1024, 720);

    await act(async () => root.unmount());
    instanceSpy.mockRestore();
  });

  test("unmount-before-resolution stops every late track and blocks uncommitted reuse", async () => {
    const camera = fakeCamera("late-camera");
    const cameras = fakeCamerasOnThisDevice([camera]);
    const mediaRequest = deferred<MediaStream>();
    const getUserMedia = jest.fn(() => mediaRequest.promise);
    installGetUserMedia(getUserMedia);
    const state = new MediaStreamState(cameras, {});
    const acquisition = state.setCamera(camera);

    state.dispose();
    const lateStream = fakeMediaStream();
    mediaRequest.resolve(lateStream.mediaStream);
    await acquisition;

    expect(lateStream.videoTrack.stop).toHaveBeenCalledTimes(1);
    expect(lateStream.audioTrack.stop).toHaveBeenCalledTimes(1);
    expect(lateStream.stop).toHaveBeenCalledTimes(1);
    expect(state.mediaStream).toBeUndefined();
    expect(state.deviceId).toBeUndefined();

    await state.setCamera(camera);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  test("concurrent selection installs only the latest stream and stops the superseded one", async () => {
    const firstCamera = fakeCamera("first-camera");
    const secondCamera = fakeCamera("second-camera");
    const cameras = fakeCamerasOnThisDevice([firstCamera, secondCamera]);
    const firstRequest = deferred<MediaStream>();
    const secondRequest = deferred<MediaStream>();
    const getUserMedia = jest.fn()
      .mockImplementationOnce(() => firstRequest.promise)
      .mockImplementationOnce(() => secondRequest.promise);
    installGetUserMedia(getUserMedia);
    const state = new MediaStreamState(cameras, {});
    const firstAcquisition = state.setCamera(firstCamera);
    const secondAcquisition = state.setCamera(secondCamera);
    const firstStream = fakeMediaStream();
    const secondStream = fakeMediaStream();

    secondRequest.resolve(secondStream.mediaStream);
    await secondAcquisition;
    expect(state.deviceId).toBe("second-camera");
    expect(state.mediaStream).toBe(secondStream.mediaStream);

    firstRequest.resolve(firstStream.mediaStream);
    await firstAcquisition;
    expect(firstStream.videoTrack.stop).toHaveBeenCalledTimes(1);
    expect(firstStream.audioTrack.stop).toHaveBeenCalledTimes(1);
    expect(firstStream.stop).toHaveBeenCalledTimes(1);
    expect(secondStream.videoTrack.stop).not.toHaveBeenCalled();
    expect(secondStream.audioTrack.stop).not.toHaveBeenCalled();
    expect(state.mediaStream).toBe(secondStream.mediaStream);

    state.dispose();
    expect(secondStream.videoTrack.stop).toHaveBeenCalledTimes(1);
    expect(secondStream.audioTrack.stop).toHaveBeenCalledTimes(1);
    expect(secondStream.stop).toHaveBeenCalledTimes(1);
  });

  test("normal legacy selection installs and clear releases all tracks", async () => {
    const camera = fakeCamera("legacy-camera", {
      focusDistance: { min: 1, max: 10, step: 1 },
      focusMode: ["manual"],
    } as MediaTrackCapabilities);
    const cameras = fakeCamerasOnThisDevice([camera]);
    const stream = fakeMediaStream();
    const getUserMedia = jest.fn(() => Promise.resolve(stream.mediaStream));
    installGetUserMedia(getUserMedia);
    const state = new MediaStreamState(cameras, { width: { ideal: 1024 } });

    await state.setDeviceId(camera.deviceId);
    expect(state.deviceId).toBe(camera.deviceId);
    expect(state.mediaStream).toBe(stream.mediaStream);
    expect(state.supportsFixedFocus).toBe(true);
    expect(stream.videoTrack.stop).not.toHaveBeenCalled();
    expect(stream.audioTrack.stop).not.toHaveBeenCalled();

    state.clear();
    expect(stream.videoTrack.stop).toHaveBeenCalledTimes(1);
    expect(stream.audioTrack.stop).toHaveBeenCalledTimes(1);
    expect(stream.stop).toHaveBeenCalledTimes(1);
    expect(state.mediaStream).toBeUndefined();
  });
});

describe("mode-keyed processor attempts", () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const originalActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });

  test("legacy-to-wallet rerender disposes legacy callbacks before wallet processing", async () => {
    const storeCall = DiceKeyMemoryStore.addCenterFaceOrientationWhenScanned as jest.Mock;
    storeCall.mockClear();
    const legacyCallback = jest.fn();
    const walletCallback = jest.fn();
    const states: DiceKeyFrameProcessorState[] = [];

    const ProcessorAttempt = ({ mode }: { mode: DiceKeyScannerMode }) => {
      const [state] = React.useState(() => new DiceKeyFrameProcessorState({
        scanMode: mode,
        onDiceKeyRead: legacyCallback,
        onWalletRecoveryScan: walletCallback,
      }));
      React.useEffect(() => {
        states.push(state);
        return () => state.dispose();
      }, [state]);
      return null;
    };
    const ModeHarness = ({ mode }: { mode: DiceKeyScannerMode }) =>
      React.createElement(ProcessorAttempt, {
        key: scannerAttemptKeyForMode(mode),
        mode,
      });
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(ModeHarness, { mode: "legacy" }));
    });
    await act(async () => {
      root.render(React.createElement(ModeHarness, { mode: "wallet-recovery" }));
    });
    expect(states).toHaveLength(2);
    expect(states[0]).not.toBe(states[1]);

    expect(processFacesRead(states[0]!, scannerFaces())).toBe(false);
    expect(legacyCallback).not.toHaveBeenCalled();
    expect(storeCall).not.toHaveBeenCalled();

    expect(processFacesRead(states[1]!, scannerFaces())).toBe(true);
    expect(walletCallback).toHaveBeenCalledWith(expect.objectContaining({
      status: "exact",
    }));
    expect(legacyCallback).not.toHaveBeenCalled();
    expect(storeCall).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  test("React StrictMode cleanup replay reactivates the committed processor", async () => {
    const walletCallback = jest.fn();
    let committedState: DiceKeyFrameProcessorState | undefined;
    const ProcessorAttempt = (): null => {
      const [state] = React.useState(() => new DiceKeyFrameProcessorState({
        scanMode: "wallet-recovery",
        onWalletRecoveryScan: walletCallback,
      }));
      React.useEffect(() => {
        state.activate({ onWalletRecoveryScan: walletCallback });
        committedState = state;
        return () => state.dispose();
      }, [state]);
      return null;
    };
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(
        React.StrictMode,
        null,
        React.createElement(ProcessorAttempt),
      ));
    });
    if (committedState == null) throw new Error("expected committed processor");
    expect(processFacesRead(committedState, scannerFaces())).toBe(true);
    expect(walletCallback).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    expect(processFacesRead(committedState, scannerFaces())).toBe(false);
  });
});

describe("camera and frame-grabber lifecycle", () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalDomRectReadOnly = globalThis.DOMRectReadOnly;
  let getContextSpy: jest.SpyInstance;

  beforeAll(() => {
    if (globalThis.DOMRectReadOnly == null) {
      Object.defineProperty(globalThis, "DOMRectReadOnly", {
        configurable: true,
        value: class DOMRectReadOnly {},
      });
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: class ResizeObserver {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    });
    getContextSpy = jest.spyOn(
      HTMLCanvasElement.prototype,
      "getContext",
    ).mockImplementation(() => ({
      drawImage: jest.fn(),
      getImageData: jest.fn(() => testImageData()),
      clearRect: jest.fn(),
    }) as unknown as CanvasRenderingContext2D);
  });

  afterAll(() => {
    getContextSpy.mockRestore();
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: originalResizeObserver,
    });
    Object.defineProperty(globalThis, "DOMRectReadOnly", {
      configurable: true,
      value: originalDomRectReadOnly,
    });
  });

  test("render/rerender never creates a grabber and terminal disposal detaches it synchronously", () => {
    const track = { getSettings: () => ({ aspectRatio: 1 }) } as MediaStreamTrack;
    const mediaStream = { getTracks: () => [track] } as unknown as MediaStream;
    const mediaStreamState = {
      mediaStream,
      supportsFixedFocus: false,
    } as MediaStreamState;
    let registeredDisposer: (() => void) | undefined;
    const registerSynchronousCaptureDisposer = jest.fn(
      (dispose: (() => void) | undefined) => {
        registeredDisposer = dispose;
      },
    );
    const component = new CameraCaptureWithOverlayComponent({
      mediaStreamState,
      registerSynchronousCaptureDisposer,
    });
    const disposable = { dispose: jest.fn() };
    const createFromTrack = jest.fn(() => disposable);
    const createFromVideo = jest.fn(() => disposable);
    Object.assign(component, {
      createImageCaptureFrameGrabber: createFromTrack,
      createVideoElementFrameGrabber: createFromVideo,
    });

    component.render();
    component.render();
    expect(createFromTrack).not.toHaveBeenCalled();
    expect(createFromVideo).not.toHaveBeenCalled();

    const video = document.createElement("video");
    (component as unknown as {
      withVideoElementRef: (element: HTMLVideoElement) => void;
    }).withVideoElementRef(video);
    expect(createFromTrack).not.toHaveBeenCalled();
    expect(createFromVideo).not.toHaveBeenCalled();

    component.componentDidMount();
    component.componentDidUpdate();
    component.componentDidUpdate();
    expect(createFromTrack.mock.calls.length + createFromVideo.mock.calls.length).toBe(1);
    expect(registeredDisposer).toEqual(expect.any(Function));

    registeredDisposer!();
    expect(disposable.dispose).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
    component.componentDidUpdate();
    expect(createFromTrack.mock.calls.length + createFromVideo.mock.calls.length).toBe(1);

    component.componentWillUnmount();
    expect(disposable.dispose).toHaveBeenCalledTimes(1);
    expect(registeredDisposer).toBeUndefined();
    component.componentWillUnmount();
    expect(disposable.dispose).toHaveBeenCalledTimes(1);
  });

  test("video grabber disposal clears its pending frame loop", () => {
    jest.useFakeTimers();
    const video = document.createElement("video");
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 0 },
      videoHeight: { configurable: true, value: 0 },
    });
    const callback = jest.fn();
    const grabber = new FrameGrabberFromVideoElement(video, callback);
    const grabberInternals = grabber as unknown as {
      captureCanvas?: HTMLCanvasElement;
      captureCanvasCtx?: CanvasRenderingContext2D;
    };
    const captureCanvas = grabberInternals.captureCanvas!;
    const captureCanvasCtx = grabberInternals.captureCanvasCtx!;
    const originalCanvasSize = {
      width: captureCanvas.width,
      height: captureCanvas.height,
    };
    expect(jest.getTimerCount()).toBe(1);

    grabber.dispose();
    grabber.dispose();
    jest.runOnlyPendingTimers();
    expect(callback).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expect(captureCanvasCtx.clearRect).toHaveBeenCalledTimes(1);
    expect(captureCanvasCtx.clearRect).toHaveBeenCalledWith(
      0,
      0,
      originalCanvasSize.width,
      originalCanvasSize.height,
    );
    expect({ width: captureCanvas.width, height: captureCanvas.height }).toEqual({
      width: 0,
      height: 0,
    });
    expect(grabberInternals.captureCanvas).toBeUndefined();
    expect(grabberInternals.captureCanvasCtx).toBeUndefined();
    jest.useRealTimers();
  });

  test("video grabber disposal wipes RGBA data while a callback is still pending", () => {
    jest.useFakeTimers();
    const video = document.createElement("video");
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1 },
      videoHeight: { configurable: true, value: 1 },
    });
    let capturedFrame: ImageData | undefined;
    const callback = jest.fn((frame: ImageData) => {
      capturedFrame = frame;
      return new Promise<void>(() => {});
    });
    const grabber = new FrameGrabberFromVideoElement(video, callback);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(capturedFrame).toBeDefined();
    expect([...capturedFrame!.data]).toEqual([1, 2, 3, 4]);
    grabber.dispose();
    expect([...capturedFrame!.data]).toEqual([0, 0, 0, 0]);
    jest.runOnlyPendingTimers();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  test("image-capture grabber wipes captured RGBA data after callback rejection", async () => {
    jest.useFakeTimers();
    const imageCaptureGlobal = globalThis as typeof globalThis & {
      ImageCapture?: typeof ImageCapture;
    };
    const originalImageCapture = imageCaptureGlobal.ImageCapture;
    const close = jest.fn();
    class FakeImageCapture {
      constructor(readonly track: MediaStreamTrack) {}
      grabFrame = jest.fn(async () => ({
        width: 1,
        height: 1,
        close,
      } as ImageBitmap));
    }
    Object.defineProperty(globalThis, "ImageCapture", {
      configurable: true,
      value: FakeImageCapture,
    });
    const track = {
      readyState: "live",
      enabled: true,
      muted: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    } as unknown as MediaStreamTrack;
    let capturedFrame: ImageData | undefined;
    const callback = jest.fn((frame: ImageData) => {
      capturedFrame = frame;
      return Promise.reject(new Error("consumer rejected frame"));
    });
    const grabber = new FrameGrabberUsingImageCapture(track, callback);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(capturedFrame).toBeDefined();
    expect([...capturedFrame!.data]).toEqual([0, 0, 0, 0]);
    expect(close).toHaveBeenCalledTimes(1);
    grabber.dispose();
    jest.runOnlyPendingTimers();
    expect(jest.getTimerCount()).toBe(0);

    Object.defineProperty(globalThis, "ImageCapture", {
      configurable: true,
      value: originalImageCapture,
    });
    jest.useRealTimers();
  });

  test("image-capture disposal wipes a frame created before the outer await resumes", async () => {
    let resolveFrame!: (bitmap: ImageBitmap) => void;
    const close = jest.fn();
    const imageCaptureGlobal = globalThis as typeof globalThis & {
      ImageCapture?: typeof ImageCapture;
    };
    const originalImageCapture = imageCaptureGlobal.ImageCapture;
    class FakeImageCapture {
      constructor(readonly track: MediaStreamTrack) {}
      grabFrame = jest.fn(() => new Promise<ImageBitmap>((resolve) => {
        resolveFrame = resolve;
      }));
    }
    Object.defineProperty(globalThis, "ImageCapture", {
      configurable: true,
      value: FakeImageCapture,
    });
    const track = {
      readyState: "live",
      enabled: true,
      muted: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    } as unknown as MediaStreamTrack;
    const callback = jest.fn();
    const grabber = new FrameGrabberUsingImageCapture(track, callback);
    const grabberInternals = grabber as unknown as {
      captureCanvas: HTMLCanvasElement;
      captureCanvasCtx: CanvasRenderingContext2D;
    };
    const frame = testImageData();
    (grabberInternals.captureCanvasCtx.getImageData as jest.Mock)
      .mockReturnValue(frame);

    resolveFrame({
      width: grabberInternals.captureCanvas.width,
      height: grabberInternals.captureCanvas.height,
      close,
    } as ImageBitmap);
    queueMicrotask(() => grabber.dispose());
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(callback).not.toHaveBeenCalled();
    expect([...frame.data]).toEqual([0, 0, 0, 0]);
    expect(close).toHaveBeenCalledTimes(1);

    Object.defineProperty(globalThis, "ImageCapture", {
      configurable: true,
      value: originalImageCapture,
    });
  });

  test("image-capture disposal suppresses a late media callback", async () => {
    let resolveFrame!: (bitmap: ImageBitmap) => void;
    const close = jest.fn();
    const imageCaptureGlobal = globalThis as typeof globalThis & {
      ImageCapture?: typeof ImageCapture;
    };
    const originalImageCapture = imageCaptureGlobal.ImageCapture;
    class FakeImageCapture {
      constructor(readonly track: MediaStreamTrack) {}
      grabFrame = jest.fn(() => new Promise<ImageBitmap>((resolve) => {
        resolveFrame = resolve;
      }));
    }
    Object.defineProperty(globalThis, "ImageCapture", {
      configurable: true,
      value: FakeImageCapture,
    });
    const track = {
      readyState: "live",
      enabled: true,
      muted: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    } as unknown as MediaStreamTrack;
    const callback = jest.fn();
    const grabber = new FrameGrabberUsingImageCapture(track, callback);
    const grabberInternals = grabber as unknown as {
      captureCanvas?: HTMLCanvasElement;
      captureCanvasCtx?: CanvasRenderingContext2D;
    };
    const captureCanvas = grabberInternals.captureCanvas!;
    const captureCanvasCtx = grabberInternals.captureCanvasCtx!;
    const originalCanvasSize = {
      width: captureCanvas.width,
      height: captureCanvas.height,
    };

    grabber.dispose();
    resolveFrame({ width: 1, height: 1, close } as ImageBitmap);
    await Promise.resolve();
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(captureCanvasCtx.clearRect).toHaveBeenCalledTimes(1);
    expect(captureCanvasCtx.clearRect).toHaveBeenCalledWith(
      0,
      0,
      originalCanvasSize.width,
      originalCanvasSize.height,
    );
    expect({ width: captureCanvas.width, height: captureCanvas.height }).toEqual({
      width: 0,
      height: 0,
    });
    expect(grabberInternals.captureCanvas).toBeUndefined();
    expect(grabberInternals.captureCanvasCtx).toBeUndefined();

    Object.defineProperty(globalThis, "ImageCapture", {
      configurable: true,
      value: originalImageCapture,
    });
  });
});
