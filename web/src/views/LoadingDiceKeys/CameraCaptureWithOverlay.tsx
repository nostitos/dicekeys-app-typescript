import React from "react";

import { observer } from "mobx-react";
import { OverlayCanvas } from "../basics/OverlayCanvas";
import { ObservableBounds } from "../basics/bounds";
import { MediaStreamState } from "./MediaStreamState";
import { FrameGrabberUsingImageCapture } from "./FrameGrabberUsingImageCapture";
import { FrameGrabberFromVideoElement } from "./FrameGrabberFromVideoElement";

import ScanningOverlayImage from /*url:*/"../../images/Scanning Overlay.svg";
import styled from "styled-components";

const imageCaptureIsSupported = (): boolean => {
  if (typeof window === "undefined" || !window.hasOwnProperty("ImageCapture")) {
    return false;
  }
  return typeof (window as typeof window & { ImageCapture?: unknown })
    .ImageCapture === "function";
};

/** Retained for callers that inspect support at module-load time. */
export const imageCaptureSupported: boolean = imageCaptureIsSupported();

export interface CameraCaptureWithOverlayProperties {
  mediaStreamState: MediaStreamState;
  onFrameCaptured?: (frame: ImageData, canvasRenderingContext: CanvasRenderingContext2D) => void;
  registerSynchronousCaptureDisposer?: (
    dispose: (() => void) | undefined,
  ) => void;
  showBoxOverlay?: boolean;
  width?: string;
  minHeight?: string;
  height?: string;
  maxHeight?: string;
  layoutMode?: "legacy" | "wallet-contained";
}


export const MiddleOverlaySquare = observer ( ({bounds}: {bounds: ObservableBounds}) => {
  const {width, height, left, top} = bounds.contentRect;
  const squareSize = Math.min(width, height);
  const adjustedTop = top + (height - squareSize) / 2;
  const adjustedLeft = left + (width - squareSize) / 2;
  return (
    <MiddleOverlayImg
      alt=""
      aria-hidden="true"
      draggable={false}
      src={ScanningOverlayImage} 
      width={squareSize}
      height={squareSize}
      style={{left: adjustedLeft, top: adjustedTop}}
    />
  );
});
export const CameraCaptureVideoAndOverlayContainer = styled.div<{
  $contained: boolean;
}>`
  ${({ $contained }) => $contained ? `
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    align-items: center;
    justify-content: center;
    background: #111827;
  ` : `
    display: contents;
  `}
`;
  

const MiddleOverlayImg = styled.img`
  position: absolute;
  background: rgba(0, 0, 0, 0);
  z-index: 8;
`;

type DisposableFrameGrabber = { dispose(): void };

const positiveFiniteNumber = (read: () => unknown): number | undefined => {
  try {
    const value = read();
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : undefined;
  } catch {
    return undefined;
  }
};

const ratioFromDimensions = (
  width: number | undefined,
  height: number | undefined,
): number | undefined => width != null && height != null
  ? width / height
  : undefined;

const cameraSourceAspectRatio = ({
  track,
  videoElement,
  renderedBounds,
}: {
  track: MediaStreamTrack | undefined;
  videoElement: HTMLVideoElement | undefined;
  renderedBounds: DOMRectReadOnly;
}): number | undefined => {
  let settings: MediaTrackSettings | undefined;
  try { settings = track?.getSettings?.(); } catch {}

  const settingsAspectRatio = positiveFiniteNumber(
    () => settings?.aspectRatio,
  );
  if (settingsAspectRatio != null) return settingsAspectRatio;

  const settingsDimensionsRatio = ratioFromDimensions(
    positiveFiniteNumber(() => settings?.width),
    positiveFiniteNumber(() => settings?.height),
  );
  if (settingsDimensionsRatio != null) return settingsDimensionsRatio;

  const videoDimensionsRatio = ratioFromDimensions(
    positiveFiniteNumber(() => videoElement?.videoWidth),
    positiveFiniteNumber(() => videoElement?.videoHeight),
  );
  if (videoDimensionsRatio != null) return videoDimensionsRatio;

  return ratioFromDimensions(
    positiveFiniteNumber(() => renderedBounds.width),
    positiveFiniteNumber(() => renderedBounds.height),
  );
};

const CameraOverlayCanvas = observer(({
  bounds,
  track,
  getVideoElement,
  canvasRef,
}: {
  bounds: ObservableBounds;
  track: MediaStreamTrack | undefined;
  getVideoElement: () => HTMLVideoElement | undefined;
  canvasRef: (canvas: HTMLCanvasElement | null) => void;
}) => (
  <OverlayCanvas
    aspectRatio={cameraSourceAspectRatio({
      track,
      videoElement: getVideoElement(),
      renderedBounds: bounds.contentRect,
    })}
    bounds={bounds}
    ref={canvasRef}
  />
));

export class CameraCaptureWithOverlayComponent extends React.Component<React.PropsWithChildren<CameraCaptureWithOverlayProperties>> {

  renderingContext?: CanvasRenderingContext2D;
  private readonly videoElementBoundsState = ObservableBounds.create();
  private videoElement?: HTMLVideoElement;
  private captureContainer?: HTMLDivElement;
  private overlayCanvas?: HTMLCanvasElement;
  private boundsResizeObserver?: ResizeObserver;
  private mounted = false;
  private scannerAttemptDisposed = false;
  private frameGrabber?: DisposableFrameGrabber;
  private frameGrabberSource?: MediaStreamTrack | HTMLVideoElement;

  protected createImageCaptureFrameGrabber = (
    track: MediaStreamTrack,
  ): DisposableFrameGrabber =>
    new FrameGrabberUsingImageCapture(track, this.onFrameCaptured);

  protected createVideoElementFrameGrabber = (
    videoElement: HTMLVideoElement,
  ): DisposableFrameGrabber =>
    new FrameGrabberFromVideoElement(videoElement, this.onFrameCaptured);

  onFrameCaptured = async (frame: ImageData) => {
    if (this.scannerAttemptDisposed) {
      try { frame.data.fill(0); } catch {}
      return;
    }
    const renderingContext = this.renderingContext;
    if (renderingContext) {
      await this.props.onFrameCaptured?.(frame, renderingContext);
    }
  }

  private disposeFrameGrabber = (): void => {
    const frameGrabber = this.frameGrabber;
    this.frameGrabber = undefined;
    this.frameGrabberSource = undefined;
    try { frameGrabber?.dispose(); } catch {}
  };

  private currentVideoTrack = (): MediaStreamTrack | undefined => {
    try {
      return this.props.mediaStreamState.mediaStream?.getVideoTracks?.()[0];
    } catch {
      return undefined;
    }
  };

  private getVideoElement = (): HTMLVideoElement | undefined =>
    this.videoElement;

  private updateVideoElementBounds = (): void => {
    const videoElement = this.videoElement;
    if (videoElement == null) return;
    const videoRect = videoElement.getBoundingClientRect();
    const containerRect = this.props.layoutMode === "wallet-contained"
      ? this.captureContainer?.getBoundingClientRect()
      : undefined;
    const left = videoRect.left - (containerRect?.left ?? 0);
    const top = videoRect.top - (containerRect?.top ?? 0);
    const { width, height } = videoRect;
    this.videoElementBoundsState[1]({
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({ left, top, width, height }),
    } as DOMRectReadOnly);
  };

  private reconnectBoundsObservation = (): void => {
    try { this.boundsResizeObserver?.disconnect(); } catch {}
    this.boundsResizeObserver = undefined;
    if (!this.mounted || this.videoElement == null) return;
    this.updateVideoElementBounds();
    if (typeof ResizeObserver !== "function") return;
    this.boundsResizeObserver = new ResizeObserver(
      this.updateVideoElementBounds,
    );
    this.boundsResizeObserver.observe(this.videoElement);
    if (
      this.props.layoutMode === "wallet-contained" &&
      this.captureContainer != null
    ) {
      this.boundsResizeObserver.observe(this.captureContainer);
    }
  };

  private clearOverlayCanvasSynchronously = (): void => {
    const renderingContext = this.renderingContext;
    let canvas = this.overlayCanvas;
    if (canvas == null) {
      try { canvas = renderingContext?.canvas; } catch {}
    }
    if (renderingContext == null || canvas == null) return;
    const { width, height } = canvas;
    try {
      renderingContext.clearRect(0, 0, width, height);
    } catch {
      // Resetting a canvas dimension clears its backing store while preserving
      // the dimensions React must replay on a StrictMode commit remount.
      try {
        canvas.width = width;
        canvas.height = height;
      } catch {}
    }
  };

  private synchronizeFrameGrabber = (): void => {
    if (!this.mounted || this.scannerAttemptDisposed) {
      this.disposeFrameGrabber();
      return;
    }
    const mediaStream = this.props.mediaStreamState.mediaStream;
    const track = this.currentVideoTrack();
    const useImageCapture = imageCaptureIsSupported();
    const source = useImageCapture ? track :
      (mediaStream != null ? this.videoElement : undefined);
    if (source === this.frameGrabberSource) return;
    this.disposeFrameGrabber();
    if (useImageCapture && track != null) {
      this.frameGrabber = this.createImageCaptureFrameGrabber(track);
      this.frameGrabberSource = track;
    } else if (!useImageCapture && this.videoElement != null && mediaStream != null) {
      this.frameGrabber = this.createVideoElementFrameGrabber(this.videoElement);
      this.frameGrabberSource = this.videoElement;
    }
  };

  private withVideoElementRef = (videoElement: HTMLVideoElement | null): void => {
    if (videoElement === this.videoElement) return;
    this.disposeFrameGrabber();
    this.videoElement = videoElement ?? undefined;
    if (videoElement != null && !this.scannerAttemptDisposed) {
      videoElement.srcObject = this.props.mediaStreamState.mediaStream ?? null;
    } else if (videoElement != null) {
      videoElement.srcObject = null;
    }
    this.reconnectBoundsObservation();
    this.synchronizeFrameGrabber();
  };

  private withCaptureContainerRef = (
    captureContainer: HTMLDivElement | null,
  ): void => {
    if (captureContainer === this.captureContainer) return;
    this.captureContainer = captureContainer ?? undefined;
    this.reconnectBoundsObservation();
  };

  private withOverlayCanvasRef = (
    overlayCanvas: HTMLCanvasElement | null,
  ): void => {
    if (overlayCanvas == null) {
      this.overlayCanvas = undefined;
      this.renderingContext = undefined;
      return;
    }
    this.overlayCanvas = overlayCanvas;
    this.renderingContext = overlayCanvas.getContext("2d") ?? undefined;
  };

  private disposeForScannerAttempt = (): void => {
    if (this.scannerAttemptDisposed) return;
    this.scannerAttemptDisposed = true;
    this.clearOverlayCanvasSynchronously();
    this.disposeFrameGrabber();
    try {
      if (this.videoElement != null) this.videoElement.srcObject = null;
    } catch {}
  };

  componentDidMount(): void {
    this.mounted = true;
    // React 18 StrictMode may replay class commit cleanup/setup on the same
    // instance. A real terminal attempt never remounts this child.
    this.scannerAttemptDisposed = false;
    this.props.registerSynchronousCaptureDisposer?.(
      this.disposeForScannerAttempt,
    );
    if (this.videoElement != null) {
      this.videoElement.srcObject =
        this.props.mediaStreamState.mediaStream ?? null;
    }
    this.reconnectBoundsObservation();
    this.synchronizeFrameGrabber();
  }

  componentDidUpdate(
    previousProps: Readonly<CameraCaptureWithOverlayProperties> = this.props,
  ): void {
    if (
      previousProps.registerSynchronousCaptureDisposer !==
      this.props.registerSynchronousCaptureDisposer
    ) {
      previousProps.registerSynchronousCaptureDisposer?.(undefined);
      this.props.registerSynchronousCaptureDisposer?.(
        this.disposeForScannerAttempt,
      );
    }
    if (previousProps.layoutMode !== this.props.layoutMode) {
      this.reconnectBoundsObservation();
    }
    if (this.videoElement != null && !this.scannerAttemptDisposed) {
      this.videoElement.srcObject = this.props.mediaStreamState.mediaStream ?? null;
    } else if (this.videoElement != null) {
      this.videoElement.srcObject = null;
    }
    this.synchronizeFrameGrabber();
  }

  componentWillUnmount(): void {
    this.props.registerSynchronousCaptureDisposer?.(undefined);
    this.mounted = false;
    this.clearOverlayCanvasSynchronously();
    this.disposeFrameGrabber();
    try {
      if (this.videoElement != null) this.videoElement.srcObject = null;
    } catch {}
    try { this.boundsResizeObserver?.disconnect(); } catch {}
    this.boundsResizeObserver = undefined;
    // React 18 StrictMode replays class mount cleanup/setup without replaying
    // callback refs. Retain DOM refs here; a real detach invokes each ref with
    // null, while the simulated remount can immediately reconnect the stream.
  }

  render() {
    const [videoElementBounds] = this.videoElementBoundsState;
    const {mediaStreamState} = this.props;
    // Unless the parent sets showBoxOverlay, show the box overlay only when
    // we can set the focus mode to something close.  Otherwise, the overlay may
    // encourage the user to put the DiceKey closer than the camera can focus on it.
    const {showBoxOverlay = mediaStreamState.supportsFixedFocus} = this.props;
    const contained = this.props.layoutMode === "wallet-contained";
    const track = this.currentVideoTrack();
    const {width, height, maxHeight, minHeight} = this.props;
//    console.log(`Rendering CameraCaptureWithOverlay`, height, width, this.props);

    const videoStyle: React.CSSProperties = contained ? {
      display: "block",
      width: "auto",
      height: "auto",
      maxWidth: "100%",
      maxHeight: "100%",
      minWidth: 0,
      minHeight: 0,
      objectFit: "contain",
    } :
      (width != null) ?
        {width, height: "auto", minHeight, maxHeight} :
      (height != null) ?
        {width: "auto", height} :
      (maxHeight != null && minHeight != null) ?
        {width: "auto", maxHeight, minHeight} :
      (maxHeight != null) ?
        {width: "auto", maxHeight} :
        {width: `100%`, height: "auto"};

    return (
        <CameraCaptureVideoAndOverlayContainer
          $contained={contained}
          aria-hidden="true"
          data-camera-capture-layout={contained ? "wallet-contained" : "legacy"}
          ref={this.withCaptureContainerRef}
        >
          <video
            aria-hidden="true"
            tabIndex={-1}
            style={videoStyle}
            autoPlay={true}
            muted={true}
            playsInline={true}
            onLoadedMetadata={this.updateVideoElementBounds}
            onResize={this.updateVideoElementBounds}
            ref={this.withVideoElementRef}
          />
          { !showBoxOverlay ? null : (
            <MiddleOverlaySquare bounds={videoElementBounds} />
          )}
          <CameraOverlayCanvas
            bounds={videoElementBounds}
            track={track}
            getVideoElement={this.getVideoElement}
            canvasRef={this.withOverlayCanvasRef}
          />
        </CameraCaptureVideoAndOverlayContainer>
    );
  }
}

export const CameraCaptureWithOverlay = observer(CameraCaptureWithOverlayComponent);
