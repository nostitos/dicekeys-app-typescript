import React from "react";

import { observer } from "mobx-react";
import { OverlayCanvas } from "../basics/OverlayCanvas";
import { createReactObservableBounds, ObservableBounds } from "../basics/bounds";
import { MediaStreamState } from "./MediaStreamState";
import { FrameGrabberUsingImageCapture } from "./FrameGrabberUsingImageCapture";
import { FrameGrabberFromVideoElement } from "./FrameGrabberFromVideoElement";

import ScanningOverlayImage from /*url:*/"../../images/Scanning Overlay.svg";
import styled from "styled-components";

export const imageCaptureSupported: boolean =
  typeof window !== "undefined" && window.hasOwnProperty("ImageCapture");

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
}


export const MiddleOverlaySquare = observer ( ({bounds}: {bounds: ObservableBounds}) => {
  const {width, height, left, top} = bounds.contentRect;
  const squareSize = Math.min(width, height);
  const adjustedTop = top + (height - squareSize) / 2;
  const adjustedLeft = left + (width - squareSize) / 2;
  return (
    <MiddleOverlayImg
      src={ScanningOverlayImage} 
      width={squareSize}
      height={squareSize}
      style={{left: adjustedLeft, top: adjustedTop}}
    />
  );
});
export const CameraCaptureVideoAndOverlayContainer = styled.div`
  display: flex;
  align-self: center;
  justify-self: center;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  align-content: center;
  flex-grow: 5;
  flex-shrink: 5;
`;
  

const MiddleOverlayImg = styled.img`
  position: absolute;
  background: rgba(0, 0, 0, 0);
  z-index: 8;
`;

type DisposableFrameGrabber = { dispose(): void };

export class CameraCaptureWithOverlayComponent extends React.Component<React.PropsWithChildren<CameraCaptureWithOverlayProperties>> {

  renderingContext?: CanvasRenderingContext2D;
  private readonly videoElementBoundsState = createReactObservableBounds();
  private videoElement?: HTMLVideoElement;
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

  private synchronizeFrameGrabber = (): void => {
    if (!this.mounted || this.scannerAttemptDisposed) {
      this.disposeFrameGrabber();
      return;
    }
    const mediaStream = this.props.mediaStreamState.mediaStream;
    const track = mediaStream?.getTracks()[0];
    const source = imageCaptureSupported ? track :
      (mediaStream != null ? this.videoElement : undefined);
    if (source === this.frameGrabberSource) return;
    this.disposeFrameGrabber();
    if (imageCaptureSupported && track != null) {
      this.frameGrabber = this.createImageCaptureFrameGrabber(track);
      this.frameGrabberSource = track;
    } else if (!imageCaptureSupported && this.videoElement != null && mediaStream != null) {
      this.frameGrabber = this.createVideoElementFrameGrabber(this.videoElement);
      this.frameGrabberSource = this.videoElement;
    }
  };

  private withVideoElementRef = (videoElement: HTMLVideoElement | null): void => {
    if (videoElement === this.videoElement) return;
    this.disposeFrameGrabber();
    this.videoElement = videoElement ?? undefined;
    this.videoElementBoundsState[1](videoElement);
    if (videoElement != null && !this.scannerAttemptDisposed) {
      videoElement.srcObject = this.props.mediaStreamState.mediaStream ?? null;
    } else if (videoElement != null) {
      videoElement.srcObject = null;
    }
    this.synchronizeFrameGrabber();
  };

  private disposeForScannerAttempt = (): void => {
    if (this.scannerAttemptDisposed) return;
    this.scannerAttemptDisposed = true;
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
    this.disposeFrameGrabber();
    try {
      if (this.videoElement != null) this.videoElement.srcObject = null;
    } catch {}
    this.videoElementBoundsState[1](undefined);
    this.videoElement = undefined;
    this.renderingContext = undefined;
  }

  render() {
    const [videoElementBounds] = this.videoElementBoundsState;
    const {mediaStreamState} = this.props;
    // Unless the parent sets showBoxOverlay, show the box overlay only when
    // we can set the focus mode to something close.  Otherwise, the overlay may
    // encourage the user to put the DiceKey closer than the camera can focus on it.
    const {showBoxOverlay = mediaStreamState.supportsFixedFocus} = this.props;
    const track = mediaStreamState.mediaStream?.getTracks()[0];
    const aspectRatio = track?.getSettings().aspectRatio ?? 1;
    const {width, height, maxHeight, minHeight} = this.props;
//    console.log(`Rendering CameraCaptureWithOverlay`, height, width, this.props);

    return (
        <>
          <video
            style={
              (width != null) ?
                {width, height: "auto", minHeight, maxHeight} :
              (height != null) ?
                {width: "auto", height} :
              (maxHeight != null && minHeight != null) ?
                {width: "auto", maxHeight, minHeight} :
              (maxHeight != null) ?
                {width: "auto", maxHeight} :
                {width: `100%`, height: "auto"}
              }
              autoPlay={true}
            ref={this.withVideoElementRef}
          />
          { !showBoxOverlay ? null : (
            <MiddleOverlaySquare bounds={videoElementBounds} />
          )}
          <OverlayCanvas
            aspectRatio={aspectRatio}
            bounds={videoElementBounds}
            ref={ e => { this.renderingContext = e?.getContext("2d") ?? undefined; }
          } />
        </>
    );
  }
}

export const CameraCaptureWithOverlay = observer(CameraCaptureWithOverlayComponent);
