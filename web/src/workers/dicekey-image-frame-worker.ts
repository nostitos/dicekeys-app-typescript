import {
    DiceKeyImageProcessor,
    DiceKeyImageProcessorModuleWithHelpers,
    DiceKeyImageProcessorModulePromise, FaceRead
} from "@dicekeys/read-dicekey-js"
import { TupleOf25Items } from "../dicekeys/DiceKey";
import { FaceReadJsonObjectWithImageIfErrorFound } from "../dicekeys/FacesRead";
import {
    ScannerWorkerSessionHandler,
    ScannerWorkerSessionPort,
    wipeScannerFaceImageResponse,
    wipeScannerRgbaRequest,
} from "../views/LoadingDiceKeys/wallet-recovery-scanner-worker-session-handler";

/**
 * A request to process an image frame while scanning dicekeys
 */
interface RequestMetadata {
    sessionId: string;
}
interface Frame {
    width: number;
    height: number;
    rgbImageAsArrayBuffer: ArrayBufferLike;
}
export interface ProcessFrameRequest extends RequestMetadata, Frame {
  requestId: number;
  action: "processRGBAImageFrame";
}

export interface TerminateSessionRequest {
    action: "terminateSession";
    sessionId: string;
    requestId: number;
}

export interface TerminateSessionResponse {
    action: "sessionTerminated";
    sessionId: string;
    requestId: number;
}

export interface ReadyMessage {
    action: "workerReady"
}

export interface WorkerInitializationFailedMessage {
    action: "workerInitializationFailed";
    message: string;
}

/**
 * A response with the result of processing a camera frame
 * to look for a DiceKey
 */
export interface ProcessFrameResponse extends RequestMetadata {
  width: number;
  height: number;
  requestId: number;
  action: "processRGBAImageFrame";
  isFinished: boolean,
  facesReadObjectArray: TupleOf25Items<FaceReadJsonObjectWithImageIfErrorFound> | undefined,
  exception?: Error;
}

function isProcessFrameRequest(t: unknown) : t is ProcessFrameRequest {
    const rgbImageAsArrayBuffer =
        typeof t === "object" && t != null && "rgbImageAsArrayBuffer" in t ?
        (t as {rgbImageAsArrayBuffer?: unknown}).rgbImageAsArrayBuffer : undefined;
    const isArrayBufferLike = rgbImageAsArrayBuffer instanceof ArrayBuffer ||
        (typeof SharedArrayBuffer !== "undefined" &&
            rgbImageAsArrayBuffer instanceof SharedArrayBuffer);
    return typeof t === "object" && t != null &&
        "action" in t &&
        ((t as {action?: unknown}).action === "processRGBAImageFrame") &&
        "sessionId" in t && typeof (t as {sessionId?: unknown}).sessionId === "string" &&
        "requestId" in t && typeof (t as {requestId?: unknown}).requestId === "number" &&
        "width" in t && "height" in t &&
        isArrayBufferLike;
}

const postWorkerMessage = (message: unknown, transfer?: Transferable[]): void => {
    (self as unknown as {
        postMessage: (m: unknown, t?: Transferable[]) => unknown;
    }).postMessage(message, transfer);
};

const workerSessionPort: ScannerWorkerSessionPort = {
    addEventListener: (_type, listener) => addEventListener("message", listener),
    removeEventListener: (_type, listener) => removeEventListener("message", listener),
    postMessage: postWorkerMessage,
    close: () => (self as unknown as {close?: () => void}).close?.(),
};

/**
 * This class implements the worker that processes image frames.
 * It is launched after the image-processing web assembly module is loaded
 */
class FrameProcessingWorker {
    private readonly module: DiceKeyImageProcessorModuleWithHelpers;

    constructor(module: DiceKeyImageProcessorModuleWithHelpers) {
        this.module = module;
        new ScannerWorkerSessionHandler<
            DiceKeyImageProcessor,
            ProcessFrameRequest,
            ProcessFrameResponse
        >({
            port: workerSessionPort,
            createProcessor: () => new this.module.DiceKeyImageProcessor(),
            isProcessRequest: isProcessFrameRequest,
            processFrame: this.processRGBAImageFrame,
            cleanupProcessRequest: wipeScannerRgbaRequest,
            cleanupProcessResponse: wipeScannerFaceImageResponse,
        });
    }

    processRGBAImageFrame = ({
        requestId,
        action, sessionId, width, height,
        rgbImageAsArrayBuffer: inputRgbImageAsArrayBuffer
      }: ProcessFrameRequest,
      diceKeyImageProcessor: DiceKeyImageProcessor,
    ): ProcessFrameResponse => {
      let rgbImagesArrayUint8Array: Uint8Array | undefined;
      let facesReadJsonObj: FaceReadJsonObjectWithImageIfErrorFound[] | undefined;
      let faceImagesOwnedByResponse = false;
      try {
      rgbImagesArrayUint8Array = new Uint8Array(inputRgbImageAsArrayBuffer);
        // console.log("Worker starts processing frame", (Date.now() % 100000) / 1000);
        try {
          diceKeyImageProcessor.processRGBAImage(width, height, rgbImagesArrayUint8Array)
        } catch (e) {
          if (typeof e === "string") {
            throw new Error("Error in processImage: " + e);
          } else {
            throw e;
          }
        }
    // console.log("Worker finishes processing frame", (Date.now() % 100000) / 1000);

        const isFinished = diceKeyImageProcessor.isFinished();
        facesReadJsonObj =  (JSON.parse(diceKeyImageProcessor.diceKeyReadJson()) ?? []) as FaceReadJsonObjectWithImageIfErrorFound[];
        facesReadJsonObj.forEach( (faceReadJsonObj, faceIndex) => {
          const faceRead = FaceRead.fromJsonObject(faceReadJsonObj);
          if (faceRead.errors && faceRead.errors.length > 0) {
            let faceReadImageDataFromCpp: Uint8Array | undefined;
            let faceReadImageData: Uint8ClampedArray | undefined;
            try {
              faceReadImageDataFromCpp = diceKeyImageProcessor.getFaceImage(faceIndex);
              faceReadImageData = new Uint8ClampedArray(faceReadImageDataFromCpp);
              faceReadJsonObj.squareImageAsRgbaArray = new Uint8ClampedArray(faceReadImageData);
            } catch (e) {
              if (typeof e === "string") {
                throw new Error("Error in getFaceImage: " + e);
              } else {
                throw e;
              }
            } finally {
              try { faceReadImageData?.fill(0); } catch {}
              try { faceReadImageDataFromCpp?.fill(0); } catch {}
            }
          }
        });

          

  
        const facesReadObjectArray = facesReadJsonObj.length === 25 ?
          facesReadJsonObj as TupleOf25Items<FaceReadJsonObjectWithImageIfErrorFound> :
          undefined;
        faceImagesOwnedByResponse = facesReadObjectArray != null;
        return {
          requestId,
          action, sessionId, height, width,
          isFinished,
          facesReadObjectArray,
        }
    } catch (exception) {
      if (typeof exception === "string") {
        try {throw new Error(exception)} catch (newE) {exception = newE}
      }
      if (!(exception instanceof Error)) {
        try {throw new Error(JSON.stringify(exception))} catch (newE) {exception = newE}
      }
      return {
        requestId,
        action, sessionId, height, width,
        isFinished: false,
        facesReadObjectArray: undefined,
        exception: exception as (Error | undefined)
      }
    } finally {
      try {rgbImagesArrayUint8Array?.fill(0)} catch {}
      if (!faceImagesOwnedByResponse) {
        wipeScannerFaceImageResponse({facesReadObjectArray: facesReadJsonObj});
      }
    }
  }
}

// Create the worker once the required webassembly has been created. Report an
// explicit bootstrap failure because a WorkerGlobalScope unhandled rejection
// is not guaranteed to surface through the parent Worker's error listeners.
DiceKeyImageProcessorModulePromise
  .then( module => new FrameProcessingWorker(module) )
  .catch((exception: unknown) => {
    const message = exception instanceof Error ? exception.message :
      typeof exception === "string" ? exception :
      "DiceKey image processor failed to initialize";
    try {
      postWorkerMessage({
        action: "workerInitializationFailed",
        message,
      } satisfies WorkerInitializationFailedMessage);
    } catch {}
    workerSessionPort.close();
  });
