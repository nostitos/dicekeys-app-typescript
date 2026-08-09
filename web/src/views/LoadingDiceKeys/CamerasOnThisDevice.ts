import { Exceptions } from "@dicekeys/dicekeys-api-js";
import { makeAutoObservable, ObservableMap, runInAction } from "mobx";

export const CAMERA_REQUEST_TIMEOUT_MS = 5000;
export const CAMERA_ENUMERATION_TIMEOUT_MS = 20000;

export const videoConstraintsForDevice = (
  deviceId: string,
): MediaTrackConstraints => {
  // An empty device id is the pre-permission placeholder exposed by some
  // browsers. It is never a stable camera identity and must not become an
  // `exact` constraint or a key in the camera inventory.
  if (deviceId.trim().length === 0) {
    throw new CameraAccessException("camera-error");
  }
  return { deviceId: { exact: deviceId } };
};

export class TimeoutException extends Exceptions.NamedException {}

export type CameraAccessFailureReason =
  | "permission-denied"
  | "timeout"
  | "no-camera"
  | "no-suitable-camera"
  | "camera-error";

export type CameraDiscoveryStatus =
  | "discovering"
  | "ready"
  | CameraAccessFailureReason
  | "disposed";

export class CameraAccessException extends Error {
  public constructor(public readonly reason: CameraAccessFailureReason) {
    super(reason);
    this.name = "CameraAccessException";
  }
}

const errorName = (error: unknown): string | undefined => {
  try {
    return typeof error === "object" && error != null && "name" in error &&
        typeof error.name === "string"
      ? error.name
      : undefined;
  } catch {
    return undefined;
  }
};

export const cameraAccessFailureReasonForError = (
  error: unknown,
): CameraAccessFailureReason => {
  if (error instanceof CameraAccessException) return error.reason;
  if (error instanceof TimeoutException || errorName(error) === "TimeoutException") {
    return "timeout";
  }
  switch (errorName(error)) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "permission-denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "no-camera";
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "no-suitable-camera";
    default:
      return "camera-error";
  }
};

/** Stop every track reachable from a possibly malformed stream. */
export const stopMediaStream = (mediaStream: unknown): void => {
  if (mediaStream == null || typeof mediaStream !== "object") return;
  const stream = mediaStream as Partial<MediaStream> & { stop?: () => void };
  const tracks = new Set<MediaStreamTrack>();
  try { stream.getTracks?.().forEach((track) => tracks.add(track)); } catch {}
  try { stream.getVideoTracks?.().forEach((track) => tracks.add(track)); } catch {}
  tracks.forEach((track) => {
    try { track.stop(); } catch {}
  });
  try { stream.stop?.(); } catch {}
};

/**
 * Reject after a bounded wait while still observing the original operation.
 * A late result is handed to the caller-provided cleanup instead of being lost.
 */
export const withTimeoutAndLateCleanup = <T,>(
  operation: () => Promise<T>,
  timeoutInMs: number,
  cleanupLateResult: (result: T) => void = () => undefined,
): Promise<T> => new Promise<T>((resolve, reject) => {
  let settled = false;
  const timeout = setTimeout(() => {
    settled = true;
    reject(new TimeoutException("Timeout"));
  }, timeoutInMs);

  let operationPromise: Promise<T>;
  try {
    operationPromise = operation();
  } catch (error) {
    settled = true;
    clearTimeout(timeout);
    reject(error);
    return;
  }

  void Promise.resolve(operationPromise).then((result) => {
    if (settled) {
      try { cleanupLateResult(result); } catch {}
      return;
    }
    settled = true;
    clearTimeout(timeout);
    resolve(result);
  }, (error: unknown) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    reject(error);
  });
});

export type Camera = MediaDeviceInfo & MediaTrackSettings & {
  name: string;
  capabilities: MediaTrackCapabilities | undefined;
};

const rearDirectionNamesLc = ["environment", "rear", "back"];
const frontDirectionNamesLc = ["user", "front", "forward", "display"];
const lcStrContainsCandidate = (...lcCandidates: string[]) => (
  searchIn: string,
): boolean => {
  const lcSearchIn = searchIn.toLocaleLowerCase();
  return lcCandidates.some((lcCandidate) => lcSearchIn.includes(lcCandidate));
};
const containsRearDirectionName = lcStrContainsCandidate(...rearDirectionNamesLc);
const containsFrontDirectionName = lcStrContainsCandidate(...frontDirectionNamesLc);
const containsDirectionName = lcStrContainsCandidate(
  ...frontDirectionNamesLc,
  ...rearDirectionNamesLc,
);

const getDirectionScore = ({ facingMode, label }: Camera): number =>
  facingMode === "environment" || containsRearDirectionName(label) ? -1 :
  facingMode === "user" || containsFrontDirectionName(label) ? 1 : 0;

const getResolutionCapabilitiesScore = ({ capabilities }: Camera): number =>
  capabilities?.width?.max != null && capabilities.height?.max != null
    ? -capabilities.width.max * capabilities.height.max
    : 0;

const compareCameras = (left: Camera, right: Camera): number => {
  const byDirectionScore = getDirectionScore(left) - getDirectionScore(right);
  if (byDirectionScore !== 0) return byDirectionScore;
  const byResolutionCapabilitiesScore =
    getResolutionCapabilitiesScore(left) - getResolutionCapabilitiesScore(right);
  if (byResolutionCapabilitiesScore !== 0) {
    return byResolutionCapabilitiesScore;
  }
  return left.label.localeCompare(right.label ?? "");
};

const getCurrentMediaDevices = (): MediaDevices | undefined => {
  try {
    return typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  } catch {
    return undefined;
  }
};

const videoDevicesFrom = (
  mediaDevices: readonly MediaDeviceInfo[],
): MediaDeviceInfo[] => mediaDevices.filter(({ kind }) =>
  kind.toLocaleLowerCase().startsWith("video"));

const stableVideoDevicesFrom = (
  mediaDevices: readonly MediaDeviceInfo[],
): MediaDeviceInfo[] => videoDevicesFrom(mediaDevices)
  .filter(({ deviceId }) => deviceId.trim().length > 0);

const videoInventoryKeyFor = (
  videoDevices: readonly MediaDeviceInfo[],
): string => JSON.stringify(
  videoDevices
    .map(({ deviceId, kind }) => [kind, deviceId] as const)
    .sort(([leftKind, leftId], [rightKind, rightId]) =>
      leftKind.localeCompare(rightKind) || leftId.localeCompare(rightId)),
);

/** One camera inventory owned by one mounted scanner attempt. */
export class CamerasOnThisDevice {
  /**
   * Retains the historical factory name, but intentionally returns a fresh,
   * disposable inventory for each mounted scanner attempt.
   */
  public static instance(
    minWidth: number | undefined,
    minHeight: number | undefined,
  ): CamerasOnThisDevice {
    return new CamerasOnThisDevice(minWidth, minHeight);
  }

  public readonly camerasToBeAdded =
    new ObservableMap<string, MediaDeviceInfo>();
  public readonly camerasByDeviceId = new ObservableMap<string, Camera>();
  public readonly unreadableCameraDevices = new ObservableMap<string, {
    cameraDevice: MediaDeviceInfo;
    exceptions: unknown[];
  }>();

  private readonly cameraDeviceIdToCameraNumber =
    new ObservableMap<string, number>();
  private discoveryGeneration = 0;
  private deviceChangeGeneration = 0;
  private disposed = false;
  private listeningForDeviceChanges = false;
  private videoInventoryKey?: string;
  private permissionBootstrapAttempted = false;
  private _status: CameraDiscoveryStatus = "discovering";

  public get status(): CameraDiscoveryStatus { return this._status; }
  public get ready(): boolean {
    return this._status !== "discovering" && this._status !== "disposed";
  }
  public get readyAndNonEmpty(): boolean {
    return this._status === "ready" && this.cameras.length > 0;
  }

  /**
   * A list sorted by direction (back-facing first), resolution, then label.
   */
  public get cameras(): Camera[] {
    return [...this.camerasByDeviceId.values()]
      .filter((camera) => {
        // Track settings describe only the current mode, not the camera's
        // maximum capability. Unknown maxima remain eligible.
        const width = camera.capabilities?.width?.max;
        const height = camera.capabilities?.height?.max;
        return (height == null || this.minHeight == null || height >= this.minHeight) &&
          (width == null || this.minWidth == null || width >= this.minWidth);
      })
      .sort(compareCameras);
  }

  private constructor(
    public readonly minWidth: number | undefined,
    public readonly minHeight: number | undefined,
  ) {
    makeAutoObservable(this, {
      minWidth: false,
      minHeight: false,
    });
    const mediaDevices = getCurrentMediaDevices();
    if (typeof mediaDevices?.addEventListener === "function") {
      mediaDevices.addEventListener("devicechange", this.handleDeviceChange);
      this.listeningForDeviceChanges = true;
    }
    void this.addAttachedAndRemovedDetachedCameras();
  }

  private handleDeviceChange = (): void => {
    if (!this.disposed) void this.refreshForEffectiveVideoDeviceChange();
  };

  private refreshForEffectiveVideoDeviceChange = async (): Promise<void> => {
    const mediaDevices = getCurrentMediaDevices();
    if (this.disposed || typeof mediaDevices?.enumerateDevices !== "function") {
      return;
    }
    const changeGeneration = ++this.deviceChangeGeneration;
    let allMediaDevices: MediaDeviceInfo[];
    try {
      allMediaDevices = await withTimeoutAndLateCleanup(
        () => mediaDevices.enumerateDevices(),
        CAMERA_ENUMERATION_TIMEOUT_MS,
      );
    } catch {
      // A device-change probe must not tear down a working camera merely
      // because inventory comparison itself was temporarily unavailable.
      return;
    }
    if (
      this.disposed ||
      changeGeneration !== this.deviceChangeGeneration
    ) {
      return;
    }
    const nextVideoInventoryKey = videoInventoryKeyFor(
      videoDevicesFrom(allMediaDevices),
    );
    if (nextVideoInventoryKey === this.videoInventoryKey) return;
    await this.addAttachedAndRemovedDetachedCameras(allMediaDevices);
  };

  private operationIsCurrent = (generation: number): boolean =>
    !this.disposed && generation === this.discoveryGeneration;

  private getCameraNumber = (deviceId: string): number => {
    const existing = this.cameraDeviceIdToCameraNumber.get(deviceId);
    if (existing != null) return existing;
    const cameraNumber = this.cameraDeviceIdToCameraNumber.size + 1;
    this.cameraDeviceIdToCameraNumber.set(deviceId, cameraNumber);
    return cameraNumber;
  };

  /**
   * Clean origins may enumerate a video input before exposing its stable id.
   * Open one generic, bounded stream to resolve the permission decision, stop
   * it immediately, then let the caller enumerate again.
   */
  private bootstrapCameraPermission = async (
    generation: number,
  ): Promise<CameraAccessFailureReason | undefined> => {
    if (this.permissionBootstrapAttempted) return undefined;
    this.permissionBootstrapAttempted = true;
    const mediaDevices = getCurrentMediaDevices();
    if (typeof mediaDevices?.getUserMedia !== "function") {
      return "camera-error";
    }

    let stream: MediaStream | undefined;
    try {
      stream = await withTimeoutAndLateCleanup(
        () => mediaDevices.getUserMedia({ video: true }),
        CAMERA_REQUEST_TIMEOUT_MS,
        stopMediaStream,
      );
      if (!this.operationIsCurrent(generation)) return undefined;

      let allTracks: MediaStreamTrack[];
      let videoTracks: MediaStreamTrack[];
      try {
        if (
          typeof stream.getTracks !== "function" ||
          typeof stream.getVideoTracks !== "function"
        ) {
          throw new CameraAccessException("camera-error");
        }
        allTracks = stream.getTracks();
        videoTracks = stream.getVideoTracks();
      } catch {
        throw new CameraAccessException("camera-error");
      }
      const videoTrack = videoTracks[0];
      if (
        !Array.isArray(allTracks) ||
        !Array.isArray(videoTracks) ||
        videoTrack == null ||
        !allTracks.includes(videoTrack) ||
        allTracks.some((track) => typeof track?.stop !== "function")
      ) {
        throw new CameraAccessException("camera-error");
      }
      return undefined;
    } catch (error) {
      return cameraAccessFailureReasonForError(error);
    } finally {
      stopMediaStream(stream);
    }
  };

  private recordUnreadableCamera = (
    generation: number,
    cameraDevice: MediaDeviceInfo,
    error: unknown,
  ): void => {
    if (!this.operationIsCurrent(generation)) return;
    runInAction(() => {
      this.camerasToBeAdded.delete(cameraDevice.deviceId);
      const existing = this.unreadableCameraDevices.get(cameraDevice.deviceId);
      if (existing == null) {
        this.unreadableCameraDevices.set(cameraDevice.deviceId, {
          cameraDevice,
          exceptions: [error],
        });
      } else {
        existing.exceptions.unshift(error);
      }
    });
  };

  /** Inspect one camera using a temporary stream that is always stopped. */
  public tryAddCamera = async (
    cameraDevice: MediaDeviceInfo,
    generation: number = this.discoveryGeneration,
  ): Promise<Camera | undefined> => {
    let stream: MediaStream | undefined;
    try {
      const mediaDevices = getCurrentMediaDevices();
      if (typeof mediaDevices?.getUserMedia !== "function") {
        throw new CameraAccessException("camera-error");
      }
      stream = await withTimeoutAndLateCleanup(
        () => mediaDevices.getUserMedia({
          video: videoConstraintsForDevice(cameraDevice.deviceId),
        }),
        CAMERA_REQUEST_TIMEOUT_MS,
        stopMediaStream,
      );
      if (!this.operationIsCurrent(generation)) return undefined;

      let allTracks: MediaStreamTrack[];
      let tracks: MediaStreamTrack[];
      try {
        if (
          typeof stream.getTracks !== "function" ||
          typeof stream.getVideoTracks !== "function"
        ) {
          throw new CameraAccessException("camera-error");
        }
        allTracks = stream.getTracks();
        tracks = stream.getVideoTracks();
      } catch {
        throw new CameraAccessException("camera-error");
      }
      const track = tracks?.[0];
      if (
        !Array.isArray(allTracks) ||
        !Array.isArray(tracks) ||
        track == null ||
        !allTracks.includes(track) ||
        allTracks.some((candidate) => typeof candidate?.stop !== "function") ||
        typeof track.stop !== "function" ||
        typeof track.getSettings !== "function"
      ) {
        throw new CameraAccessException("camera-error");
      }

      let settings: MediaTrackSettings;
      let capabilities: MediaTrackCapabilities | undefined;
      try {
        settings = track.getSettings();
        capabilities = track.getCapabilities?.();
      } catch {
        throw new CameraAccessException("camera-error");
      }
      if (settings == null || typeof settings !== "object") {
        throw new CameraAccessException("camera-error");
      }
      if (settings.deviceId !== cameraDevice.deviceId) {
        throw new CameraAccessException("camera-error");
      }

      const { label, facingMode } = {
        label: cameraDevice.label,
        facingMode: settings.facingMode,
      };
      const width = capabilities?.width?.max;
      const height = capabilities?.height?.max;
      const directionPrefix = containsDirectionName(label) ? "" :
        facingMode === "user" ? "Front Facing " :
        facingMode === "environment" ? "Rear Facing " : "";
      const identifier = label ||
        `Camera ${this.getCameraNumber(cameraDevice.deviceId)}`;
      const resolution = width != null && height != null &&
          !(width === 640 && height === 480)
        ? ` ${width}x${height} `
        : "";
      const camera = {
        ...settings,
        deviceId: cameraDevice.deviceId,
        groupId: cameraDevice.groupId,
        kind: cameraDevice.kind,
        label,
        toJSON: () => cameraDevice.toJSON?.() ?? {},
        capabilities,
        name: directionPrefix + identifier + resolution,
      } as Camera;

      if (!this.operationIsCurrent(generation)) return undefined;
      runInAction(() => {
        this.camerasToBeAdded.delete(camera.deviceId);
        this.unreadableCameraDevices.delete(camera.deviceId);
        this.camerasByDeviceId.set(camera.deviceId, camera);
      });
      return camera;
    } catch (error) {
      this.recordUnreadableCamera(generation, cameraDevice, error);
      return undefined;
    } finally {
      stopMediaStream(stream);
    }
  };

  private finalStatusFor = (
    videoDevices: readonly MediaDeviceInfo[],
  ): CameraDiscoveryStatus => {
    if (videoDevices.length === 0) return "no-camera";
    if (this.cameras.length > 0) return "ready";

    const reasons = [...this.unreadableCameraDevices.values()]
      .flatMap(({ exceptions }) => exceptions)
      .map(cameraAccessFailureReasonForError);
    if (reasons.includes("permission-denied")) return "permission-denied";
    if (reasons.includes("timeout")) return "timeout";
    if (reasons.includes("camera-error")) return "camera-error";
    if (reasons.includes("no-camera")) return "no-camera";
    if (reasons.includes("no-suitable-camera")) return "no-suitable-camera";
    if (this.camerasByDeviceId.size > 0) return "no-suitable-camera";
    return "camera-error";
  };

  /** Refresh this attempt's device inventory without leaking late streams. */
  public addAttachedAndRemovedDetachedCameras = async (
    enumeratedMediaDevices?: readonly MediaDeviceInfo[],
  ): Promise<void> => {
    if (this.disposed) return;
    const generation = ++this.discoveryGeneration;
    runInAction(() => {
      this._status = "discovering";
      this.camerasToBeAdded.clear();
      this.unreadableCameraDevices.clear();
    });

    const mediaDevices = getCurrentMediaDevices();
    if (typeof mediaDevices?.enumerateDevices !== "function") {
      if (this.operationIsCurrent(generation)) {
        runInAction(() => { this._status = "camera-error"; });
      }
      return;
    }

    let allMediaDevices: readonly MediaDeviceInfo[];
    if (enumeratedMediaDevices == null) {
      try {
        allMediaDevices = await withTimeoutAndLateCleanup(
          () => mediaDevices.enumerateDevices(),
          CAMERA_ENUMERATION_TIMEOUT_MS,
        );
      } catch (error) {
        if (this.operationIsCurrent(generation)) {
          runInAction(() => {
            this._status = cameraAccessFailureReasonForError(error);
          });
        }
        return;
      }
    } else {
      allMediaDevices = enumeratedMediaDevices;
    }
    if (!this.operationIsCurrent(generation)) return;

    let videoDevices = videoDevicesFrom(allMediaDevices);
    this.videoInventoryKey = videoInventoryKeyFor(videoDevices);

    if (
      videoDevices.length > 0 &&
      stableVideoDevicesFrom(videoDevices).length !== videoDevices.length
    ) {
      const bootstrapFailure = await this.bootstrapCameraPermission(generation);
      if (!this.operationIsCurrent(generation)) return;
      if (bootstrapFailure != null) {
        runInAction(() => { this._status = bootstrapFailure; });
        return;
      }
      try {
        allMediaDevices = await withTimeoutAndLateCleanup(
          () => mediaDevices.enumerateDevices(),
          CAMERA_ENUMERATION_TIMEOUT_MS,
        );
      } catch (error) {
        if (this.operationIsCurrent(generation)) {
          runInAction(() => {
            this._status = cameraAccessFailureReasonForError(error);
          });
        }
        return;
      }
      if (!this.operationIsCurrent(generation)) return;
      videoDevices = videoDevicesFrom(allMediaDevices);
      this.videoInventoryKey = videoInventoryKeyFor(videoDevices);
    }

    const stableVideoDevices = stableVideoDevicesFrom(videoDevices);
    if (videoDevices.length > 0 && stableVideoDevices.length === 0) {
      runInAction(() => {
        this.camerasToBeAdded.clear();
        this.camerasByDeviceId.clear();
        this.unreadableCameraDevices.clear();
        this._status = "camera-error";
      });
      return;
    }
    const currentDeviceIds = new Set(
      stableVideoDevices.map(({ deviceId }) => deviceId),
    );
    runInAction(() => {
      [...this.camerasByDeviceId.keys()]
        .filter((deviceId) => !currentDeviceIds.has(deviceId))
        .forEach((deviceId) => this.camerasByDeviceId.delete(deviceId));
      stableVideoDevices
        .filter(({ deviceId }) => !this.camerasByDeviceId.has(deviceId))
        .forEach((camera) => this.camerasToBeAdded.set(camera.deviceId, camera));
    });

    const camerasToInspect = [...this.camerasToBeAdded.values()];
    await Promise.all(
      camerasToInspect.map((camera) =>
        this.tryAddCamera(camera, generation)),
    );
    // Some browsers/devices reject simultaneous camera opens. Retry only the
    // failed inspections sequentially before fixing the discovery outcome.
    for (const camera of camerasToInspect) {
      if (!this.operationIsCurrent(generation)) return;
      const firstFailureReasons = this.unreadableCameraDevices
        .get(camera.deviceId)?.exceptions
        .map(cameraAccessFailureReasonForError) ?? [];
      if (
        !this.camerasByDeviceId.has(camera.deviceId) &&
        firstFailureReasons.includes("camera-error")
      ) {
        await this.tryAddCamera(camera, generation);
      }
    }
    if (!this.operationIsCurrent(generation)) return;
    runInAction(() => {
      this._status = this.finalStatusFor(stableVideoDevices);
    });
  };

  public dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.discoveryGeneration += 1;
    this.deviceChangeGeneration += 1;
    const mediaDevices = getCurrentMediaDevices();
    if (
      this.listeningForDeviceChanges &&
      typeof mediaDevices?.removeEventListener === "function"
    ) {
      try {
        mediaDevices.removeEventListener("devicechange", this.handleDeviceChange);
      } catch {}
    }
    this.listeningForDeviceChanges = false;
    this.camerasToBeAdded.clear();
    this.camerasByDeviceId.clear();
    this.unreadableCameraDevices.clear();
    this.cameraDeviceIdToCameraNumber.clear();
    this.videoInventoryKey = undefined;
    this.permissionBootstrapAttempted = true;
    this._status = "disposed";
  };
}
