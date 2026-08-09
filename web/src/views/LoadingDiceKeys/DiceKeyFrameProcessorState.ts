import {
  FaceRead,
} from "@dicekeys/read-dicekey-js";
import { action, makeAutoObservable } from "mobx";
import { DiceKeyFaces, DiceKeyWithoutKeyId, OrientedFace, TupleOf25Items } from "../../dicekeys/DiceKey";
import {
  FaceReadWithImageIfErrorFound,
  allDiceErrorTypes, allFacesReadHaveMajorityValues
} from "../../dicekeys/FacesRead";
import type {
  ProcessFrameResponse,
} from "../../workers/dicekey-image-frame-worker";
import {
  renderFacesRead
} from "./renderFacesRead";
import { DiceKeyMemoryStore } from "../../state/stores/DiceKeyMemoryStore";
import {
  evaluateWalletRecoveryScannerRead,
  type WalletRecoveryScanResult,
} from "./wallet-recovery-scanner-policy";
import { wipeScannerFaceImageResponse } from "./wallet-recovery-scanner-worker-session-handler";


export type DiceKeyScannerMode = "legacy" | "wallet-recovery";
export const scannerAttemptKeyForMode = (
  scanMode?: DiceKeyScannerMode,
): DiceKeyScannerMode => scanMode ?? "legacy";

export interface DiceKeyFrameProcessorCallbacks {
  readonly onFacesRead?: (facesRead: TupleOf25Items<FaceRead>) => void;
  readonly onDiceKeyRead?: (diceKey: DiceKeyWithoutKeyId) => void;
  readonly onWalletRecoveryScan?: (result: WalletRecoveryScanResult) => void;
}


const validateFaceRead = (faceRead: FaceRead): OrientedFace => {
  const {letter, digit, orientationAsLowercaseLetterTrbl} = faceRead;
  if (letter == null || digit == null) {
    throw new Error("Invalid face read");
  }
  return {letter, digit, orientationAsLowercaseLetterTrbl}
}

export class DiceKeyFrameProcessorState {
  facesRead?: FaceRead[];
  bestFacesRead?: FaceRead[];

  public scanningSuccessfulEnoughToTerminate: boolean = false;
  /**
   * Tracks the number of frames processed per second
   */
   public framesPerSecond: number = 0;
   public frameSize: {width: number, height: number} = ({width: 0, height: 0});
 
   /**
    * Record the times each processed frame comes back (in ms) so
    * that we can calculate the frame rate (framesPerSecond)
    */
   private frameProcessedTimesMs: number[] = [];
 
  /**
   * For tracking the time period during which the only errors in the
   * DiceKey being scanned are bit errors
   */
  private msSinceErrorsNarrowedToJustBitErrors: number | undefined;
  /**
   * Track the number of consecutive frames during which the only errors
   * in the DiceKey being scanned are bit errors.
   */
  private framesSinceErrorsNarrowedToJustBitErrors: number | undefined;

  public onFacesRead?: (facesRead: TupleOf25Items<FaceRead>) => void
  public onDiceKeyRead?: (diceKey: DiceKeyWithoutKeyId) => void
  public onWalletRecoveryScan?: (result: WalletRecoveryScanResult) => void
  public walletRecoveryScanResult?: WalletRecoveryScanResult;
  private disposed = false;
  private readonly scanMode: DiceKeyScannerMode;

  constructor({onFacesRead, onDiceKeyRead, onWalletRecoveryScan, scanMode = "legacy"}:
    DiceKeyFrameProcessorCallbacks & {
    scanMode?: DiceKeyScannerMode;
  }) {
    this.scanMode = scanMode;
    this.onDiceKeyRead = scanMode === "legacy" ? onDiceKeyRead : undefined;
    this.onFacesRead = scanMode === "legacy" ? onFacesRead : undefined;
    this.onWalletRecoveryScan =
      scanMode === "wallet-recovery" ? onWalletRecoveryScan : undefined;
    makeAutoObservable(this, {
      onFacesRead: false,
      onDiceKeyRead: false,
      onWalletRecoveryScan: false,
    });
  }

  /** React StrictMode may replay commit cleanup/setup on the same state object. */
  activate = action(({
    onFacesRead,
    onDiceKeyRead,
    onWalletRecoveryScan,
  }: DiceKeyFrameProcessorCallbacks): void => {
    if (!this.disposed) return;
    this.disposed = false;
    this.onDiceKeyRead = this.scanMode === "legacy" ? onDiceKeyRead : undefined;
    this.onFacesRead = this.scanMode === "legacy" ? onFacesRead : undefined;
    this.onWalletRecoveryScan = this.scanMode === "wallet-recovery"
      ? onWalletRecoveryScan
      : undefined;
  });

  private clearFacesRead = (facesRead?: FaceRead[]): void => {
    facesRead?.forEach((faceRead) => {
      const faceWithImage = faceRead as FaceReadWithImageIfErrorFound;
      try { faceWithImage.squareImageAsRgbaArray?.fill(0); } catch {}
      try { faceWithImage.squareImageAsRgbaArray = undefined; } catch {}
    });
  };

  private replaceBestFacesRead = (facesRead: FaceRead[]): void => {
    const previousBestFacesRead = this.bestFacesRead;
    this.bestFacesRead = facesRead;
    if (
      previousBestFacesRead !== facesRead &&
      previousBestFacesRead !== this.facesRead
    ) {
      this.clearFacesRead(previousBestFacesRead);
    }
  };

  dispose = action((): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.clearFacesRead(this.facesRead);
    if (this.bestFacesRead !== this.facesRead) {
      this.clearFacesRead(this.bestFacesRead);
    }
    this.facesRead = undefined;
    this.bestFacesRead = undefined;
    this.frameProcessedTimesMs.splice(0);
    this.msSinceErrorsNarrowedToJustBitErrors = undefined;
    this.framesSinceErrorsNarrowedToJustBitErrors = undefined;
    this.onFacesRead = undefined;
    this.onDiceKeyRead = undefined;
    this.onWalletRecoveryScan = undefined;
    this.walletRecoveryScanResult = undefined;
    this.scanningSuccessfulEnoughToTerminate = false;
    this.framesPerSecond = 0;
    this.frameSize = {width: 0, height: 0};
  });

  private scanningSuccessful = action ( (): true => {
    this.scanningSuccessfulEnoughToTerminate = true;
    if (this.bestFacesRead && this.onFacesRead) {
      this.onFacesRead(this.bestFacesRead as TupleOf25Items<FaceRead>)
      this.onFacesRead = undefined;
    }
    if (this.bestFacesRead && this.onDiceKeyRead) {
      const onDiceKeyReadCallback = this.onDiceKeyRead;
      this.onDiceKeyRead = undefined;
      try {
        // If the DiceKey validates, call the onDiceKeyRead callback we just removed
        const diceKey = new DiceKeyWithoutKeyId(DiceKeyFaces(this.bestFacesRead.map( faceRead => validateFaceRead(faceRead) )));
        DiceKeyMemoryStore.addCenterFaceOrientationWhenScanned(diceKey);
        onDiceKeyReadCallback(diceKey.rotateToTurnCenterFaceUpright());
      } catch {}
    }
    return true;
  })

  /**
   * This logic determines whether we've met the conditions for scanning,
   * which is currently either:
   *   (1) a perfect scan with no errors, or
   *   (2) only errors in underlines or overlines that can be correct by a
   *       math of one underline/overline to the OCR result, and which
   *       we've been unable to fix after four frames and at least 1 second
   *       of trying to get a better image.
   */
  private processFacesRead = action ( (facesRead?: FaceRead[]): boolean => {
    if (this.disposed) return false;
    if (this.facesRead !== facesRead && this.facesRead !== this.bestFacesRead) {
      this.clearFacesRead(this.facesRead);
    }
    this.facesRead = facesRead;
    if (this.scanMode === "wallet-recovery") {
      const result = evaluateWalletRecoveryScannerRead(facesRead);
      this.walletRecoveryScanResult = result;
      this.scanningSuccessfulEnoughToTerminate = result.status !== "rescan";
      const onWalletRecoveryScan = this.onWalletRecoveryScan;
      if (result.status !== "rescan") {
        // Clear before calling external code so a throw or reentrant frame
        // cannot deliver the terminal candidate more than once.
        this.onWalletRecoveryScan = undefined;
      }
      onWalletRecoveryScan?.(result);
      return this.scanningSuccessfulEnoughToTerminate;
    }
    // Can't finish if there isn't a majority value for each face.
    if (!allFacesReadHaveMajorityValues(facesRead)) {
      this.msSinceErrorsNarrowedToJustBitErrors = undefined;
      this.framesSinceErrorsNarrowedToJustBitErrors = undefined;
      return this.scanningSuccessfulEnoughToTerminate = false;
    }
    const errorTypes = allDiceErrorTypes(facesRead);
    if (errorTypes.length === 0) {
      // All faces have majority values and no errors found -- we're done
      this.replaceBestFacesRead(facesRead!);
      return this.scanningSuccessful();
    }

    const errorsAreOnlyBitErrors = errorTypes.every( e =>
        e === "undoverline-bit-mismatch" || e === "undoverline-missing"
          // should we allow || e === "ocr-second-choice"?        
    );
    if (!errorsAreOnlyBitErrors) {
      this.msSinceErrorsNarrowedToJustBitErrors = undefined;
      this.framesSinceErrorsNarrowedToJustBitErrors = undefined;
      return this.scanningSuccessfulEnoughToTerminate = false;
    }
    
    if (this.msSinceErrorsNarrowedToJustBitErrors == null ||
      this.framesSinceErrorsNarrowedToJustBitErrors == null
    ) {
      this.msSinceErrorsNarrowedToJustBitErrors = Date.now();
      this.framesSinceErrorsNarrowedToJustBitErrors = 0;
    }

    // Require at last 1 second and 4 frames to be processed before
    // giving up on correcting the error.
    if (!this.bestFacesRead || allDiceErrorTypes(this.bestFacesRead).length >= errorTypes.length) {
      this.replaceBestFacesRead(facesRead!);
    }
    if (
      Date.now() - this.msSinceErrorsNarrowedToJustBitErrors > 1000 &&
      ++this.framesSinceErrorsNarrowedToJustBitErrors >= 4
    ) {
      return this.scanningSuccessful();
    } else {
      return false;
    }
  });

  /**
   * Handle frames processed by the web worker, displaying the received
   * overlay image above the video image.
   */
  handleProcessedCameraFrame = action ( (response: ProcessFrameResponse, overlayCanvasCtx: CanvasRenderingContext2D ): void => {
    if (this.disposed) {
      wipeScannerFaceImageResponse(response);
      return;
    }
    try {
    const {width, height, facesReadObjectArray, exception} = response;
    if (exception != null) {
      if (this.scanMode === "wallet-recovery") this.processFacesRead(undefined);
      return;
    }

    this.frameSize = {width, height};

    this.frameProcessedTimesMs.push(Date.now());
    if (this.frameProcessedTimesMs.length > 1) {
      const msPerFrame = (
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.frameProcessedTimesMs.at(-1)! - this.frameProcessedTimesMs[0]!
      ) / (this.frameProcessedTimesMs.length - 1);
      this.framesPerSecond = Math.round( 10000 / msPerFrame) / 10;
      if (this.frameProcessedTimesMs.length === 4) {
        this.frameProcessedTimesMs.shift();
      }
    }

    let facesRead: TupleOf25Items<FaceReadWithImageIfErrorFound> | undefined;
    const convertedFacesRead: FaceReadWithImageIfErrorFound[] = [];
    try {
      facesReadObjectArray?.forEach( faceReadObject => {
        const faceRead: FaceReadWithImageIfErrorFound = FaceRead.fromJsonObject(faceReadObject);
        faceRead.squareImageAsRgbaArray = faceReadObject.squareImageAsRgbaArray;
        faceReadObject.squareImageAsRgbaArray = undefined;
        convertedFacesRead.push(faceRead);
      });
      if (convertedFacesRead.length === 25) {
        facesRead = convertedFacesRead as TupleOf25Items<FaceReadWithImageIfErrorFound>;
      } else {
        this.clearFacesRead(convertedFacesRead);
        facesRead = undefined;
      }
    } catch {
      this.clearFacesRead(convertedFacesRead);
      if (this.scanMode === "wallet-recovery") {
        this.processFacesRead(undefined);
        return;
      }
      throw new Error("Invalid scanner response");
    }
    this.processFacesRead(facesRead);

    // Render the frame onto the screen
   overlayCanvasCtx.clearRect(0, 0, overlayCanvasCtx.canvas.width, overlayCanvasCtx.canvas.height);
    if (this.facesRead) {
      renderFacesRead(overlayCanvasCtx, this.facesRead, {sourceImageSize: {width, height}});
    }
    } finally {
      // Any image not explicitly transferred into an owned FaceRead is wiped,
      // including disposed, exceptional, and partially converted responses.
      wipeScannerFaceImageResponse(response);
    }
  });
}
