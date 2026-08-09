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
import { ServerStyleSheet } from "styled-components";
import { FaceRead } from "@dicekeys/read-dicekey-js";
import { DiceKeyWithoutKeyId } from "../../dicekeys/DiceKey";
import { DiceKeyMemoryStore } from "../../state/stores/DiceKeyMemoryStore";
import { WalletRecoveryFlow } from "../WalletRecovery/foundation";
import { ScannerFrame } from "../WalletRecovery/WalletRecoveryStyles";
import type {
  ProcessFrameRequest,
  ProcessFrameResponse,
  TerminateSessionRequest,
} from "../../workers/dicekey-image-frame-worker";
import {
  CameraCaptureWithOverlayComponent,
  type CameraCaptureWithOverlayProperties,
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
import {
  CAMERA_REQUEST_TIMEOUT_MS,
  CamerasOnThisDevice,
  videoConstraintsForDevice,
  type Camera,
  type CameraDiscoveryStatus,
} from "./CamerasOnThisDevice";
import {
  beginScannerAttemptDisposal,
  deliverWalletRecoveryScannerResult,
  mountScannerAttemptWithCleanup,
  processCapturedFrameForScannerAttempt,
  ScanDiceKeyView,
  WALLET_RECOVERY_FIRST_FRAME_TIMEOUT_MS,
  WALLET_RECOVERY_NEXT_FRAME_TIMEOUT_MS,
  type ScanDiceKeyViewProps,
} from "./ScanDiceKeyView";
import {
  evaluateWalletRecoveryScannerRead,
  type WalletRecoveryScanResult,
} from "./wallet-recovery-scanner-policy";
import { ScannerAttemptLifecycle } from "./wallet-recovery-scanner-attempt-lifecycle";
import { ScannerOwnedFrameBuffer } from "./wallet-recovery-scanner-frame-buffer";
import {
  createWalletRecoveryScannerAcquisitionHandle,
  createWalletRecoveryScannerAttemptFailure,
  scannerResultForAcquisition,
  scannerCandidateToSanitizedAcquisition,
  type WalletRecoveryScannerAcquisitionHandle,
  type WalletRecoveryScannerResult,
  type WalletRecoveryScannerTerminal,
} from "./wallet-recovery-scanner-acquisition";
import {
  DiceKeyFrameWorkerClient,
  ScannerWorkerCleanupUnconfirmedError,
  ScannerWorkerLike,
  WALLET_RECOVERY_FRAME_RESPONSE_TIMEOUT_MS,
  WALLET_RECOVERY_WORKER_READY_TIMEOUT_MS,
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
  status: cameras.length > 0 ? "ready" : "no-camera",
  ready: true,
  readyAndNonEmpty: cameras.length > 0,
  dispose: jest.fn(),
} as unknown as CamerasOnThisDevice);

const fakeMediaStream = (deviceId = "camera") => {
  const streamListeners = new Map<string, Set<EventListener>>();
  const trackListeners = new Map<string, Set<EventListener>>();
  const addListener = (
    listeners: Map<string, Set<EventListener>>,
    type: string,
    listener: EventListener,
  ): void => {
    const listenersForType = listeners.get(type) ?? new Set<EventListener>();
    listenersForType.add(listener);
    listeners.set(type, listenersForType);
  };
  const removeListener = (
    listeners: Map<string, Set<EventListener>>,
    type: string,
    listener: EventListener,
  ): void => {
    listeners.get(type)?.delete(listener);
  };
  const videoTrack = {
    stop: jest.fn(),
    getSettings: jest.fn(() => ({ deviceId, aspectRatio: 1 })),
    addEventListener: jest.fn((type: string, listener: EventListener) =>
      addListener(trackListeners, type, listener)),
    removeEventListener: jest.fn((type: string, listener: EventListener) =>
      removeListener(trackListeners, type, listener)),
  } as unknown as MediaStreamTrack;
  const audioTrack = { stop: jest.fn() } as unknown as MediaStreamTrack;
  const stop = jest.fn();
  const mediaStream = {
    getTracks: () => [videoTrack, audioTrack],
    getVideoTracks: () => [videoTrack],
    addEventListener: jest.fn((type: string, listener: EventListener) =>
      addListener(streamListeners, type, listener)),
    removeEventListener: jest.fn((type: string, listener: EventListener) =>
      removeListener(streamListeners, type, listener)),
    stop,
  } as unknown as MediaStream;
  return {
    mediaStream,
    videoTrack,
    audioTrack,
    stop,
    emitInactive: () => streamListeners.get("inactive")?.forEach((listener) =>
      listener(new Event("inactive"))),
    emitEnded: () => trackListeners.get("ended")?.forEach((listener) =>
      listener(new Event("ended"))),
  };
};

const fakeDiscoveryMediaStream = ({
  deviceId = "late-discovery-camera",
  settings = { width: 1280, height: 720, facingMode: "environment" },
  capabilities,
}: {
  deviceId?: string;
  settings?: MediaTrackSettings;
  capabilities?: MediaTrackCapabilities;
} = {}) => {
  const videoTrack = {
    stop: jest.fn(),
    getSettings: jest.fn(() => ({ deviceId, ...settings })),
    getCapabilities: jest.fn(() => capabilities),
  } as unknown as MediaStreamTrack;
  const stop = jest.fn();
  const mediaStream = {
    getTracks: () => [videoTrack],
    getVideoTracks: () => [videoTrack],
    stop,
  } as unknown as MediaStream;
  return { mediaStream, videoTrack, stop };
};

const namedError = (name: string): Error => {
  const error = new Error(name);
  error.name = name;
  return error;
};

const createStableWalletAttemptHandleForTest = (
  scannerAttempt: ScannerAttemptLifecycle,
  frameProcessorState: DiceKeyFrameProcessorState,
  mediaStreamState: MediaStreamState,
  disposeCapture?: () => void,
): WalletRecoveryScannerAcquisitionHandle => {
  const acquisitionId = scannerAttempt.acquisitionId;
  if (acquisitionId == null) throw new Error("test scanner attempt is not mounted");
  return createWalletRecoveryScannerAcquisitionHandle(
    acquisitionId,
    () => beginScannerAttemptDisposal(
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
    ),
  );
};

describe("wallet recovery scanner policy", () => {
  test("correlates and freezes every policy outcome to one acquisition id", () => {
    const reviewFaces = scannerFaces();
    reviewFaces[0]!.errors = [{ type: "undoverline-missing" }];
    const outcomes = [
      evaluateWalletRecoveryScannerRead(scannerFaces()),
      evaluateWalletRecoveryScannerRead(reviewFaces),
      evaluateWalletRecoveryScannerRead([]),
    ];

    outcomes.forEach((outcome) => {
      const correlated = scannerResultForAcquisition(
        outcome,
        "correlated-attempt",
      );
      expect(correlated.acquisitionId).toBe("correlated-attempt");
      expect(Object.isFrozen(correlated)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(correlated, "acquisitionId"))
        .toEqual(expect.objectContaining({
          value: "correlated-attempt",
          enumerable: true,
        }));
    });
    const failure = createWalletRecoveryScannerAttemptFailure(
      "correlated-attempt",
    );
    expect(failure.acquisitionId).toBe("correlated-attempt");
    expect(Object.isFrozen(failure)).toBe(true);
  });

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
  afterEach(() => {
    jest.useRealTimers();
  });

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
    const walletAttemptHandle = createStableWalletAttemptHandleForTest(
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
    );
    const cleanupFailure = expect(walletAttemptHandle.cleanupSettlement)
      .rejects.toThrow("terminal cleanup failed");

    await processCapturedFrameForScannerAttempt({
      framesImageData: testImageData(),
      canvasRenderingContext: {} as CanvasRenderingContext2D,
      scanMode: "wallet-recovery",
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
      onWalletAttemptCompleted,
      walletAttemptHandle,
    });

    expect(onWalletAttemptCompleted).toHaveBeenCalledTimes(1);
    expect(disposeCapture).toHaveBeenCalledTimes(1);
    expect(frameProcessorState.dispose).toHaveBeenCalledTimes(1);
    expect(mediaStreamState.dispose).toHaveBeenCalledTimes(1);
    expect(scannerAttempt.unmount).toHaveBeenCalledTimes(1);
    await cleanupFailure;
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
    const failureHandle = createStableWalletAttemptHandleForTest(
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
    );

    const processing = processCapturedFrameForScannerAttempt({
      framesImageData: frame,
      canvasRenderingContext: {} as CanvasRenderingContext2D,
      scanMode: "wallet-recovery",
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
      onWalletAttemptCompleted,
      walletAttemptHandle: failureHandle,
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
        expect(terminal).toBe(failureHandle);
        expect(flow.receiveAcquisitionFailure(expectedEpoch, terminal)).toBe(true);
      },
    });
    worker.emit({
      action: "workerInitializationFailed",
      message: "sensitive bootstrap detail",
    });
    await processing;

    expect(deliveredResult).toEqual(
      createWalletRecoveryScannerAttemptFailure("bootstrap-failure-session"),
    );
    expect(Object.keys(deliveredResult!).sort()).toEqual([
      "acquisitionId",
      "reason",
      "status",
    ]);
    expect(JSON.stringify(deliveredResult)).not.toContain("sensitive");
    expect(Object.isFrozen(deliveredResult)).toBe(true);
    expect(failureHandle.acquisitionId).toBe("bootstrap-failure-session");
    expect(Object.keys(failureHandle).sort()).toEqual([
      "acquisitionId",
      "cleanupSettlement",
      "dispose",
    ]);
    expect([...frame.data]).toEqual([0, 0, 0, 0]);
    expect(frameProcessorState.handleProcessedCameraFrame).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(failureHandle.cleanupSettlement).resolves.toBeUndefined();
    expect(flow.state).toEqual(expect.objectContaining({
      kind: "failed",
      code: "ACQUISITION_FAILED",
    }));
  });

  test("hung wallet frame emits one fixed failure and waits for cleanup ACK", async () => {
    jest.useFakeTimers();
    const worker = new FakeWorker();
    let senderCopy: ArrayBuffer | undefined;
    const client = new DiceKeyFrameWorkerClient({
      createWorker: () => worker,
      createSessionId: () => "hung-frame-session",
      frameResponseTimeoutMs: WALLET_RECOVERY_FRAME_RESPONSE_TIMEOUT_MS,
      cleanupTimeoutMs: 50,
      createFrameBuffer: (source) => {
        const owned = new ScannerOwnedFrameBuffer(source);
        senderCopy = owned.arrayBuffer;
        return owned;
      },
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
    const onWalletRecoveryScan = jest.fn((
      result: WalletRecoveryScannerResult,
      terminal?: WalletRecoveryScannerTerminal,
    ) => {
      expect(result).toEqual(
        createWalletRecoveryScannerAttemptFailure("hung-frame-session"),
      );
      expect(terminal).toBe(walletAttemptHandle);
      expect(disposeCapture).toHaveBeenCalledTimes(1);
      expect(frameProcessorState.dispose).toHaveBeenCalledTimes(1);
      expect(mediaStreamState.dispose).toHaveBeenCalledTimes(1);
      expect(onWalletAttemptCompleted).toHaveBeenCalledTimes(1);
    });
    const walletAttemptHandle = createStableWalletAttemptHandleForTest(
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
    );
    const frame = testImageData();

    const processing = processCapturedFrameForScannerAttempt({
      framesImageData: frame,
      canvasRenderingContext: {} as CanvasRenderingContext2D,
      scanMode: "wallet-recovery",
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
      onWalletAttemptCompleted,
      walletAttemptHandle,
      onWalletRecoveryScan,
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
    expect([...frame.data]).toEqual([0, 0, 0, 0]);
    expect(senderCopy?.byteLength).toBe(0);

    await jest.advanceTimersByTimeAsync(
      WALLET_RECOVERY_FRAME_RESPONSE_TIMEOUT_MS,
    );
    await processing;

    expect(onWalletRecoveryScan).toHaveBeenCalledTimes(1);
    expect(frameProcessorState.handleProcessedCameraFrame).not.toHaveBeenCalled();
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
    void walletAttemptHandle.cleanupSettlement.then(() => {
      cleanupSettled = true;
    });
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);

    const lateResponseImage = new Uint8ClampedArray([8, 7, 6, 5]);
    const lateResponse = frameResponseWithFaceImage(
      processRequest!,
      lateResponseImage,
    );
    worker.emit(lateResponse.response);
    expect([...lateResponseImage]).toEqual([0, 0, 0, 0]);
    expect(lateResponse.faceObject.squareImageAsRgbaArray).toBeUndefined();

    wipeScannerRgbaRequest(processRequest!);
    worker.emit({
      action: "sessionTerminated",
      sessionId: terminationRequest!.sessionId,
      requestId: terminationRequest!.requestId,
    });
    await expect(walletAttemptHandle.cleanupSettlement).resolves.toBeUndefined();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect([...new Uint8Array(processRequest!.rgbImageAsArrayBuffer)])
      .toEqual([0, 0, 0, 0]);
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
    const failureHandle = createStableWalletAttemptHandleForTest(
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
    );
    const processing = processCapturedFrameForScannerAttempt({
      framesImageData: testImageData(),
      canvasRenderingContext: {} as CanvasRenderingContext2D,
      scanMode: "wallet-recovery",
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
      onWalletAttemptCompleted,
      walletAttemptHandle: failureHandle,
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

    expect(deliveredResult).toEqual(
      createWalletRecoveryScannerAttemptFailure("wasm-exception-session"),
    );
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
    await expect(failureHandle.cleanupSettlement).resolves.toBeUndefined();
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
    const failureHandle = createStableWalletAttemptHandleForTest(
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
    );

    const processing = processCapturedFrameForScannerAttempt({
      framesImageData: testImageData(),
      canvasRenderingContext: {} as CanvasRenderingContext2D,
      scanMode: "wallet-recovery",
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
      onWalletAttemptCompleted,
      walletAttemptHandle: failureHandle,
      onWalletRecoveryScan: (result, terminal) => {
        deliveredResult = result;
        expect(terminal).toBe(failureHandle);
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

    expect(deliveredResult).toEqual(
      createWalletRecoveryScannerAttemptFailure("active-failure-session"),
    );
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
    void failureHandle.cleanupSettlement.then(() => {
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
    await expect(failureHandle.cleanupSettlement).resolves.toBeUndefined();
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
    const walletAttemptHandle = createStableWalletAttemptHandleForTest(
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
    );
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
      walletAttemptHandle,
    });

    walletAttemptHandle.dispose();
    await walletAttemptHandle.cleanupSettlement;
    frameResult.reject(new Error("late stale rejection"));
    await processing;

    expect(client.dispose).toHaveBeenCalledTimes(1);
    expect(disposeCapture).toHaveBeenCalledTimes(1);
    expect(frameProcessorState.dispose).toHaveBeenCalledTimes(1);
    expect(mediaStreamState.dispose).toHaveBeenCalledTimes(1);
    expect(onWalletAttemptCompleted).not.toHaveBeenCalled();
    expect(onWalletRecoveryScan).not.toHaveBeenCalled();
  });

  test.each(["wallet-recovery", "legacy"] as const)(
    "late resolved response cannot cross an unmount/remount boundary in %s mode",
    async (scanMode) => {
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
    const walletAttemptHandle = scanMode === "wallet-recovery"
      ? createStableWalletAttemptHandleForTest(
        scannerAttempt,
        frameProcessorState,
        mediaStreamState,
        disposeCapture,
      )
      : undefined;
    const responseImage = new Uint8ClampedArray([5, 6, 7, 8]);
    const faceObject = { squareImageAsRgbaArray: responseImage };
    const processing = processCapturedFrameForScannerAttempt({
      framesImageData: testImageData(),
      canvasRenderingContext: {} as CanvasRenderingContext2D,
      scanMode,
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
      onWalletAttemptCompleted,
      onWalletRecoveryScan,
      walletAttemptHandle,
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
    walletAttemptHandle?.dispose();
    const oldCleanup = walletAttemptHandle?.cleanupSettlement ??
      scannerAttempt.unmount();
    scannerAttempt.mount();
    await oldCleanup;
    await processing;

    expect(scannerAttempt.acquisitionId).toBe("resolved-new-session");
    expect(frameProcessorState.handleProcessedCameraFrame).not.toHaveBeenCalled();
    expect(onWalletRecoveryScan).not.toHaveBeenCalled();
    expect(onWalletAttemptCompleted).not.toHaveBeenCalled();
    const expectedAttemptCleanupCount = scanMode === "wallet-recovery" ? 1 : 0;
    expect(disposeCapture).toHaveBeenCalledTimes(expectedAttemptCleanupCount);
    expect(frameProcessorState.dispose)
      .toHaveBeenCalledTimes(expectedAttemptCleanupCount);
    expect(mediaStreamState.dispose)
      .toHaveBeenCalledTimes(expectedAttemptCleanupCount);
    expect([...responseImage]).toEqual([0, 0, 0, 0]);
    expect(faceObject.squareImageAsRgbaArray).toBeUndefined();
    await scannerAttempt.unmount();
    expect(clients[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(clients[1]!.dispose).toHaveBeenCalledTimes(1);
    },
  );

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
      expect(acquisition.dispose).toBe(walletAttemptHandle.dispose);
      expect(acquisition.cleanupSettlement)
        .toBe(walletAttemptHandle.cleanupSettlement);
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
    const walletAttemptHandle = createStableWalletAttemptHandleForTest(
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
    );

    const handle = deliverWalletRecoveryScannerResult({
      result,
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      disposeCapture,
      walletAttemptHandle,
      onWalletAttemptCompleted,
      onWalletRecoveryScan,
    });

    expect(handle).toBeDefined();
    expect(handle!.acquisitionId).toBe("actual-worker-session-id");
    expect(handle).toBe(walletAttemptHandle);
    expect(Object.isFrozen(handle)).toBe(true);
    const deliveredResult = onWalletRecoveryScan.mock.calls[0]![0];
    expect(deliveredResult.acquisitionId).toBe("actual-worker-session-id");
    expect(Object.isFrozen(deliveredResult)).toBe(true);
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
    const walletAttemptHandle = createStableWalletAttemptHandleForTest(
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
    );

    expect(() => deliverWalletRecoveryScannerResult({
      result,
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      walletAttemptHandle,
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

  test("completion notification failure cannot bypass the registered cleanup", async () => {
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
    const walletAttemptHandle = createStableWalletAttemptHandleForTest(
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
    );

    expect(() => deliverWalletRecoveryScannerResult({
      result,
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      walletAttemptHandle,
      onWalletAttemptCompleted: () => {
        throw new Error("completion notification failed");
      },
      onWalletRecoveryScan: jest.fn(),
    })).toThrow("completion notification failed");

    expect(frameProcessorState.dispose).toHaveBeenCalledTimes(1);
    expect(mediaStreamState.dispose).toHaveBeenCalledTimes(1);
    expect(scannerAttempt.unmount).toHaveBeenCalledTimes(1);
    await expect(walletAttemptHandle.cleanupSettlement).resolves.toBeUndefined();
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
  afterEach(() => {
    jest.useRealTimers();
  });

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

  test("legacy-default client remains unbounded until ready and a frame responds", async () => {
    jest.useFakeTimers();
    const worker = new FakeWorker();
    const client = new DiceKeyFrameWorkerClient({ createWorker: () => worker });
    const pending = client.processDiceKeyImageFrame(testImageData());
    let settled = false;
    void pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await jest.advanceTimersByTimeAsync(
      WALLET_RECOVERY_WORKER_READY_TIMEOUT_MS +
        WALLET_RECOVERY_FRAME_RESPONSE_TIMEOUT_MS,
    );
    expect(settled).toBe(false);
    expect(worker.posted).toEqual([]);
    expect(worker.terminate).not.toHaveBeenCalled();

    worker.emit({ action: "workerReady" });
    await Promise.resolve();
    const request = worker.posted[0] as ProcessFrameRequest;
    worker.emit(frameResponse(request));
    await expect(pending).resolves.toMatchObject({
      sessionId: request.sessionId,
      requestId: request.requestId,
    });

    const disposal = client.dispose();
    const termination = worker.posted.at(-1) as TerminateSessionRequest;
    wipeScannerRgbaRequest(request);
    worker.emit({
      action: "sessionTerminated",
      sessionId: termination.sessionId,
      requestId: termination.requestId,
    });
    await disposal;
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
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalDomRectReadOnly = globalThis.DOMRectReadOnly;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const originalActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  let captureGetContextSpy: jest.SpyInstance;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    if (globalThis.DOMRectReadOnly == null) {
      Object.defineProperty(globalThis, "DOMRectReadOnly", {
        configurable: true,
        value: class DOMRectReadOnly {
          readonly x = 0;
          readonly y = 0;
          readonly width = 0;
          readonly height = 0;
          readonly top = 0;
          readonly right = 0;
          readonly bottom = 0;
          readonly left = 0;
          toJSON(): object { return {}; }
        },
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
    captureGetContextSpy = jest.spyOn(
      HTMLCanvasElement.prototype,
      "getContext",
    ).mockImplementation(() => ({
      drawImage: jest.fn(),
      getImageData: jest.fn(() => testImageData()),
      clearRect: jest.fn(),
    }) as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    jest.useRealTimers();
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
    captureGetContextSpy.mockRestore();
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: originalResizeObserver,
    });
    Object.defineProperty(globalThis, "DOMRectReadOnly", {
      configurable: true,
      value: originalDomRectReadOnly,
    });
  });

  const installGetUserMedia = (getUserMedia: jest.Mock): void => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
  };

  const installMediaDevices = ({
    enumerateDevices = jest.fn(async () => []),
    getUserMedia = jest.fn(),
  }: {
    enumerateDevices?: jest.Mock;
    getUserMedia?: jest.Mock;
  }) => {
    const deviceChangeListeners = new Set<EventListener>();
    const addEventListener = jest.fn((
      type: string,
      listener: EventListener,
    ) => {
      if (type === "devicechange") deviceChangeListeners.add(listener);
    });
    const removeEventListener = jest.fn((
      type: string,
      listener: EventListener,
    ) => {
      if (type === "devicechange") deviceChangeListeners.delete(listener);
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        addEventListener,
        removeEventListener,
        enumerateDevices,
        getUserMedia,
      },
    });
    return {
      addEventListener,
      removeEventListener,
      emitDeviceChange: () => deviceChangeListeners.forEach((listener) =>
        listener(new Event("devicechange"))),
      enumerateDevices,
      getUserMedia,
    };
  };

  const flushCameraPromises = async (): Promise<void> => {
    for (let turn = 0; turn < 12; turn += 1) {
      await Promise.resolve();
    }
  };

  const installRuntimeImageCapture = (
    constructorValue: unknown,
  ): (() => void) => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "ImageCapture");
    Object.defineProperty(window, "ImageCapture", {
      configurable: true,
      writable: true,
      value: constructorValue,
    });
    return () => {
      if (descriptor == null) {
        Reflect.deleteProperty(window, "ImageCapture");
      } else {
        Object.defineProperty(window, "ImageCapture", descriptor);
      }
    };
  };

  const makeTrackCaptureReady = (track: MediaStreamTrack): void => {
    Object.defineProperties(track, {
      readyState: { configurable: true, value: "live" },
      enabled: { configurable: true, value: true },
      muted: { configurable: true, value: false },
    });
  };

  test("camera selection remains presentation-only during render and commit", async () => {
    const camera = fakeCamera("default-camera");
    const alternateCamera = fakeCamera("alternate-camera");
    const mediaStreamState = {
      deviceId: undefined,
      defaultDevice: camera,
      activate: jest.fn(),
      setCamera: jest.fn(() => Promise.resolve()),
      setDeviceId: jest.fn(() => Promise.resolve()),
    } as unknown as MediaStreamState;
    const cameraSelection = React.createElement(CameraSelectionView, {
      cameras: [camera, alternateCamera],
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
    const select = container.querySelector("select");
    expect(select).not.toBeNull();
    expect(container.querySelector(`label[for="${select!.id}"]`)?.textContent)
      .toBe("Camera");
    await act(async () => root.unmount());
  });

  test("production wallet registration precedes real camera discovery and acquisition", async () => {
    const order: string[] = [];
    const camera = fakeCamera("registration-order-camera");
    const inspectionStream = fakeDiscoveryMediaStream({
      deviceId: camera.deviceId,
    });
    const selectedStream = fakeMediaStream(camera.deviceId);
    const enumerateDevices = jest.fn(async () => {
      order.push("enumerate");
      return [camera];
    });
    let mediaRequestNumber = 0;
    const getUserMedia = jest.fn(async () => {
      order.push("get-user-media");
      mediaRequestNumber += 1;
      return mediaRequestNumber === 1
        ? inspectionStream.mediaStream
        : selectedStream.mediaStream;
    });
    installMediaDevices({ enumerateDevices, getUserMedia });
    const realInstance = CamerasOnThisDevice.instance.bind(CamerasOnThisDevice);
    const instanceSpy = jest.spyOn(CamerasOnThisDevice, "instance")
      .mockImplementation((...args) => {
        order.push("instance");
        return realInstance(...args);
      });
    const workerConstructor = (jest.requireMock(
      "../../workers/dicekey-image-frame-worker?worker",
    ) as { default: jest.Mock }).default;
    const worker = new FakeWorker();
    workerConstructor.mockImplementation(() => {
      order.push("worker");
      return worker;
    });
    let attemptHandle: WalletRecoveryScannerAcquisitionHandle | undefined;
    const onWalletRecoveryAttemptStarted = jest.fn((handle) => {
      order.push("register");
      attemptHandle = handle;
      expect(instanceSpy).not.toHaveBeenCalled();
      expect(enumerateDevices).not.toHaveBeenCalled();
      expect(getUserMedia).not.toHaveBeenCalled();
      return true;
    });
    const scanner = React.createElement(ScanDiceKeyView, {
      height: "100%",
      scanMode: "wallet-recovery",
      onExit: jest.fn(),
      onWalletRecoveryAttemptStarted,
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
    expect(workerConstructor).not.toHaveBeenCalled();
    expect(onWalletRecoveryAttemptStarted).not.toHaveBeenCalled();
    expect(instanceSpy).not.toHaveBeenCalled();

    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(scanner);
      await flushCameraPromises();
    });
    expect(instanceSpy).toHaveBeenCalledTimes(1);
    expect(instanceSpy).toHaveBeenCalledWith(1024, 720);
    expect(enumerateDevices).toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalled();
    expect(order.indexOf("worker")).toBeLessThan(order.indexOf("register"));
    expect(order.indexOf("register")).toBeLessThan(order.indexOf("instance"));
    expect(order.indexOf("instance")).toBeLessThan(order.indexOf("enumerate"));
    expect(order.indexOf("enumerate")).toBeLessThan(
      order.indexOf("get-user-media"),
    );

    await act(async () => root.unmount());
    await expect(attemptHandle!.cleanupSettlement).resolves.toBeUndefined();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    workerConstructor.mockReset();
    instanceSpy.mockRestore();
  });

  test.each(["false", "throw"] as const)(
    "wallet attempt registration %s inerts once before camera acquisition",
    async (rejectionKind) => {
      jest.useFakeTimers();
      const instanceSpy = jest.spyOn(CamerasOnThisDevice, "instance");
      const workerConstructor = (jest.requireMock(
        "../../workers/dicekey-image-frame-worker?worker",
      ) as { default: jest.Mock }).default;
      const worker = new FakeWorker();
      workerConstructor.mockImplementation(() => worker);
      const mediaDevices = installMediaDevices({
        enumerateDevices: jest.fn(async () => []),
        getUserMedia: jest.fn(),
      });
      const onWalletRecoveryScan = jest.fn();
      let rejectedHandle: WalletRecoveryScannerAcquisitionHandle | undefined;
      const cleanupErrors: unknown[] = [];
      const onWalletRecoveryAttemptStarted = jest.fn((
        handle: WalletRecoveryScannerAcquisitionHandle,
      ): boolean => {
        rejectedHandle = handle;
        void handle.cleanupSettlement.catch((error: unknown) => {
          cleanupErrors.push(error);
        });
        if (rejectionKind === "throw") {
          throw new Error("registration rejected");
        }
        return false;
      });
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(React.createElement(ScanDiceKeyView, {
            height: "100%",
            scanMode: "wallet-recovery",
            onExit: jest.fn(),
            onWalletRecoveryAttemptStarted,
            onWalletRecoveryScan,
          }));
          await flushCameraPromises();
        });

        expect(onWalletRecoveryAttemptStarted).toHaveBeenCalledTimes(1);
        expect(rejectedHandle).toBeDefined();
        expect(instanceSpy).not.toHaveBeenCalled();
        expect(mediaDevices.addEventListener).not.toHaveBeenCalled();
        expect(mediaDevices.enumerateDevices).not.toHaveBeenCalled();
        expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
        expect(onWalletRecoveryScan).not.toHaveBeenCalled();
        expect(container.querySelector("[role='status']")).toBeNull();
        expect(container.querySelector("video")).toBeNull();
        expect(worker.posted).toEqual([]);
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        await expect(rejectedHandle!.cleanupSettlement).resolves.toBeUndefined();
        expect(cleanupErrors).toEqual([]);

        await act(async () => {
          await jest.advanceTimersByTimeAsync(
            WALLET_RECOVERY_FIRST_FRAME_TIMEOUT_MS +
              WALLET_RECOVERY_NEXT_FRAME_TIMEOUT_MS,
          );
        });
        expect(onWalletRecoveryScan).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        workerConstructor.mockReset();
        instanceSpy.mockRestore();
      }
    },
  );

  test("wallet registration cannot authorize discovery after disposing its handle", async () => {
    const instanceSpy = jest.spyOn(CamerasOnThisDevice, "instance");
    const mediaDevices = installMediaDevices({
      enumerateDevices: jest.fn(async () => []),
      getUserMedia: jest.fn(),
    });
    const workerConstructor = (jest.requireMock(
      "../../workers/dicekey-image-frame-worker?worker",
    ) as { default: jest.Mock }).default;
    const worker = new FakeWorker();
    workerConstructor.mockImplementation(() => worker);
    let disposedHandle: WalletRecoveryScannerAcquisitionHandle | undefined;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(ScanDiceKeyView, {
          height: "100%",
          scanMode: "wallet-recovery",
          onExit: jest.fn(),
          onWalletRecoveryAttemptStarted: (handle) => {
            disposedHandle = handle;
            handle.dispose();
            return true;
          },
          onWalletRecoveryScan: jest.fn(),
        }));
        await flushCameraPromises();
      });

      expect(disposedHandle).toBeDefined();
      expect(instanceSpy).not.toHaveBeenCalled();
      expect(mediaDevices.addEventListener).not.toHaveBeenCalled();
      expect(mediaDevices.enumerateDevices).not.toHaveBeenCalled();
      expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      await expect(disposedHandle!.cleanupSettlement).resolves.toBeUndefined();
    } finally {
      await act(async () => root.unmount());
      workerConstructor.mockReset();
      instanceSpy.mockRestore();
    }
  });

  test("hung ImageCapture first frame fails the wallet attempt and closes a late bitmap", async () => {
    jest.useFakeTimers();
    const camera = fakeCamera("hung-image-capture-camera");
    const inventory = fakeCamerasOnThisDevice([camera]);
    const instanceSpy = jest.spyOn(CamerasOnThisDevice, "instance")
      .mockReturnValue(inventory);
    const workerConstructor = (jest.requireMock(
      "../../workers/dicekey-image-frame-worker?worker",
    ) as { default: jest.Mock }).default;
    const worker = new FakeWorker();
    workerConstructor.mockImplementation(() => worker);
    const lateBitmap = deferred<ImageBitmap>();
    const grabFrame = jest.fn(() => lateBitmap.promise);
    class HungImageCapture {
      constructor(readonly track: MediaStreamTrack) {}
      grabFrame = grabFrame;
    }
    const restoreImageCapture = installRuntimeImageCapture(HungImageCapture);
    const stream = fakeMediaStream(camera.deviceId);
    makeTrackCaptureReady(stream.videoTrack);
    const getUserMedia = jest.fn(async () => stream.mediaStream);
    installGetUserMedia(getUserMedia);
    const onWalletRecoveryScan = jest.fn();
    let attemptHandle: WalletRecoveryScannerAcquisitionHandle | undefined;
    const cleanupErrors: unknown[] = [];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(ScanDiceKeyView, {
          height: "100%",
          scanMode: "wallet-recovery",
          onExit: jest.fn(),
          onWalletRecoveryAttemptStarted: (handle) => {
            attemptHandle = handle;
            void handle.cleanupSettlement.catch((error: unknown) => {
              cleanupErrors.push(error);
            });
            return true;
          },
          onWalletRecoveryScan,
        }));
        await flushCameraPromises();
      });
      await act(async () => {
        worker.emit({ action: "workerReady" });
        await flushCameraPromises();
      });

      expect(attemptHandle).toBeDefined();
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(grabFrame).toHaveBeenCalledTimes(1);
      const video = container.querySelector("video");
      expect(video?.srcObject).toBe(stream.mediaStream);

      await act(async () => {
        await jest.advanceTimersByTimeAsync(
          WALLET_RECOVERY_FIRST_FRAME_TIMEOUT_MS - 1,
        );
      });
      expect(onWalletRecoveryScan).not.toHaveBeenCalled();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
        await flushCameraPromises();
      });

      expect(onWalletRecoveryScan).toHaveBeenCalledTimes(1);
      expect(onWalletRecoveryScan).toHaveBeenCalledWith(
        createWalletRecoveryScannerAttemptFailure(
          attemptHandle!.acquisitionId,
        ),
        attemptHandle,
      );
      expect(video?.srcObject).toBeNull();
      expect(stream.videoTrack.stop).toHaveBeenCalledTimes(1);
      expect(stream.audioTrack.stop).toHaveBeenCalledTimes(1);
      expect(worker.posted).toEqual([]);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      await expect(attemptHandle!.cleanupSettlement).resolves.toBeUndefined();

      const close = jest.fn();
      await act(async () => {
        lateBitmap.resolve({ width: 1, height: 1, close } as ImageBitmap);
        await flushCameraPromises();
      });
      expect(close).toHaveBeenCalledTimes(1);
      expect(onWalletRecoveryScan).toHaveBeenCalledTimes(1);
      expect(cleanupErrors).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      restoreImageCapture();
      workerConstructor.mockReset();
      instanceSpy.mockRestore();
    }
  });

  test("repeated ImageCapture rejection cannot extend the first-frame deadline", async () => {
    jest.useFakeTimers();
    const camera = fakeCamera("rejecting-image-capture-camera");
    const inventory = fakeCamerasOnThisDevice([camera]);
    const instanceSpy = jest.spyOn(CamerasOnThisDevice, "instance")
      .mockReturnValue(inventory);
    const workerConstructor = (jest.requireMock(
      "../../workers/dicekey-image-frame-worker?worker",
    ) as { default: jest.Mock }).default;
    const worker = new FakeWorker();
    workerConstructor.mockImplementation(() => worker);
    const grabFrame = jest.fn(() =>
      Promise.reject(new Error("camera frame rejected")));
    class RejectingImageCapture {
      constructor(readonly track: MediaStreamTrack) {}
      grabFrame = grabFrame;
    }
    const restoreImageCapture = installRuntimeImageCapture(
      RejectingImageCapture,
    );
    const stream = fakeMediaStream(camera.deviceId);
    makeTrackCaptureReady(stream.videoTrack);
    installGetUserMedia(jest.fn(async () => stream.mediaStream));
    const onWalletRecoveryScan = jest.fn();
    let attemptHandle: WalletRecoveryScannerAcquisitionHandle | undefined;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(ScanDiceKeyView, {
          height: "100%",
          scanMode: "wallet-recovery",
          onExit: jest.fn(),
          onWalletRecoveryAttemptStarted: (handle) => {
            attemptHandle = handle;
            void handle.cleanupSettlement.catch(() => {});
            return true;
          },
          onWalletRecoveryScan,
        }));
        await flushCameraPromises();
        worker.emit({ action: "workerReady" });
        await flushCameraPromises();
      });

      expect(grabFrame).toHaveBeenCalledTimes(1);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(
          WALLET_RECOVERY_FIRST_FRAME_TIMEOUT_MS - 1,
        );
        await flushCameraPromises();
      });
      expect(grabFrame.mock.calls.length).toBeGreaterThan(1);
      expect(onWalletRecoveryScan).not.toHaveBeenCalled();

      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
        await flushCameraPromises();
      });
      expect(onWalletRecoveryScan).toHaveBeenCalledTimes(1);
      expect(onWalletRecoveryScan).toHaveBeenCalledWith(
        createWalletRecoveryScannerAttemptFailure(
          attemptHandle!.acquisitionId,
        ),
        attemptHandle,
      );
      expect(stream.videoTrack.stop).toHaveBeenCalledTimes(1);
      expect(stream.audioTrack.stop).toHaveBeenCalledTimes(1);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      await expect(attemptHandle!.cleanupSettlement).resolves.toBeUndefined();
    } finally {
      await act(async () => root.unmount());
      restoreImageCapture();
      workerConstructor.mockReset();
      instanceSpy.mockRestore();
    }
  });

  test("zero-dimension video fallback fails instead of looking active forever", async () => {
    jest.useFakeTimers();
    const camera = fakeCamera("zero-dimension-video-camera");
    const inventory = fakeCamerasOnThisDevice([camera]);
    const instanceSpy = jest.spyOn(CamerasOnThisDevice, "instance")
      .mockReturnValue(inventory);
    const workerConstructor = (jest.requireMock(
      "../../workers/dicekey-image-frame-worker?worker",
    ) as { default: jest.Mock }).default;
    const worker = new FakeWorker();
    workerConstructor.mockImplementation(() => worker);
    const restoreImageCapture = installRuntimeImageCapture(undefined);
    const stream = fakeMediaStream(camera.deviceId);
    installGetUserMedia(jest.fn(async () => stream.mediaStream));
    const onWalletRecoveryScan = jest.fn();
    let attemptHandle: WalletRecoveryScannerAcquisitionHandle | undefined;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(ScanDiceKeyView, {
          height: "100%",
          scanMode: "wallet-recovery",
          onExit: jest.fn(),
          onWalletRecoveryAttemptStarted: (handle) => {
            attemptHandle = handle;
            void handle.cleanupSettlement.catch(() => {});
            return true;
          },
          onWalletRecoveryScan,
        }));
        await flushCameraPromises();
        worker.emit({ action: "workerReady" });
        await flushCameraPromises();
      });

      const video = container.querySelector("video");
      expect(video).not.toBeNull();
      expect(video?.videoWidth).toBe(0);
      expect(video?.videoHeight).toBe(0);
      expect(video?.srcObject).toBe(stream.mediaStream);
      expect(worker.posted).toEqual([]);

      await act(async () => {
        await jest.advanceTimersByTimeAsync(
          WALLET_RECOVERY_FIRST_FRAME_TIMEOUT_MS,
        );
        await flushCameraPromises();
      });
      expect(onWalletRecoveryScan).toHaveBeenCalledTimes(1);
      expect(onWalletRecoveryScan).toHaveBeenCalledWith(
        createWalletRecoveryScannerAttemptFailure(
          attemptHandle!.acquisitionId,
        ),
        attemptHandle,
      );
      expect(video?.srcObject).toBeNull();
      expect(stream.videoTrack.stop).toHaveBeenCalledTimes(1);
      expect(stream.audioTrack.stop).toHaveBeenCalledTimes(1);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      await expect(attemptHandle!.cleanupSettlement).resolves.toBeUndefined();
    } finally {
      await act(async () => root.unmount());
      restoreImageCapture();
      workerConstructor.mockReset();
      instanceSpy.mockRestore();
    }
  });

  test("wallet readiness deadline fails a committed attempt without waiting for a frame", async () => {
    jest.useFakeTimers();
    const camera = fakeCamera("never-ready-wallet-camera");
    const inventory = fakeCamerasOnThisDevice([camera]);
    const instanceSpy = jest.spyOn(CamerasOnThisDevice, "instance")
      .mockReturnValue(inventory);
    const workerConstructor = (jest.requireMock(
      "../../workers/dicekey-image-frame-worker?worker",
    ) as { default: jest.Mock }).default;
    const worker = new FakeWorker();
    workerConstructor.mockImplementation(() => worker);
    const stream = fakeMediaStream(camera.deviceId);
    installGetUserMedia(jest.fn(async () => stream.mediaStream));
    const onWalletRecoveryScan = jest.fn();
    let attemptHandle: WalletRecoveryScannerAcquisitionHandle | undefined;
    const cleanupErrors: unknown[] = [];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(ScanDiceKeyView, {
          height: "100%",
          scanMode: "wallet-recovery",
          onExit: jest.fn(),
          onWalletRecoveryAttemptStarted: (handle) => {
            attemptHandle = handle;
            void handle.cleanupSettlement.catch((error: unknown) => {
              cleanupErrors.push(error);
            });
            return true;
          },
          onWalletRecoveryScan,
        }));
        await flushCameraPromises();
      });
      expect(attemptHandle).toBeDefined();
      expect(worker.posted).toEqual([]);
      const video = container.querySelector("video");
      expect(video?.srcObject).toBe(stream.mediaStream);

      await act(async () => {
        await jest.advanceTimersByTimeAsync(
          WALLET_RECOVERY_WORKER_READY_TIMEOUT_MS,
        );
        await flushCameraPromises();
      });

      expect(onWalletRecoveryScan).toHaveBeenCalledTimes(1);
      expect(onWalletRecoveryScan).toHaveBeenCalledWith(
        createWalletRecoveryScannerAttemptFailure(
          attemptHandle!.acquisitionId,
        ),
        attemptHandle,
      );
      expect(video?.srcObject).toBeNull();
      expect(stream.videoTrack.stop).toHaveBeenCalledTimes(1);
      expect(stream.audioTrack.stop).toHaveBeenCalledTimes(1);
      expect(worker.posted).toEqual([]);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      await expect(attemptHandle!.cleanupSettlement).resolves.toBeUndefined();
      expect(cleanupErrors).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      workerConstructor.mockReset();
      instanceSpy.mockRestore();
    }
  });

  test("wallet first-frame watchdog waits for ready capture after registration", async () => {
    jest.useFakeTimers();
    const inventory = Object.assign(fakeCamerasOnThisDevice([]), {
      status: "discovering" as const,
      ready: false,
      readyAndNonEmpty: false,
    });
    const instanceSpy = jest.spyOn(CamerasOnThisDevice, "instance")
      .mockReturnValue(inventory);
    const workerConstructor = (jest.requireMock(
      "../../workers/dicekey-image-frame-worker?worker",
    ) as { default: jest.Mock }).default;
    const worker = new FakeWorker();
    workerConstructor.mockImplementation(() => worker);
    const onWalletRecoveryScan = jest.fn();
    let attemptHandle: WalletRecoveryScannerAcquisitionHandle | undefined;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(ScanDiceKeyView, {
          height: "100%",
          scanMode: "wallet-recovery",
          onExit: jest.fn(),
          onWalletRecoveryAttemptStarted: (handle) => {
            attemptHandle = handle;
            return true;
          },
          onWalletRecoveryScan,
        }));
        await flushCameraPromises();
        worker.emit({ action: "workerReady" });
        await flushCameraPromises();
      });

      expect(attemptHandle).toBeDefined();
      expect(instanceSpy).toHaveBeenCalledTimes(1);
      expect(container.querySelector("video")).toBeNull();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(
          WALLET_RECOVERY_FIRST_FRAME_TIMEOUT_MS + 1,
        );
      });
      expect(onWalletRecoveryScan).not.toHaveBeenCalled();

      await act(async () => root.unmount());
      await expect(attemptHandle!.cleanupSettlement).resolves.toBeUndefined();
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    } finally {
      if (container.isConnected || container.childNodes.length > 0) {
        await act(async () => root.unmount());
      }
      workerConstructor.mockReset();
      instanceSpy.mockRestore();
    }
  });

  test("wallet StrictMode mounts register distinct stable attempt handles", async () => {
    const camera = fakeCamera("strict-attempt-camera");
    const firstInventory = fakeCamerasOnThisDevice([camera]);
    const secondInventory = fakeCamerasOnThisDevice([camera]);
    const order: string[] = [];
    const instanceSpy = jest.spyOn(CamerasOnThisDevice, "instance")
      .mockImplementationOnce(() => {
        order.push("instance-1");
        return firstInventory;
      })
      .mockImplementation(() => {
        order.push("instance-2");
        return secondInventory;
      });
    const workerConstructor = (jest.requireMock(
      "../../workers/dicekey-image-frame-worker?worker",
    ) as { default: jest.Mock }).default;
    const workers: FakeWorker[] = [];
    workerConstructor.mockImplementation(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      order.push(`worker-${workers.length}`);
      return worker;
    });
    const streams: ReturnType<typeof fakeMediaStream>[] = [];
    installGetUserMedia(jest.fn(async () => {
      const stream = fakeMediaStream(camera.deviceId);
      streams.push(stream);
      return stream.mediaStream;
    }));
    const handles: WalletRecoveryScannerAcquisitionHandle[] = [];
    const cleanupErrors: unknown[] = [];
    const onWalletRecoveryAttemptStarted = jest.fn((
      handle: WalletRecoveryScannerAcquisitionHandle,
    ) => {
      handles.push(handle);
      order.push(`register-${handles.length}`);
      expect(instanceSpy).not.toHaveBeenCalled();
      if (handles.length === 2) {
        expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
      }
      void handle.cleanupSettlement.catch((error: unknown) => {
        cleanupErrors.push(error);
      });
      return true;
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(
          React.StrictMode,
          null,
          React.createElement(ScanDiceKeyView, {
            height: "100%",
            scanMode: "wallet-recovery",
            onExit: jest.fn(),
            onWalletRecoveryAttemptStarted,
            onWalletRecoveryScan: jest.fn(),
          }),
        ));
        await flushCameraPromises();
      });

      expect(handles).toHaveLength(2);
      expect(handles[0]).not.toBe(handles[1]);
      expect(handles[0]!.acquisitionId).not.toBe(handles[1]!.acquisitionId);
      handles.forEach((handle) => expect(Object.isFrozen(handle)).toBe(true));
      expect(onWalletRecoveryAttemptStarted).toHaveBeenCalledTimes(2);
      expect(instanceSpy).toHaveBeenCalledTimes(2);
      expect(order).toEqual([
        "worker-1",
        "register-1",
        "worker-2",
        "register-2",
        "instance-1",
        "instance-2",
      ]);
      await expect(handles[0]!.cleanupSettlement).resolves.toBeUndefined();
      expect(workers).toHaveLength(2);
      expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
      expect(workers[1]!.terminate).not.toHaveBeenCalled();

      await act(async () => root.unmount());
      await expect(handles[1]!.cleanupSettlement).resolves.toBeUndefined();
      expect(workers[1]!.terminate).toHaveBeenCalledTimes(1);
      streams.forEach(({ videoTrack, audioTrack, stop }) => {
        expect(videoTrack.stop).toHaveBeenCalledTimes(1);
        expect(audioTrack.stop).toHaveBeenCalledTimes(1);
        expect(stop).toHaveBeenCalledTimes(1);
      });
      expect(cleanupErrors).toEqual([]);
    } finally {
      if (container.isConnected || container.childNodes.length > 0) {
        await act(async () => root.unmount());
      }
      workerConstructor.mockReset();
      instanceSpy.mockRestore();
    }
  });

  test("active camera loss stops capture and exposes fixed Retry UI", async () => {
    const camera = fakeCamera("lost-active-camera");
    const inventory = fakeCamerasOnThisDevice([camera]);
    const instanceSpy = jest.spyOn(CamerasOnThisDevice, "instance")
      .mockReturnValue(inventory);
    const workerConstructor = (jest.requireMock(
      "../../workers/dicekey-image-frame-worker?worker",
    ) as { default: jest.Mock }).default;
    const worker = new FakeWorker();
    workerConstructor.mockImplementation(() => worker);
    const streams: ReturnType<typeof fakeMediaStream>[] = [];
    installGetUserMedia(jest.fn(async () => {
      const stream = fakeMediaStream(camera.deviceId);
      streams.push(stream);
      return stream.mediaStream;
    }));
    let attemptHandle: WalletRecoveryScannerAcquisitionHandle | undefined;
    const cleanupErrors: unknown[] = [];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(ScanDiceKeyView, {
          height: "100%",
          scanMode: "wallet-recovery",
          onExit: jest.fn(),
          onWalletRecoveryAttemptStarted: (handle) => {
            attemptHandle = handle;
            void handle.cleanupSettlement.catch((error: unknown) => {
              cleanupErrors.push(error);
            });
            return true;
          },
          onWalletRecoveryScan: jest.fn(),
        }));
        await flushCameraPromises();
      });
      expect(attemptHandle).toBeDefined();
      const activeStream = streams.find(({ mediaStream }) =>
        container.querySelector("video")?.srcObject === mediaStream);
      expect(activeStream).toBeDefined();

      await act(async () => {
        activeStream!.emitEnded();
        await flushCameraPromises();
      });

      expect(container.querySelector("h2")?.textContent)
        .toBe("Camera could not be started");
      const retryButton = [...container.querySelectorAll("button")].find(
        ({ textContent }) => textContent === "Retry camera",
      );
      expect(retryButton?.tabIndex).toBe(0);
      expect(activeStream!.videoTrack.stop).toHaveBeenCalledTimes(1);
      expect(activeStream!.audioTrack.stop).toHaveBeenCalledTimes(1);
      streams.forEach(({ videoTrack, audioTrack }) => {
        expect(videoTrack.stop).toHaveBeenCalled();
        expect(audioTrack.stop).toHaveBeenCalled();
      });
      await expect(attemptHandle!.cleanupSettlement).resolves.toBeUndefined();
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(cleanupErrors).toEqual([]);
      await act(async () => root.unmount());
    } finally {
      if (container.isConnected || container.childNodes.length > 0) {
        await act(async () => root.unmount());
      }
      workerConstructor.mockReset();
      instanceSpy.mockRestore();
    }
  });

  test("camera discovery listener and refresh are scoped to one disposable attempt", async () => {
    const mediaDevices = installMediaDevices({
      enumerateDevices: jest.fn(async () => []),
    });
    const cameras = CamerasOnThisDevice.instance(1024, 720);
    await flushCameraPromises();

    expect(mediaDevices.addEventListener).toHaveBeenCalledWith(
      "devicechange",
      expect.any(Function),
    );
    expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(1);
    cameras.dispose();
    expect(mediaDevices.removeEventListener).toHaveBeenCalledWith(
      "devicechange",
      expect.any(Function),
    );

    mediaDevices.emitDeviceChange();
    await flushCameraPromises();
    expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(1);
    expect(cameras.status).toBe("disposed");
  });

  test("clean-origin discovery bootstraps permission, re-enumerates, and inspects only a stable id", async () => {
    const hiddenIdentity = fakeCamera("");
    const stableCamera = fakeCamera("permission-revealed-camera");
    const bootstrapStream = fakeDiscoveryMediaStream({
      deviceId: "ua-default-camera",
    });
    const inspectionStream = fakeDiscoveryMediaStream({
      deviceId: stableCamera.deviceId,
    });
    const enumerateDevices = jest.fn()
      .mockResolvedValueOnce([hiddenIdentity])
      .mockResolvedValueOnce([stableCamera]);
    const getUserMedia = jest.fn()
      .mockResolvedValueOnce(bootstrapStream.mediaStream)
      .mockResolvedValueOnce(inspectionStream.mediaStream);
    installMediaDevices({ enumerateDevices, getUserMedia });

    const cameras = CamerasOnThisDevice.instance(1024, 720);
    await flushCameraPromises();

    expect(enumerateDevices).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenNthCalledWith(1, { video: true });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: { deviceId: { exact: stableCamera.deviceId } },
    });
    expect(cameras.status).toBe("ready");
    expect(cameras.cameras.map(({ deviceId }) => deviceId))
      .toEqual([stableCamera.deviceId]);
    expect(cameras.camerasByDeviceId.has("")).toBe(false);
    expect(cameras.camerasToBeAdded.has("")).toBe(false);
    expect(cameras.unreadableCameraDevices.has("")).toBe(false);
    expect(bootstrapStream.videoTrack.stop).toHaveBeenCalledTimes(1);
    expect(bootstrapStream.stop).toHaveBeenCalledTimes(1);
    expect(inspectionStream.videoTrack.stop).toHaveBeenCalledTimes(1);
    cameras.dispose();
  });

  test("clean-origin permission denial fixes discovery at permission-denied", async () => {
    const hiddenIdentity = fakeCamera("");
    const enumerateDevices = jest.fn(async () => [hiddenIdentity]);
    const getUserMedia = jest.fn(async () => {
      throw namedError("NotAllowedError");
    });
    installMediaDevices({ enumerateDevices, getUserMedia });

    const cameras = CamerasOnThisDevice.instance(1024, 720);
    await flushCameraPromises();

    expect(cameras.status).toBe("permission-denied");
    expect(enumerateDevices).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ video: true });
    expect(cameras.cameras).toEqual([]);
    cameras.dispose();
  });

  test("clean-origin permission timeout stops its late generic stream", async () => {
    jest.useFakeTimers();
    const hiddenIdentity = fakeCamera("");
    const bootstrapRequest = deferred<MediaStream>();
    const enumerateDevices = jest.fn(async () => [hiddenIdentity]);
    const getUserMedia = jest.fn(() => bootstrapRequest.promise);
    installMediaDevices({ enumerateDevices, getUserMedia });

    const cameras = CamerasOnThisDevice.instance(1024, 720);
    await flushCameraPromises();
    await jest.advanceTimersByTimeAsync(CAMERA_REQUEST_TIMEOUT_MS);
    await flushCameraPromises();

    expect(cameras.status).toBe("timeout");
    expect(enumerateDevices).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ video: true });
    const lateStream = fakeDiscoveryMediaStream({
      deviceId: "late-bootstrap-camera",
    });
    bootstrapRequest.resolve(lateStream.mediaStream);
    await flushCameraPromises();
    expect(lateStream.videoTrack.stop).toHaveBeenCalledTimes(1);
    expect(lateStream.stop).toHaveBeenCalledTimes(1);
    expect(cameras.cameras).toEqual([]);
    cameras.dispose();
  });

  test("clean-origin discovery fails closed when re-enumeration still has no stable id", async () => {
    const hiddenIdentity = fakeCamera("");
    const bootstrapStream = fakeDiscoveryMediaStream({ deviceId: "" });
    const enumerateDevices = jest.fn(async () => [hiddenIdentity]);
    const getUserMedia = jest.fn(({ video }: MediaStreamConstraints) => {
      if (video !== true) {
        const deviceId = (video as MediaTrackConstraints).deviceId as
          ConstrainDOMStringParameters;
        if (deviceId.exact === "") {
          throw namedError("OverconstrainedError");
        }
      }
      return Promise.resolve(bootstrapStream.mediaStream);
    });
    installMediaDevices({ enumerateDevices, getUserMedia });

    const cameras = CamerasOnThisDevice.instance(1024, 720);
    await flushCameraPromises();

    expect(cameras.status).toBe("camera-error");
    expect(enumerateDevices).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ video: true });
    expect(cameras.camerasByDeviceId.has("")).toBe(false);
    expect(cameras.camerasToBeAdded.has("")).toBe(false);
    expect(cameras.unreadableCameraDevices.has("")).toBe(false);
    expect(bootstrapStream.videoTrack.stop).toHaveBeenCalledTimes(1);
    cameras.dispose();
  });

  test("an empty UA device identity can never become an exact constraint", () => {
    for (const unstableDeviceId of ["", "   "]) {
      let failure: unknown;
      try {
        videoConstraintsForDevice(unstableDeviceId);
      } catch (error) {
        failure = error;
      }
      expect(failure).toEqual(expect.objectContaining({
        name: "CameraAccessException",
        reason: "camera-error",
      }));
    }
  });

  test.each([
    ["unknown maxima", undefined, "ready"],
    [
      "known insufficient maxima",
      {
        width: { min: 320, max: 640, step: 1 },
        height: { min: 240, max: 480, step: 1 },
      } as unknown as MediaTrackCapabilities,
      "no-suitable-camera",
    ],
  ] as const)(
    "camera suitability uses capability maxima: %s",
    async (_caseName, capabilities, expectedStatus) => {
      const camera = fakeCamera("capability-camera");
      const enumerateDevices = jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([camera]);
      const getUserMedia = jest.fn(async () =>
        fakeDiscoveryMediaStream({
          deviceId: camera.deviceId,
          settings: { width: 640, height: 480 },
          capabilities,
        }).mediaStream);
      installMediaDevices({ enumerateDevices, getUserMedia });
      const cameras = CamerasOnThisDevice.instance(1024, 720);
      await flushCameraPromises();

      await cameras.addAttachedAndRemovedDetachedCameras();

      expect(cameras.status).toBe(expectedStatus);
      expect(cameras.cameras).toHaveLength(
        expectedStatus === "ready" ? 1 : 0,
      );
      expect(getUserMedia).toHaveBeenCalledWith({
        video: { deviceId: { exact: camera.deviceId } },
      });
      cameras.dispose();
    },
  );

  test("parallel-open failures retry camera inspection sequentially", async () => {
    const firstCamera = fakeCamera("parallel-first");
    const secondCamera = fakeCamera("parallel-second");
    const enumerateDevices = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([firstCamera, secondCamera]);
    const firstFallback = deferred<MediaStream>();
    const secondFallback = deferred<MediaStream>();
    const getUserMedia = jest.fn()
      .mockRejectedValueOnce(namedError("NotReadableError"))
      .mockRejectedValueOnce(namedError("NotReadableError"))
      .mockImplementationOnce(() => firstFallback.promise)
      .mockImplementationOnce(() => secondFallback.promise);
    installMediaDevices({ enumerateDevices, getUserMedia });
    const cameras = CamerasOnThisDevice.instance(1024, 720);
    await flushCameraPromises();

    const refresh = cameras.addAttachedAndRemovedDetachedCameras();
    await flushCameraPromises();
    expect(getUserMedia).toHaveBeenCalledTimes(3);

    const firstStream = fakeDiscoveryMediaStream({
      deviceId: firstCamera.deviceId,
      capabilities: {
        width: { min: 320, max: 1280, step: 1 },
        height: { min: 240, max: 720, step: 1 },
      } as unknown as MediaTrackCapabilities,
    });
    firstFallback.resolve(firstStream.mediaStream);
    await flushCameraPromises();
    expect(getUserMedia).toHaveBeenCalledTimes(4);

    const secondStream = fakeDiscoveryMediaStream({
      deviceId: secondCamera.deviceId,
      capabilities: {
        width: { min: 320, max: 1280, step: 1 },
        height: { min: 240, max: 720, step: 1 },
      } as unknown as MediaTrackCapabilities,
    });
    secondFallback.resolve(secondStream.mediaStream);
    await refresh;

    expect(cameras.status).toBe("ready");
    expect(cameras.cameras.map(({ deviceId }) => deviceId).sort()).toEqual([
      firstCamera.deviceId,
      secondCamera.deviceId,
    ]);
    expect(firstStream.videoTrack.stop).toHaveBeenCalledTimes(1);
    expect(secondStream.videoTrack.stop).toHaveBeenCalledTimes(1);
    cameras.dispose();
  });

  test("audio-only and equivalent devicechange preserve active camera inventory", async () => {
    const camera = fakeCamera("stable-video-camera");
    const initialAudio = {
      ...fakeCamera("initial-audio"),
      kind: "audioinput",
    } as MediaDeviceInfo;
    const replacementAudio = {
      ...fakeCamera("replacement-audio"),
      kind: "audioinput",
    } as MediaDeviceInfo;
    const enumerateDevices = jest.fn(async () => [camera, initialAudio]);
    const getUserMedia = jest.fn(async () => fakeDiscoveryMediaStream({
      deviceId: camera.deviceId,
      capabilities: {
        width: { min: 320, max: 1280, step: 1 },
        height: { min: 240, max: 720, step: 1 },
      } as unknown as MediaTrackCapabilities,
    }).mediaStream);
    const mediaDevices = installMediaDevices({ enumerateDevices, getUserMedia });
    const cameras = CamerasOnThisDevice.instance(1024, 720);
    await flushCameraPromises();
    const originalCamera = cameras.cameras[0];
    const originalAcquisitionCount = getUserMedia.mock.calls.length;
    expect(cameras.status).toBe("ready");

    enumerateDevices.mockResolvedValue([
      replacementAudio,
      { ...camera, label: "renamed but identical video id" },
    ]);
    mediaDevices.emitDeviceChange();
    expect(cameras.status).toBe("ready");
    await flushCameraPromises();

    expect(cameras.status).toBe("ready");
    expect(cameras.cameras[0]).toBe(originalCamera);
    expect(getUserMedia).toHaveBeenCalledTimes(originalAcquisitionCount);
    cameras.dispose();
  });

  test.each([undefined, "different-camera"])(
    "selected camera fails closed when returned device identity is %s",
    async (returnedDeviceId) => {
      const camera = fakeCamera("requested-camera");
      const cameras = fakeCamerasOnThisDevice([camera]);
      const stream = fakeMediaStream(returnedDeviceId);
      installGetUserMedia(jest.fn(async () => stream.mediaStream));
      const state = new MediaStreamState(cameras, {});

      await expect(state.setCamera(camera)).rejects.toEqual(
        expect.objectContaining({ reason: "camera-error" }),
      );
      expect(state.failureReason).toBe("camera-error");
      expect(state.mediaStream).toBeUndefined();
      expect(stream.videoTrack.stop).toHaveBeenCalledTimes(1);
      expect(stream.audioTrack.stop).toHaveBeenCalledTimes(1);
      expect(stream.stop).toHaveBeenCalledTimes(1);
    },
  );

  test("unreadable-camera errors outrank known insufficient cameras", async () => {
    const lowCamera = fakeCamera("known-low-camera");
    const unreadableCamera = fakeCamera("unknown-unreadable-camera");
    const enumerateDevices = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([lowCamera, unreadableCamera]);
    const getUserMedia = jest.fn(({ video }: MediaStreamConstraints) => {
      const requestedId = (video as MediaTrackConstraints).deviceId as
        ConstrainDOMStringParameters;
      if (requestedId.exact === lowCamera.deviceId) {
        return Promise.resolve(fakeDiscoveryMediaStream({
          deviceId: lowCamera.deviceId,
          capabilities: {
            width: { min: 320, max: 640, step: 1 },
            height: { min: 240, max: 480, step: 1 },
          } as unknown as MediaTrackCapabilities,
        }).mediaStream);
      }
      return Promise.reject(namedError("NotReadableError"));
    });
    installMediaDevices({ enumerateDevices, getUserMedia });
    const cameras = CamerasOnThisDevice.instance(1024, 720);
    await flushCameraPromises();

    await cameras.addAttachedAndRemovedDetachedCameras();

    expect(cameras.status).toBe("camera-error");
    expect(cameras.cameras).toEqual([]);
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    cameras.dispose();
  });

  test("camera discovery stops a stream that resolves after its timeout", async () => {
    jest.useFakeTimers();
    const cameraDevice = fakeCamera("late-discovery-camera");
    const cameraRequest = deferred<MediaStream>();
    installMediaDevices({
      enumerateDevices: jest.fn(async () => [cameraDevice]),
      getUserMedia: jest.fn(() => cameraRequest.promise),
    });
    const cameras = CamerasOnThisDevice.instance(1024, 720);
    await flushCameraPromises();

    await jest.advanceTimersByTimeAsync(CAMERA_REQUEST_TIMEOUT_MS);
    await flushCameraPromises();
    expect(cameras.status).toBe("timeout");

    const lateStream = fakeDiscoveryMediaStream();
    cameraRequest.resolve(lateStream.mediaStream);
    await flushCameraPromises();
    expect(lateStream.videoTrack.stop).toHaveBeenCalledTimes(1);
    expect(lateStream.stop).toHaveBeenCalledTimes(1);
    expect(cameras.cameras).toEqual([]);
    cameras.dispose();
  });

  test("camera discovery maps permission denial to one fixed state", async () => {
    const cameraDevice = fakeCamera("denied-camera");
    installMediaDevices({
      enumerateDevices: jest.fn(async () => [cameraDevice]),
      getUserMedia: jest.fn(async () => {
        throw namedError("NotAllowedError");
      }),
    });
    const cameras = CamerasOnThisDevice.instance(1024, 720);
    await cameras.addAttachedAndRemovedDetachedCameras();

    expect(cameras.status).toBe("permission-denied");
    expect(cameras.cameras).toEqual([]);
    cameras.dispose();
  });

  test.each([
    ["discovering", "Camera access needed", "status"],
    ["permission-denied", "Camera permission denied", "alert"],
    ["timeout", "Camera setup timed out", "alert"],
    ["no-camera", "No camera found", "alert"],
    ["no-suitable-camera", "No compatible camera found", "alert"],
    ["camera-error", "Camera could not be started", "alert"],
  ] as const)("wallet camera state %s is fixed, accessible, and has Exit", async (
    status,
    heading,
    role,
  ) => {
    const cameras = Object.assign(fakeCamerasOnThisDevice([]), {
      status: status as CameraDiscoveryStatus,
      ready: status !== "discovering",
      readyAndNonEmpty: false,
    });
    const instanceSpy = jest.spyOn(CamerasOnThisDevice, "instance")
      .mockReturnValue(cameras);
    const workerConstructor = (jest.requireMock(
      "../../workers/dicekey-image-frame-worker?worker",
    ) as { default: jest.Mock }).default;
    workerConstructor.mockImplementation(() => new FakeWorker());
    const onExit = jest.fn();
    const editManually = jest.fn();
    const props = {
      height: "100%",
      scanMode: "wallet-recovery",
      onExit,
      editManually,
      onWalletRecoveryAttemptStarted: jest.fn(() => true),
    } as unknown as ScanDiceKeyViewProps;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(ScanDiceKeyView, props));
        await flushCameraPromises();
      });
      expect(container.querySelector(`[role="${role}"]`)).not.toBeNull();
      expect(container.querySelector("h2")?.textContent).toBe(heading);
      const buttons = [...container.querySelectorAll("button")];
      const exitButton = buttons.find(({ textContent }) =>
        textContent === "Exit recovery");
      expect(exitButton).toBeDefined();
      expect(exitButton!.tabIndex).toBe(0);
      expect(buttons.some(({ textContent }) =>
        textContent === "Enter manually instead")).toBe(false);
      const retryButton = buttons.find(({ textContent }) =>
        textContent === "Retry camera");
      expect(retryButton != null).toBe(status !== "discovering");
      if (retryButton != null) expect(retryButton.tabIndex).toBe(0);

      await act(async () => {
        exitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(editManually).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      workerConstructor.mockReset();
      instanceSpy.mockRestore();
    }
  });

  test.each([375, 768, 1440])(
    "wallet blocked controls stay inside a %spx scanner container",
    async (containerSize) => {
      const cameras = Object.assign(fakeCamerasOnThisDevice([]), {
        status: "permission-denied" as const,
      });
      const instanceSpy = jest.spyOn(CamerasOnThisDevice, "instance")
        .mockReturnValue(cameras);
      const workerConstructor = (jest.requireMock(
        "../../workers/dicekey-image-frame-worker?worker",
      ) as { default: jest.Mock }).default;
      workerConstructor.mockImplementation(() => new FakeWorker());
      const container = document.createElement("div");
      container.style.width = `${containerSize}px`;
      container.style.height = `${containerSize}px`;
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(React.createElement(ScanDiceKeyView, {
            height: "100%",
            scanMode: "wallet-recovery",
            onExit: jest.fn(),
            onWalletRecoveryAttemptStarted: jest.fn(() => true),
          }));
          await flushCameraPromises();
        });

        const panel = container.querySelector<HTMLElement>(
          "[data-wallet-camera-blocked-panel='permission-denied']",
        );
        expect(panel).not.toBeNull();
        const panelStyle = getComputedStyle(panel!);
        expect(panelStyle.position).not.toBe("absolute");
        expect(panelStyle.width).toBe("100%");
        expect(panelStyle.height).toBe("100%");
        expect(panelStyle.overflow).toBe("auto");
        expect(panelStyle.width).not.toBe("100vw");
        expect(panelStyle.height).not.toBe("100vh");
        const buttons = [...panel!.querySelectorAll("button")];
        expect(buttons.map(({ textContent }) => textContent)).toEqual([
          "Retry camera",
          "Exit recovery",
        ]);
        buttons.forEach((button) => expect(button.tabIndex).toBe(0));
      } finally {
        await act(async () => root.unmount());
        container.remove();
        workerConstructor.mockReset();
        instanceSpy.mockRestore();
      }
    },
  );

  test.each([375, 768, 1440])(
    "wallet multi-camera selector remains in an auto row at %spx",
    async (containerSize) => {
      const firstCamera = fakeCamera(
        `contained-first-${containerSize}-${"long-hardware-name-".repeat(8)}`,
      );
      const secondCamera = fakeCamera(
        `contained-second-${containerSize}-${"long-hardware-name-".repeat(8)}`,
      );
      const inventory = fakeCamerasOnThisDevice([firstCamera, secondCamera]);
      const instanceSpy = jest.spyOn(CamerasOnThisDevice, "instance")
        .mockReturnValue(inventory);
      const workerConstructor = (jest.requireMock(
        "../../workers/dicekey-image-frame-worker?worker",
      ) as { default: jest.Mock }).default;
      workerConstructor.mockImplementation(() => new FakeWorker());
      const stream = fakeMediaStream(firstCamera.deviceId);
      installGetUserMedia(jest.fn(async () => stream.mediaStream));
      const cleanupSettlements: Promise<void>[] = [];
      const container = document.createElement("div");
      container.style.width = `${containerSize}px`;
      container.style.height = `${containerSize}px`;
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(React.createElement(ScanDiceKeyView, {
            height: "100%",
            showBoxOverlay: true,
            scanMode: "wallet-recovery",
            onExit: jest.fn(),
            onWalletRecoveryAttemptStarted: (handle) => {
              cleanupSettlements.push(handle.cleanupSettlement);
              return true;
            },
          }));
          await flushCameraPromises();
        });

        const shell = container.querySelector<HTMLElement>(
          "[data-wallet-scanner-layout='contained']",
        );
        const preview = container.querySelector<HTMLElement>(
          "[data-wallet-scanner-preview='contained']",
        );
        const controls = container.querySelector<HTMLElement>(
          "[data-wallet-scanner-controls='camera-selection']",
        );
        const capture = container.querySelector<HTMLElement>(
          "[data-camera-capture-layout='wallet-contained']",
        );
        const select = controls?.querySelector("select");
        const video = preview?.querySelector("video");
        expect(shell).not.toBeNull();
        expect(preview).not.toBeNull();
        expect(controls).not.toBeNull();
        expect(capture).not.toBeNull();
        expect(select).not.toBeNull();
        expect(select?.options).toHaveLength(2);
        expect(controls?.contains(select!)).toBe(true);
        expect(getComputedStyle(shell!).display).toBe("grid");
        expect(getComputedStyle(shell!).gridTemplateColumns)
          .toBe("minmax(0, 1fr)");
        expect(getComputedStyle(shell!).gridTemplateRows)
          .toContain("auto");
        expect(getComputedStyle(shell!).overflow).toBe("hidden");
        const controlsStyle = getComputedStyle(controls!);
        expect(controlsStyle.display).toBe("grid");
        expect(controlsStyle.gridTemplateColumns).toBe("minmax(0, 1fr)");
        expect(controlsStyle.width).toBe("100%");
        expect(controlsStyle.minWidth).toBe("0");
        expect(controlsStyle.minHeight).toBe("3rem");
        const selectorLayout = select!.parentElement as HTMLElement;
        const selectorLayoutStyle = getComputedStyle(selectorLayout);
        expect(selectorLayoutStyle.display).toBe("flex");
        expect(selectorLayoutStyle.flexWrap).toBe("wrap");
        expect(selectorLayoutStyle.width).toBe("100%");
        expect(selectorLayoutStyle.minWidth).toBe("0");
        const selectStyle = getComputedStyle(select!);
        expect(selectStyle.boxSizing).toBe("border-box");
        expect(selectStyle.width).toBe("100%");
        expect(selectStyle.maxWidth).toBe("100%");
        expect(selectStyle.minWidth).toBe("0");
        expect(selectStyle.flexBasis).toBe("20rem");
        expect(getComputedStyle(capture!).position).toBe("relative");
        expect(getComputedStyle(capture!).overflow).toBe("hidden");
        expect(video?.style.objectFit).toBe("contain");
        expect(video?.style.maxWidth).toBe("100%");
        expect(video?.style.maxHeight).toBe("100%");
        expect(video?.style.width).toBe("auto");
        expect(video?.style.height).toBe("auto");
      } finally {
        await act(async () => root.unmount());
        await Promise.all(cleanupSettlements);
        container.remove();
        workerConstructor.mockReset();
        instanceSpy.mockRestore();
      }
    },
  );

  test("wallet single-camera capture renders no selector row or reserved track", async () => {
    const camera = fakeCamera("single-contained-camera");
    const inventory = fakeCamerasOnThisDevice([camera]);
    const instanceSpy = jest.spyOn(CamerasOnThisDevice, "instance")
      .mockReturnValue(inventory);
    const workerConstructor = (jest.requireMock(
      "../../workers/dicekey-image-frame-worker?worker",
    ) as { default: jest.Mock }).default;
    workerConstructor.mockImplementation(() => new FakeWorker());
    const stream = fakeMediaStream(camera.deviceId);
    installGetUserMedia(jest.fn(async () => stream.mediaStream));
    const cleanupSettlements: Promise<void>[] = [];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(ScanDiceKeyView, {
          height: "100%",
          scanMode: "wallet-recovery",
          onExit: jest.fn(),
          onWalletRecoveryAttemptStarted: (handle) => {
            cleanupSettlements.push(handle.cleanupSettlement);
            return true;
          },
        }));
        await flushCameraPromises();
      });

      const shell = container.querySelector<HTMLElement>(
        "[data-wallet-scanner-layout='contained']",
      );
      expect(shell).not.toBeNull();
      expect(getComputedStyle(shell!).gridTemplateRows)
        .toBe("minmax(0, 1fr)");
      expect(container.querySelector(
        "[data-wallet-scanner-controls='camera-selection']",
      )).toBeNull();
      expect(container.querySelector("select")).toBeNull();
      const readyStatuses = container.querySelectorAll("[role='status']");
      expect(readyStatuses).toHaveLength(1);
      expect(readyStatuses[0]?.textContent)
        .toBe("Camera active. Looking for 25 clear DiceKey faces.");
      expect(readyStatuses[0]?.getAttribute("aria-live")).toBe("polite");
      expect(readyStatuses[0]?.getAttribute("aria-atomic")).toBe("true");
      expect(readyStatuses[0]?.closest("[aria-hidden='true']")).toBeNull();
      const readyStatusStyle = getComputedStyle(
        readyStatuses[0] as HTMLElement,
      );
      expect(readyStatusStyle.position).toBe("absolute");
      expect(readyStatusStyle.width).toBe("1px");
      expect(readyStatusStyle.height).toBe("1px");
      expect(container.textContent?.match(/Camera active\./g)).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      await Promise.all(cleanupSettlements);
      workerConstructor.mockReset();
      instanceSpy.mockRestore();
    }
  });

  test("wallet Retry disposes the old inventory and starts a fresh generation", async () => {
    const first = Object.assign(fakeCamerasOnThisDevice([]), {
      status: "permission-denied" as const,
    });
    const second = Object.assign(fakeCamerasOnThisDevice([]), {
      status: "no-camera" as const,
    });
    const instanceSpy = jest.spyOn(CamerasOnThisDevice, "instance")
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const workerConstructor = (jest.requireMock(
      "../../workers/dicekey-image-frame-worker?worker",
    ) as { default: jest.Mock }).default;
    workerConstructor.mockImplementation(() => new FakeWorker());
    const onRetry = jest.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(ScanDiceKeyView, {
          height: "100%",
          scanMode: "wallet-recovery",
          onExit: jest.fn(),
          onRetry,
          onWalletRecoveryAttemptStarted: jest.fn(() => true),
        }));
        await flushCameraPromises();
      });
      const retryButton = [...container.querySelectorAll("button")].find(
        ({ textContent }) => textContent === "Retry camera",
      );
      expect(retryButton).toBeDefined();

      await act(async () => {
        retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flushCameraPromises();
      });
      expect(first.dispose).toHaveBeenCalled();
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(instanceSpy).toHaveBeenCalledTimes(2);
      expect(container.querySelector("h2")?.textContent).toBe("No camera found");
    } finally {
      await act(async () => root.unmount());
      workerConstructor.mockReset();
      instanceSpy.mockRestore();
    }
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
    const lateStream = fakeMediaStream("late-camera");
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

  test("selected-camera timeout rejects with a fixed state and stops the late stream", async () => {
    jest.useFakeTimers();
    const camera = fakeCamera("timed-out-camera");
    const cameras = fakeCamerasOnThisDevice([camera]);
    const mediaRequest = deferred<MediaStream>();
    const getUserMedia = jest.fn(() => mediaRequest.promise);
    installGetUserMedia(getUserMedia);
    const state = new MediaStreamState(cameras, {});
    const failure = state.setCamera(camera).catch((error: unknown) => error);

    await jest.advanceTimersByTimeAsync(CAMERA_REQUEST_TIMEOUT_MS);
    await expect(failure).resolves.toEqual(expect.objectContaining({
      name: "CameraAccessException",
      reason: "timeout",
    }));
    expect(state.failureReason).toBe("timeout");
    expect(state.mediaStream).toBeUndefined();

    const lateStream = fakeMediaStream("timed-out-camera");
    mediaRequest.resolve(lateStream.mediaStream);
    await flushCameraPromises();
    expect(lateStream.videoTrack.stop).toHaveBeenCalledTimes(1);
    expect(lateStream.audioTrack.stop).toHaveBeenCalledTimes(1);
    expect(lateStream.stop).toHaveBeenCalledTimes(1);
  });

  test("malformed and zero-video-track streams fail closed and stop all tracks", async () => {
    const camera = fakeCamera("malformed-camera");
    const cameras = fakeCamerasOnThisDevice([camera]);
    const strayTrack = { stop: jest.fn() } as unknown as MediaStreamTrack;
    const stop = jest.fn();
    const malformedStream = {
      getTracks: () => [strayTrack],
      getVideoTracks: () => [],
      stop,
    } as unknown as MediaStream;
    installGetUserMedia(jest.fn(async () => malformedStream));
    const state = new MediaStreamState(cameras, {});

    await expect(state.setCamera(camera)).rejects.toEqual(
      expect.objectContaining({
        name: "CameraAccessException",
        reason: "camera-error",
      }),
    );
    expect(state.failureReason).toBe("camera-error");
    expect(state.mediaStream).toBeUndefined();
    expect(strayTrack.stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["stream", "getTracks"],
    ["stream", "getVideoTracks"],
    ["stream", "addEventListener"],
    ["stream", "removeEventListener"],
    ["track", "stop"],
    ["track", "getSettings"],
    ["track", "addEventListener"],
    ["track", "removeEventListener"],
  ] as const)(
    "missing required %s.%s method fails closed",
    async (target, method) => {
      const camera = fakeCamera("method-validation-camera");
      const cameras = fakeCamerasOnThisDevice([camera]);
      const stream = fakeMediaStream(camera.deviceId);
      const candidate = target === "stream"
        ? stream.mediaStream
        : stream.videoTrack;
      Reflect.deleteProperty(candidate as unknown as object, method);
      installGetUserMedia(jest.fn(async () => stream.mediaStream));
      const state = new MediaStreamState(cameras, {});

      await expect(state.setCamera(camera)).rejects.toEqual(
        expect.objectContaining({ reason: "camera-error" }),
      );
      expect(state.failureReason).toBe("camera-error");
      expect(state.mediaStream).toBeUndefined();
      expect(stream.stop).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["ended", "inactive"] as const)(
    "%s transitions the active stream to camera-error and releases it",
    async (eventType) => {
      const camera = fakeCamera(`liveness-${eventType}-camera`);
      const cameras = fakeCamerasOnThisDevice([camera]);
      const stream = fakeMediaStream(camera.deviceId);
      installGetUserMedia(jest.fn(async () => stream.mediaStream));
      const state = new MediaStreamState(cameras, {});

      await state.setCamera(camera);
      expect(state.mediaStream).toBe(stream.mediaStream);
      if (eventType === "ended") stream.emitEnded();
      else stream.emitInactive();

      expect(state.failureReason).toBe("camera-error");
      expect(state.mediaStream).toBeUndefined();
      expect(state.deviceId).toBeUndefined();
      expect(stream.videoTrack.stop).toHaveBeenCalledTimes(1);
      expect(stream.audioTrack.stop).toHaveBeenCalledTimes(1);
      expect(stream.stop).toHaveBeenCalledTimes(1);
      expect(stream.mediaStream.removeEventListener).toHaveBeenCalledWith(
        "inactive",
        expect.any(Function),
      );
      expect(stream.videoTrack.removeEventListener).toHaveBeenCalledWith(
        "ended",
        expect.any(Function),
      );
      state.dispose();
      expect(stream.videoTrack.stop).toHaveBeenCalledTimes(1);
    },
  );

  test("cameras without manual focus receive no manual-focus constraint", async () => {
    const camera = fakeCamera("fixed-focus-camera");
    const cameras = fakeCamerasOnThisDevice([camera]);
    const stream = fakeMediaStream("fixed-focus-camera");
    const getUserMedia = jest.fn(async () => stream.mediaStream);
    installGetUserMedia(getUserMedia);
    const state = new MediaStreamState(cameras, { width: { ideal: 1024 } });

    await state.setCamera(camera);
    const mediaRequests = getUserMedia.mock.calls as unknown as
      Array<[MediaStreamConstraints]>;
    const requestedVideo = mediaRequests[0]![0].video as MediaTrackConstraints;
    expect(requestedVideo.advanced).toBeUndefined();
    expect(state.supportsFixedFocus).toBe(false);
    state.dispose();
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
    const firstStream = fakeMediaStream("first-camera");
    const secondStream = fakeMediaStream("second-camera");

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
    const stream = fakeMediaStream("legacy-camera");
    const getUserMedia = jest.fn(() => Promise.resolve(stream.mediaStream));
    installGetUserMedia(getUserMedia);
    const state = new MediaStreamState(cameras, { width: { ideal: 1024 } });

    await state.setDeviceId(camera.deviceId);
    expect(state.deviceId).toBe(camera.deviceId);
    expect(state.mediaStream).toBe(stream.mediaStream);
    expect(state.supportsFixedFocus).toBe(true);
    const mediaRequests = getUserMedia.mock.calls as unknown as
      Array<[MediaStreamConstraints]>;
    const requestedVideo = mediaRequests[0]![0].video as MediaTrackConstraints;
    expect(requestedVideo.deviceId).toEqual({ exact: camera.deviceId });
    expect(requestedVideo.advanced).toEqual([{
      focusMode: "manual",
      focusDistance: { ideal: 1, max: 1 },
    }]);
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
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const originalActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  let getContextSpy: jest.SpyInstance;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    if (globalThis.DOMRectReadOnly == null) {
      Object.defineProperty(globalThis, "DOMRectReadOnly", {
        configurable: true,
        value: class DOMRectReadOnly {
          readonly x = 0;
          readonly y = 0;
          readonly width = 0;
          readonly height = 0;
          readonly top = 0;
          readonly right = 0;
          readonly bottom = 0;
          readonly left = 0;
          toJSON(): object { return {}; }
        },
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

  test("wallet scanner frame leaves the measured SVG as the only guide", () => {
    const sheet = new ServerStyleSheet();
    try {
      renderToString(sheet.collectStyles(React.createElement(ScannerFrame)));
      const css = sheet.getStyleTags();
      expect(css).not.toContain("::after");
      expect(css).not.toContain("background-size:20% 20%");
    } finally {
      sheet.seal();
    }
  });

  test("camera media is decorative and mobile-safe", async () => {
    const mediaStreamState = {
      mediaStream: undefined,
      supportsFixedFocus: false,
    } as MediaStreamState;
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(CameraCaptureWithOverlayComponent, {
        mediaStreamState,
        showBoxOverlay: true,
      }));
    });

    const video = container.querySelector("video");
    const legacyCapture = container.querySelector<HTMLElement>(
      "[data-camera-capture-layout='legacy']",
    );
    expect(legacyCapture).not.toBeNull();
    expect(getComputedStyle(legacyCapture!).display).toBe("contents");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("aria-hidden")).toBe("true");
    expect(video?.tabIndex).toBe(-1);
    expect(video?.muted).toBe(true);
    expect(video?.playsInline).toBe(true);
    expect(video?.style.width).toBe("100%");
    expect(video?.style.height).toBe("auto");
    const overlay = container.querySelector("img");
    expect(overlay?.getAttribute("alt")).toBe("");
    expect(overlay?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("canvas")?.closest("[aria-hidden='true']"))
      .not.toBeNull();

    await act(async () => root.unmount());
  });

  test.each([
    [
      "landscape",
      { left: 50, top: 157.5, width: 400, height: 225 },
      { left: 0, top: 87.5, width: 400, height: 225 },
    ],
    [
      "portrait",
      { left: 137.5, top: 70, width: 225, height: 400 },
      { left: 87.5, top: 0, width: 225, height: 400 },
    ],
  ] as const)(
    "wallet-contained %s preview aligns canvas and guide to local video bounds",
    async (_orientation, videoGeometry, expectedCanvas) => {
      const mediaStreamState = {
        mediaStream: undefined,
        supportsFixedFocus: false,
      } as MediaStreamState;
      let component: CameraCaptureWithOverlayComponent | null = null;
      const container = document.createElement("div");
      const root = createRoot(container);
      const asRect = ({
        left,
        top,
        width,
        height,
      }: {
        left: number;
        top: number;
        width: number;
        height: number;
      }): DOMRect => ({
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        toJSON: () => ({ left, top, width, height }),
      } as DOMRect);

      await act(async () => {
        root.render(React.createElement(CameraCaptureWithOverlayComponent, {
          ref: (instance) => { component = instance; },
          mediaStreamState,
          showBoxOverlay: true,
          layoutMode: "wallet-contained",
        }));
      });

      const capture = container.querySelector<HTMLElement>(
        "[data-camera-capture-layout='wallet-contained']",
      );
      const video = container.querySelector("video");
      expect(capture).not.toBeNull();
      expect(video).not.toBeNull();
      capture!.getBoundingClientRect = jest.fn(() => asRect({
        left: 50,
        top: 70,
        width: 400,
        height: 400,
      }));
      video!.getBoundingClientRect = jest.fn(() => asRect(videoGeometry));

      await act(async () => {
        (component as unknown as { updateVideoElementBounds: () => void })
          .updateVideoElementBounds();
      });

      const expectedSquareSize = 225;
      const expectedOffset = 87.5;
      const guide = container.querySelector("img");
      const canvas = container.querySelector("canvas");
      expect(guide?.width).toBe(expectedSquareSize);
      expect(guide?.height).toBe(expectedSquareSize);
      expect(guide?.style.left).toBe(`${expectedOffset}px`);
      expect(guide?.style.top).toBe(`${expectedOffset}px`);
      expect(canvas?.width).toBe(expectedCanvas.width);
      expect(canvas?.height).toBe(expectedCanvas.height);
      expect(canvas?.style.left).toBe(`${expectedCanvas.left}px`);
      expect(canvas?.style.top).toBe(`${expectedCanvas.top}px`);
      expect(video?.style.objectFit).toBe("contain");

      await act(async () => root.unmount());
    },
  );

  test.each([
    [
      "missing settings aspectRatio",
      () => ({ width: 1600, height: 900 } as MediaTrackSettings),
      { width: 0, height: 0 },
      { left: 0, top: 87.5, width: 400, height: 225 },
    ],
    [
      "throwing settings aspectRatio",
      () => {
        const settings = { width: 1600, height: 900 } as MediaTrackSettings;
        Object.defineProperty(settings, "aspectRatio", {
          configurable: true,
          get: () => { throw new Error("aspectRatio unavailable"); },
        });
        return settings;
      },
      { width: 0, height: 0 },
      { left: 0, top: 87.5, width: 400, height: 225 },
    ],
    [
      "video intrinsic dimensions",
      () => ({} as MediaTrackSettings),
      { width: 900, height: 1600 },
      { left: 87.5, top: 0, width: 225, height: 400 },
    ],
  ] as const)(
    "%s produces a source-aligned annotation canvas",
    async (_caseName, settingsFactory, intrinsic, expectedCanvas) => {
      const stream = fakeMediaStream("aspect-fallback-camera");
      (stream.videoTrack.getSettings as jest.Mock)
        .mockImplementation(settingsFactory);
      const mediaStreamState = {
        mediaStream: stream.mediaStream,
        supportsFixedFocus: false,
      } as MediaStreamState;
      let component: CameraCaptureWithOverlayComponent | null = null;
      const container = document.createElement("div");
      const root = createRoot(container);
      const squareRect = {
        x: 20,
        y: 30,
        left: 20,
        top: 30,
        width: 400,
        height: 400,
        right: 420,
        bottom: 430,
        toJSON: () => ({}),
      } as DOMRect;

      await act(async () => {
        root.render(React.createElement(CameraCaptureWithOverlayComponent, {
          ref: (instance) => { component = instance; },
          mediaStreamState,
          layoutMode: "wallet-contained",
        }));
      });
      const capture = container.querySelector<HTMLElement>(
        "[data-camera-capture-layout='wallet-contained']",
      );
      const video = container.querySelector("video");
      expect(capture).not.toBeNull();
      expect(video).not.toBeNull();
      capture!.getBoundingClientRect = jest.fn(() => squareRect);
      video!.getBoundingClientRect = jest.fn(() => squareRect);
      Object.defineProperties(video!, {
        videoWidth: { configurable: true, value: intrinsic.width },
        videoHeight: { configurable: true, value: intrinsic.height },
      });

      await act(async () => {
        (component as unknown as { updateVideoElementBounds: () => void })
          .updateVideoElementBounds();
      });

      const canvas = container.querySelector("canvas");
      expect(canvas).not.toBeNull();
      expect({
        left: Number.parseFloat(canvas!.style.left),
        top: Number.parseFloat(canvas!.style.top),
        width: canvas!.width,
        height: canvas!.height,
      }).toEqual(expectedCanvas);
      await act(async () => root.unmount());
    },
  );

  test("real React StrictMode replay restores capture refs and one active grabber", async () => {
    const stream = fakeMediaStream("strict-capture-camera");
    const mediaStreamState = {
      mediaStream: stream.mediaStream,
      supportsFixedFocus: false,
    } as MediaStreamState;
    const grabbers: Array<{ dispose: jest.Mock }> = [];
    const createGrabber = (): { dispose: jest.Mock } => {
      const grabber = { dispose: jest.fn() };
      grabbers.push(grabber);
      return grabber;
    };
    let committedInstance: CameraCaptureWithOverlayComponent | undefined;
    class StrictCaptureHarness extends CameraCaptureWithOverlayComponent {
      public constructor(props: CameraCaptureWithOverlayProperties) {
        super(props);
        committedInstance = this;
      }

      protected createImageCaptureFrameGrabber = (): { dispose: jest.Mock } =>
        createGrabber();

      protected createVideoElementFrameGrabber = (): { dispose: jest.Mock } =>
        createGrabber();
    }
    let terminalDispose: (() => void) | undefined;
    const onFrameCaptured = jest.fn();
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(
        React.StrictMode,
        null,
        React.createElement(StrictCaptureHarness, {
          mediaStreamState,
          onFrameCaptured,
          registerSynchronousCaptureDisposer: (dispose) => {
            terminalDispose = dispose;
          },
        }),
      ));
    });

    expect(grabbers).toHaveLength(2);
    expect(grabbers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(grabbers[1]!.dispose).not.toHaveBeenCalled();
    expect(container.querySelector("video")?.srcObject).toBe(stream.mediaStream);
    expect(terminalDispose).toEqual(expect.any(Function));
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();
    const replayClearRect = committedInstance!.renderingContext?.clearRect as
      jest.Mock;
    expect(replayClearRect).toHaveBeenCalledWith(
      0,
      0,
      canvas!.width,
      canvas!.height,
    );
    await committedInstance!.onFrameCaptured(testImageData());
    expect(onFrameCaptured).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
    );

    canvas!.width = 13;
    canvas!.height = 7;
    const backingPixels = new Uint8ClampedArray(
      canvas!.width * canvas!.height * 4,
    );
    backingPixels.fill(91);
    const clearRect = jest.fn(() => backingPixels.fill(0));
    committedInstance!.renderingContext = {
      canvas: canvas!,
      clearRect,
      drawImage: jest.fn(),
      getImageData: jest.fn(() => testImageData()),
    } as unknown as CanvasRenderingContext2D;

    terminalDispose!();
    expect(grabbers[1]!.dispose).toHaveBeenCalledTimes(1);
    expect(clearRect).toHaveBeenLastCalledWith(0, 0, 13, 7);
    expect([...backingPixels].every((value) => value === 0)).toBe(true);
    expect({ width: canvas!.width, height: canvas!.height }).toEqual({
      width: 13,
      height: 7,
    });
    backingPixels.fill(37);
    await act(async () => root.unmount());
    expect(clearRect).toHaveBeenCalledTimes(2);
    expect([...backingPixels].every((value) => value === 0)).toBe(true);
    expect({ width: canvas!.width, height: canvas!.height }).toEqual({
      width: 13,
      height: 7,
    });
    grabbers.forEach(({ dispose }) => expect(dispose).toHaveBeenCalledTimes(1));
  });

  afterAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
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
