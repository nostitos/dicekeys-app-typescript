import { action, makeAutoObservable, observable } from "mobx";
import {
  CAMERA_REQUEST_TIMEOUT_MS,
  CameraAccessException,
  cameraAccessFailureReasonForError,
  stopMediaStream,
  withTimeoutAndLateCleanup,
} from "./CamerasOnThisDevice";
import type {
  Camera,
  CameraAccessFailureReason,
  CamerasOnThisDevice,
} from "./CamerasOnThisDevice";

export class MediaStreamState {
  public _deviceId: string | undefined;
  get deviceId(): string | undefined { return this._deviceId }

  public _mediaStream?: MediaStream;
  get mediaStream(): MediaStream | undefined {
    return this._mediaStream ?? undefined;
  }

  private _supportsFixedFocus: boolean = false;
  get supportsFixedFocus() { return this._supportsFixedFocus }
  private _failureReason?: CameraAccessFailureReason;
  get failureReason(): CameraAccessFailureReason | undefined {
    return this._failureReason;
  }
  private requestGeneration = 0;
  private disposed = false;
  private removeMediaStreamLivenessListeners?: () => void;

  private detachMediaStreamLivenessListeners = (): void => {
    const removeListeners = this.removeMediaStreamLivenessListeners;
    this.removeMediaStreamLivenessListeners = undefined;
    try { removeListeners?.(); } catch {}
  };

  private failActiveMediaStream = action((mediaStream: MediaStream): void => {
    if (this.disposed || this._mediaStream !== mediaStream) return;
    this.requestGeneration += 1;
    this.detachMediaStreamLivenessListeners();
    this._deviceId = undefined;
    this._supportsFixedFocus = false;
    this._mediaStream = undefined;
    this._failureReason = "camera-error";
    stopMediaStream(mediaStream);
  });

  private monitorMediaStreamLiveness = (
    mediaStream: MediaStream,
    videoTrack: MediaStreamTrack,
  ): (() => void) => {
    if (
      typeof mediaStream.addEventListener !== "function" ||
      typeof mediaStream.removeEventListener !== "function" ||
      typeof videoTrack.addEventListener !== "function" ||
      typeof videoTrack.removeEventListener !== "function"
    ) {
      throw new CameraAccessException("camera-error");
    }
    const onInactive = (): void => this.failActiveMediaStream(mediaStream);
    const onEnded = (): void => this.failActiveMediaStream(mediaStream);
    mediaStream.addEventListener("inactive", onInactive);
    try {
      videoTrack.addEventListener("ended", onEnded);
    } catch (error) {
      try { mediaStream.removeEventListener("inactive", onInactive); } catch {}
      throw error;
    }
    return () => {
      try { mediaStream.removeEventListener("inactive", onInactive); } catch {}
      try { videoTrack.removeEventListener("ended", onEnded); } catch {}
    };
  };

  activate = action((): void => {
    if (!this.disposed) return;
    this.disposed = false;
    this.requestGeneration += 1;
    this._failureReason = undefined;
  });

  private beginRequest = action((): number | undefined => {
    if (this.disposed) return;
    this._failureReason = undefined;
    return ++this.requestGeneration;
  });

  clear = action (() => {
    this.requestGeneration += 1;
    const mediaStream = this._mediaStream;
    // if (mediaStream == null) {
    //   console.log(`mediaStreamState.clear() with null media stream`);
    // }
    this._deviceId = undefined;
    this._supportsFixedFocus = false;
    this._failureReason = undefined;
    this._mediaStream = undefined;
    this.detachMediaStreamLivenessListeners();
    stopMediaStream(mediaStream);
  });

  dispose = action((): void => {
    if (this.disposed && this._mediaStream == null) return;
    this.disposed = true;
    this.requestGeneration += 1;
    const mediaStream = this._mediaStream;
    this._deviceId = undefined;
    this._supportsFixedFocus = false;
    this._failureReason = undefined;
    this._mediaStream = undefined;
    this.detachMediaStreamLivenessListeners();
    stopMediaStream(mediaStream);
  });

  private setDeviceIdAndMediaStream = action ((
    deviceId: string,
    mediaStream: MediaStream,
    supportsFixedFocus: boolean,
    removeLivenessListeners: () => void,
  ) => {
    if (this._mediaStream === mediaStream) {
      removeLivenessListeners();
      return;
    }
    const previousMediaStream = this._mediaStream;
    this.detachMediaStreamLivenessListeners();
    this._deviceId = deviceId;
    this._mediaStream = mediaStream;
    this._supportsFixedFocus = supportsFixedFocus;
    this._failureReason = undefined;
    this.removeMediaStreamLivenessListeners = removeLivenessListeners;
    stopMediaStream(previousMediaStream);
    // console.log(`Media stream set to`, this._mediaStream);
  });

  get defaultDevice(): Camera | undefined { return this.camerasOnThisDevice.cameras[0] }

  setCamera = async(camera: Camera): Promise<void> => {
    const requestGeneration = this.beginRequest();
    if (requestGeneration == null) return;
    let mediaStream: MediaStream | undefined;
    try {
      const {deviceId, capabilities} = camera;
      const minFocusDistance = capabilities?.focusDistance?.min;
      const supportsFixedFocus = typeof minFocusDistance === "number" &&
        Number.isFinite(minFocusDistance) &&
        (capabilities?.focusMode ?? []).includes("manual");
      const focusConstraints: MediaTrackConstraints = supportsFixedFocus ? {
        advanced: [{
          focusMode: "manual",
          focusDistance: {
            ideal: minFocusDistance,
            max: minFocusDistance,
          },
        }],
      } : {};
      const mediaTrackConstraints: MediaTrackConstraints = {
        ...this.defaultMediaTrackConstraints,
        ...focusConstraints,
        deviceId: { exact: deviceId },
      };
      if (typeof navigator.mediaDevices?.getUserMedia !== "function") {
        throw new CameraAccessException("camera-error");
      }
      mediaStream = await withTimeoutAndLateCleanup(
        () => navigator.mediaDevices.getUserMedia({ video: mediaTrackConstraints }),
        CAMERA_REQUEST_TIMEOUT_MS,
        stopMediaStream,
      );

      let allTracks: MediaStreamTrack[];
      let videoTracks: MediaStreamTrack[];
      try {
        if (
          typeof mediaStream.getTracks !== "function" ||
          typeof mediaStream.getVideoTracks !== "function"
        ) {
          throw new CameraAccessException("camera-error");
        }
        allTracks = mediaStream.getTracks();
        videoTracks = mediaStream.getVideoTracks();
      } catch {
        throw new CameraAccessException("camera-error");
      }
      const videoTrack = videoTracks?.[0];
      if (
        !Array.isArray(allTracks) ||
        !Array.isArray(videoTracks) ||
        videoTrack == null ||
        !allTracks.includes(videoTrack) ||
        allTracks.some((candidate) => typeof candidate?.stop !== "function") ||
        typeof videoTrack.stop !== "function" ||
        typeof videoTrack.getSettings !== "function" ||
        videoTrack.readyState === "ended"
      ) {
        throw new CameraAccessException("camera-error");
      }
      let returnedDeviceId: string | undefined;
      try {
        returnedDeviceId = videoTrack.getSettings().deviceId;
      } catch {
        throw new CameraAccessException("camera-error");
      }
      if (returnedDeviceId !== deviceId) {
        throw new CameraAccessException("camera-error");
      }
      if (this.disposed || requestGeneration !== this.requestGeneration) {
        stopMediaStream(mediaStream);
        return;
      }
      const removeLivenessListeners = this.monitorMediaStreamLiveness(
        mediaStream,
        videoTrack,
      );
      if (this.disposed || requestGeneration !== this.requestGeneration) {
        removeLivenessListeners();
        stopMediaStream(mediaStream);
        return;
      }
      this.setDeviceIdAndMediaStream(
        deviceId,
        mediaStream,
        supportsFixedFocus,
        removeLivenessListeners,
      );
    } catch (error) {
      stopMediaStream(mediaStream);
      if (this.disposed || requestGeneration !== this.requestGeneration) return;
      const reason = cameraAccessFailureReasonForError(error);
      action(() => { this._failureReason = reason; })();
      throw new CameraAccessException(reason);
    }
  }

  setDeviceId = async (deviceId?: string) => {
    if (deviceId == null) {
      this.clear();
      return;
    }
    const camera = this.camerasOnThisDevice.camerasByDeviceId.get(deviceId);
    if (camera != null) {
      // console.log("Setting camera with capabilities ", {...camera.capabilities}, JSON.stringify(camera.capabilities))
      await this.setCamera(camera);
    }
  }

  constructor(readonly camerasOnThisDevice: CamerasOnThisDevice, readonly defaultMediaTrackConstraints: MediaTrackConstraints) {
    makeAutoObservable(this, {
      camerasOnThisDevice: false,
      defaultMediaTrackConstraints: false,
      _mediaStream: observable.ref,
    });
    // console.log(`new MediaStreamState created`);
  }

}
