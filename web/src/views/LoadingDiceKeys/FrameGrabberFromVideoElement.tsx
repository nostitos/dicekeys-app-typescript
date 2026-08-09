// import { action, makeAutoObservable } from "mobx";
import { throwIfNull } from "../../utilities/throwIfNull";
import { withDefined } from "../../utilities/with-defined";


export class FrameGrabberFromVideoElement {
  /**
   * A re-usable canvas into which to capture image frames
   */
  private captureCanvas?: HTMLCanvasElement;
  private captureCanvasCtx?: CanvasRenderingContext2D;

  private callback?: (frame: ImageData) => void | Promise<void>;
  private disposed = false;

  constructor(private videoElement: HTMLVideoElement | undefined, callback: (frame: ImageData) => void | Promise<void>) {
    this.callback = callback;
    this.captureCanvas = document.createElement("canvas");
    this.captureCanvas.setAttribute("willReadFrequently", "true")
    this.captureCanvasCtx = throwIfNull(this.captureCanvas.getContext("2d"));
    this.frameGrabLoopIteration();
  }

  private readonly msToWaitOnFailure = 100;
  private readonly msToWaitOnSuccess = 1;

  private frameBeingReadOrProcessed: boolean = false;
  private frameBeingProcessed?: ImageData;
  private timeout?: ReturnType<typeof setTimeout>;

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    withDefined(this.timeout, timeout => clearTimeout(timeout));
    this.timeout = undefined;
    this.callback = undefined;
    this.videoElement = undefined;
    try { this.frameBeingProcessed?.data.fill(0); } catch {}
    this.frameBeingProcessed = undefined;
    const captureCanvas = this.captureCanvas;
    const captureCanvasCtx = this.captureCanvasCtx;
    if (captureCanvas != null) {
      try {
        captureCanvasCtx?.clearRect(
          0,
          0,
          captureCanvas.width,
          captureCanvas.height,
        );
      } catch {}
      captureCanvas.width = 0;
      captureCanvas.height = 0;
    }
    this.captureCanvasCtx = undefined;
    this.captureCanvas = undefined;
  };

  private completeFrameGrabAndStartNextAfterDelayOf = (delayInMs: number) => {
    withDefined(this.timeout, timeout => {
      clearTimeout(timeout);
      this.timeout = undefined;
    });
    this.frameBeingReadOrProcessed = false;
    if (this.disposed) return;
    this.timeout = setTimeout(this.frameGrabLoopIteration, delayInMs)
  };

  private getFrameFromVideoPlayer = (): ImageData | undefined => {
    if (this.disposed) return;
    const videoElement = this.videoElement;
    const captureCanvas = this.captureCanvas;
    let captureCanvasCtx = this.captureCanvasCtx;
    if (
      videoElement == null ||
      captureCanvas == null ||
      captureCanvasCtx == null ||
      videoElement.videoWidth == 0 ||
      videoElement.videoHeight == 0
    ) {
      // There's no need to take action if there's no video
      return;
    }

    // Ensure the capture canvas is the size of the video being retrieved
    if (captureCanvas.width != videoElement.videoWidth || captureCanvas.height != videoElement.videoHeight) {
      [captureCanvas.width, captureCanvas.height] = [videoElement.videoWidth, videoElement.videoHeight];
      captureCanvasCtx = throwIfNull(captureCanvas.getContext("2d"));
      this.captureCanvasCtx = captureCanvasCtx;
    }
    captureCanvasCtx.drawImage(videoElement, 0, 0);
    return captureCanvasCtx.getImageData(0, 0, captureCanvas.width, captureCanvas.height);
  };

  private frameGrabFailed = () =>
    this.completeFrameGrabAndStartNextAfterDelayOf(this.msToWaitOnFailure);

  private frameGrabSucceeded = (msToWait: number = this.msToWaitOnSuccess) =>
    this.completeFrameGrabAndStartNextAfterDelayOf(msToWait);

  private frameGrabLoopIteration = async () => {
    if (this.disposed || this.frameBeingReadOrProcessed) return;
    this.frameBeingReadOrProcessed = true;
    withDefined(this.timeout, timeout => {
      clearTimeout(timeout); this.timeout = undefined;
    });
    const frame = this.getFrameFromVideoPlayer();
    if (frame == null) return this.frameGrabFailed();
    this.frameBeingProcessed = frame;
    try {
      await this.callback?.(frame);
    } catch {}
    finally {
      try { frame.data.fill(0); } catch {}
      if (this.frameBeingProcessed === frame) {
        this.frameBeingProcessed = undefined;
      }
    }
    return this.frameGrabSucceeded();
  };
}
