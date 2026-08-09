import { throwIfNull } from "../../utilities/throwIfNull";
import { withDefined } from "../../utilities/with-defined";


export class FrameGrabberUsingImageCapture {
  /**
   * A re-usable canvas into which to capture image frames
   */
  private captureCanvas?: HTMLCanvasElement;
  private captureCanvasCtx?: CanvasRenderingContext2D;

  imageCapture?: ImageCapture;
  private callback?: (frame: ImageData) => void | Promise<void>;
  private disposed = false;
  private listeningForUnmute = false;

  constructor(videoTrack: MediaStreamTrack, callback: (frame: ImageData) => void | Promise<void>) {
    this.callback = callback;
    this.captureCanvas = document.createElement("canvas");
    this.captureCanvasCtx = throwIfNull(
      this.captureCanvas.getContext("2d", {willReadFrequently: true}),
    );
    this.imageCapture = new ImageCapture(videoTrack);
    this.frameGrabLoopIteration();
  }

  private readonly msToWaitOnFailure = 100;
  private readonly msToWaitOnSuccess = 1;

  private frameBeingReadOrProcessed: boolean = false;
  private frameBeingProcessed?: ImageData;
  private timeout?: ReturnType<typeof setTimeout>;

  private readonly handleTrackUnmuted = () => {
    this.listeningForUnmute = false;
  };

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    withDefined(this.timeout, timeout => clearTimeout(timeout));
    this.timeout = undefined;
    this.callback = undefined;
    try { this.frameBeingProcessed?.data.fill(0); } catch {}
    this.frameBeingProcessed = undefined;
    if (this.listeningForUnmute) {
      this.imageCapture?.track.removeEventListener("unmute", this.handleTrackUnmuted);
      this.listeningForUnmute = false;
    }
    this.imageCapture = undefined;
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
    this.timeout = setTimeout(this.frameGrabLoopIteration, delayInMs);
  };

  private getFrame = async (): Promise<ImageData | undefined> => {
    if (this.disposed) return;
    const imageCapture = this.imageCapture;
    const track = imageCapture?.track;
    if (imageCapture == null || track == null || track.readyState !== "live" || !track.enabled || track.muted) {
      if (track?.muted && !this.listeningForUnmute) {
        // For some reason, if we don't read enough frames fast enough, browser may mute the
        // track.  If they do, just re-open the camera.
        this.listeningForUnmute = true;
        track.addEventListener("unmute", this.handleTrackUnmuted, {once: true});
      }
      return;
    }
    let bitMap: ImageBitmap | undefined;
    try {
      bitMap = await imageCapture.grabFrame();
      if (bitMap == null || this.disposed) {
        return;
      }
      const captureCanvas = this.captureCanvas;
      let captureCanvasCtx = this.captureCanvasCtx;
      if (captureCanvas == null || captureCanvasCtx == null) return;
      const {width, height} = bitMap;
      // console.log(`Grabbing frame with dimensions ${width}x${height}`)
      if (captureCanvas.width != width || captureCanvas.height != height) {
        [captureCanvas.width, captureCanvas.height] = [width, height];
        captureCanvasCtx = throwIfNull(captureCanvas.getContext("2d"));
        this.captureCanvasCtx = captureCanvasCtx;
      }
      captureCanvasCtx.drawImage(bitMap, 0, 0);
      return captureCanvasCtx.getImageData(0, 0, width, height);
    } catch {
      return;
    } finally {
      bitMap?.close?.();
    }
  };

  private frameGrabFailed = () =>
    this.completeFrameGrabAndStartNextAfterDelayOf(this.msToWaitOnFailure);

  private frameGrabSucceeded = (msToWait: number = this.msToWaitOnSuccess) =>
    this.completeFrameGrabAndStartNextAfterDelayOf(msToWait);

  private frameGrabLoopIteration = async () => {
    if (this.disposed || this.frameBeingReadOrProcessed) {
      return;
    }
    this.frameBeingReadOrProcessed = true;
    withDefined(this.timeout, timeout => {
      clearTimeout(timeout); this.timeout = undefined;
    });
    try {
      const frame = await this.getFrame();
      if (frame == null) return this.frameGrabFailed();
      // Own and wipe every captured frame even if dispose() ran after
      // getFrame() resolved but before this await continuation resumed.
      this.frameBeingProcessed = frame;
      try {
        if (this.disposed) return;
        await this.callback?.(frame)
      } catch {
        /* If the callback fails, it's not our problem.  The frame capture was still a success.  Carry on. */
      } finally {
        try { frame.data.fill(0); } catch {}
        if (this.frameBeingProcessed === frame) {
          this.frameBeingProcessed = undefined;
        }
      }
      if (this.disposed) return;
      return this.frameGrabSucceeded();
    } catch {}
    return this.frameGrabFailed();
  };
}
