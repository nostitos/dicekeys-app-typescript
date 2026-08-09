import { action, makeAutoObservable, observable } from "mobx";
import type { Camera, CamerasOnThisDevice } from "./CamerasOnThisDevice";

export class MediaStreamState {
  public _deviceId: string | undefined;
  get deviceId(): string | undefined { return this._deviceId }

  public _mediaStream?: MediaStream;
  get mediaStream(): MediaStream | undefined {
    return this._mediaStream ?? undefined;
  }

  private _supportsFixedFocus: boolean = false;
  get supportsFixedFocus() { return this._supportsFixedFocus }
  private requestGeneration = 0;
  private disposed = false;

  private stopMediaStream = (mediaStream?: MediaStream): void => {
    if (mediaStream == null) return;
    const tracks = new Set<MediaStreamTrack>();
    try { mediaStream.getTracks().forEach((track) => tracks.add(track)); } catch {}
    try { mediaStream.getVideoTracks().forEach((track) => tracks.add(track)); } catch {}
    tracks.forEach((track) => {
      try { track.stop(); } catch {}
    });
    try {mediaStream.stop()} catch {}
  };

  activate = action((): void => {
    if (!this.disposed) return;
    this.disposed = false;
    this.requestGeneration += 1;
  });

  private beginRequest = action((): number | undefined => {
    if (this.disposed) return;
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
    this._mediaStream = undefined;
    this.stopMediaStream(mediaStream);
  });

  dispose = action((): void => {
    if (this.disposed && this._mediaStream == null) return;
    this.disposed = true;
    this.requestGeneration += 1;
    const mediaStream = this._mediaStream;
    this._deviceId = undefined;
    this._supportsFixedFocus = false;
    this._mediaStream = undefined;
    this.stopMediaStream(mediaStream);
  });

  private setDeviceIdAndMediaStream = action ((deviceId: string, mediaStream: MediaStream, supportsFixedFocus: boolean) => {
    if (this._mediaStream === mediaStream) return;
    const previousMediaStream = this._mediaStream;
    this._deviceId = deviceId;
    this._mediaStream = mediaStream;
    this._supportsFixedFocus = supportsFixedFocus;
    this.stopMediaStream(previousMediaStream);
    // console.log(`Media stream set to`, this._mediaStream);
  });

  get defaultDevice(): Camera | undefined { return this.camerasOnThisDevice.cameras[0] }

  setCamera = async(camera: Camera) => {
    const requestGeneration = this.beginRequest();
    if (requestGeneration == null) return;
    const {deviceId, capabilities} = camera;
    // Test if the camera supports manual focus and, if set, set focal distance to up-close
    const minFocusDistance = capabilities?.focusDistance?.min;
    const supportsFixedFocus = minFocusDistance != null && 
      (capabilities?.focusMode ?? []).indexOf("manual") !== -1;
    const focusConstraints = supportsFixedFocus && minFocusDistance == null ? {} : {
      advanced: [{focusMode: "manual", focusDistance: {ideal: minFocusDistance, max: minFocusDistance}}]
    }
    const mediaTrackConstraints: MediaTrackConstraints = {
      ...this.defaultMediaTrackConstraints,
      ...focusConstraints,
      deviceId,
    };
    const mediaStream = await (async () => {
      try {
        return await navigator.mediaDevices.getUserMedia({video: mediaTrackConstraints});
      } catch (e) {
        if (e instanceof OverconstrainedError) {
          console.log("Camera Overconstrained", deviceId, mediaTrackConstraints);
        }
        throw e;
    }})();
    if (this.disposed || requestGeneration !== this.requestGeneration) {
      this.stopMediaStream(mediaStream);
      return;
    }
    // console.log("Camera selected", mediaStream.getTracks()[0]?.getSettings());
    this.setDeviceIdAndMediaStream(deviceId, mediaStream, supportsFixedFocus);
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
