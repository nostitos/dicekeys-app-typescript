import { observer } from "mobx-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import styled from "styled-components";
import { CameraCaptureWithOverlay } from "./CameraCaptureWithOverlay";
import {
  DiceKeyFrameProcessorState,
  scannerAttemptKeyForMode,
  type DiceKeyScannerMode,
} from "./DiceKeyFrameProcessorState";
import { createDiceKeyFrameWorkerClient } from "./process-dicekey-image-frame";
import { CamerasOnThisDevice } from "./CamerasOnThisDevice";
import type {
  CameraAccessFailureReason,
  CameraDiscoveryStatus,
} from "./CamerasOnThisDevice";
import { MediaStreamState } from "./MediaStreamState";
import { CameraSelectionView } from "./CameraSelectionView";
import { PushButton } from "../../css/Button";
import { CenteredControls } from "../../views/basics";
import {
  FullScreenNotification,
  FullScreenNotificationContent,
  FullScreenNotificationPrimaryText,
  FullScreenNotificationSecondaryText,
} from "../../css/FullScreenNotification";
import { DiceKeyAnimationRotationProps } from "../../views/SVG/DiceKeyView";
import type { DiceKeyWithoutKeyId } from "../../dicekeys/DiceKey";
import { ScannerAttemptLifecycle } from "./wallet-recovery-scanner-attempt-lifecycle";
import type { WalletRecoveryScanResult } from "./wallet-recovery-scanner-policy";
import {
  createWalletRecoveryScannerAcquisitionHandle,
  createWalletRecoveryScannerAttemptFailure,
  scannerResultForAcquisition,
  scannerCandidateToSanitizedAcquisition,
  type WalletRecoveryScannerAcquisitionHandle,
  type WalletRecoveryScannerResult,
  type WalletRecoveryScannerTerminal,
} from "./wallet-recovery-scanner-acquisition";
import { wipeScannerFaceImageResponse } from "./wallet-recovery-scanner-worker-session-handler";

const minCameraWidth = 1024;
const minCameraHeight = 720;

/** Independent of camera-open and worker readiness/response deadlines. */
export const WALLET_RECOVERY_FIRST_FRAME_TIMEOUT_MS = 10_000;
export const WALLET_RECOVERY_NEXT_FRAME_TIMEOUT_MS = 5_000;

const defaultMediaTrackConstraints: MediaTrackConstraints = {
  width: {
//          ideal: Math.min(camera.capabilities?.width?.max ?? defaultCameraDimensions.width, defaultCameraDimensions.width),
//    max: 1280,
    ideal: 1024,
//    min: minCameraWidth,
  },
  height: {
//          ideal: Math.min(camera.capabilities?.height?.max ?? defaultCameraDimensions.height, defaultCameraDimensions.height),
//    max: 1280,
//    minCameraHeight,
    ideal: 1024,
  },
  aspectRatio: {ideal: 1}
};

export interface OnDiceKeyRead {
  onDiceKeyRead?: (diceKey?: DiceKeyWithoutKeyId) => void
}

//export interface ScanDiceKeyViewProps extends Omit<CameraCaptureWithOverlayProperties, "cameras" | "mediaStreamState">, DiceKeyAnimationRotationProps {
interface ScanDiceKeyViewBaseProps extends OnDiceKeyRead, DiceKeyAnimationRotationProps {
  height: string;
  showBoxOverlay?: boolean;
  /** Called after the scanner has already started a fresh local attempt. */
  onRetry?: () => void;
}

interface LegacyScanDiceKeyViewProps extends ScanDiceKeyViewBaseProps {
  /** Wallet recovery must be selected explicitly; legacy behavior is default. */
  scanMode?: "legacy";
  editManually?: () => void;
  onExit?: () => void;
  onWalletRecoveryAttemptStarted?: never;
  onWalletRecoveryScan?: (
    result: WalletRecoveryScannerResult,
    terminal?: WalletRecoveryScannerTerminal,
  ) => void;
}

interface WalletRecoveryScanDiceKeyViewProps extends ScanDiceKeyViewBaseProps {
  scanMode: "wallet-recovery";
  /** Wallet recovery cannot offer the legacy manual-entry bypass. */
  editManually?: never;
  /** Required so every camera-blocked state has a functional exit. */
  onExit: () => void;
  /** Registers the stable cleanup settlement for this committed attempt. */
  onWalletRecoveryAttemptStarted: (
    handle: WalletRecoveryScannerAcquisitionHandle,
  ) => boolean;
  onWalletRecoveryScan?: (
    result: WalletRecoveryScannerResult,
    terminal?: WalletRecoveryScannerTerminal,
  ) => void;
}

export type ScanDiceKeyViewProps =
  | LegacyScanDiceKeyViewProps
  | WalletRecoveryScanDiceKeyViewProps;

type CameraBlockedStatus = Exclude<
  CameraDiscoveryStatus,
  "ready" | "disposed"
>;

const cameraStatusCopy: Readonly<Record<CameraBlockedStatus, {
  heading: string;
  detail: string;
}>> = Object.freeze({
  discovering: {
    heading: "Camera access needed",
    detail: "Allow camera access when prompted while this scanner is open.",
  },
  "permission-denied": {
    heading: "Camera permission denied",
    detail: "Allow camera access in your browser or system settings, then retry.",
  },
  timeout: {
    heading: "Camera setup timed out",
    detail: "No camera was opened. Check the permission prompt and retry.",
  },
  "no-camera": {
    heading: "No camera found",
    detail: "Connect a camera, then retry.",
  },
  "no-suitable-camera": {
    heading: "No compatible camera found",
    detail: `A camera of at least ${minCameraWidth} by ${minCameraHeight} pixels is required.`,
  },
  "camera-error": {
    heading: "Camera could not be started",
    detail: "The camera may be unavailable or in use by another application. Retry when it is available.",
  },
});

const WalletScannerShell = styled.div<{ $hasCameraSelection: boolean }>`
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: ${({ $hasCameraSelection }) =>
    $hasCameraSelection ? "minmax(0, 1fr) auto" : "minmax(0, 1fr)"};
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: #f8fafc;
  background: #111827;
`;

const WalletScannerPreview = styled.div`
  display: grid;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
`;

const WalletScannerReadyStatus = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
`;

const WalletScannerControls = styled.div`
  position: relative;
  z-index: 20;
  box-sizing: border-box;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  width: 100%;
  min-width: 0;
  min-height: 3rem;
  padding: 0.55rem 0.75rem;
  color: #f8fafc;
  background: rgba(17, 24, 39, 0.96);
  border-top: 1px solid rgba(255, 255, 255, 0.32);

  > div {
    box-sizing: border-box;
    display: flex;
    width: 100%;
    min-width: 0;
    flex: 0 1 auto;
    flex-wrap: wrap;
    gap: 0.35rem 0.55rem;
  }

  label {
    flex: 0 0 auto;
    font-weight: 700;
  }

  select {
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    min-height: 2rem;
    flex: 1 1 20rem;
    color: #111827;
  }
`;

const WalletCameraBlockedPanel = styled.div`
  box-sizing: border-box;
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  align-items: center;
  justify-content: center;
  padding: clamp(0.75rem, 4%, 1.5rem);
  color: #f8fafc;
  background: #111827;
`;

const WalletCameraBlockedContent = styled.div`
  box-sizing: border-box;
  display: flex;
  width: min(100%, 32rem);
  max-height: 100%;
  overflow: auto;
  flex-direction: column;
  padding: clamp(0.8rem, 4%, 1.35rem);
  gap: 0.75rem;
  color: #111827;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.42);
  border-radius: 0.4rem;
  box-shadow: 0 0.55rem 1.4rem rgba(0, 0, 0, 0.28);

  h2,
  p {
    margin: 0;
  }

  h2 {
    font-size: clamp(1.05rem, 4.5vw, 1.45rem);
    line-height: 1.15;
  }

  p {
    font-size: clamp(0.88rem, 3.25vw, 1rem);
    line-height: 1.4;
  }
`;

const WalletCameraBlockedActions = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.6rem;

  button {
    min-height: 2.5rem;
  }
`;

const CameraBlockedView = ({
  status,
  scanMode,
  editManually,
  onExit,
  onRetry,
}: {
  status: CameraBlockedStatus;
  scanMode?: DiceKeyScannerMode;
  editManually?: () => void;
  onExit?: () => void;
  onRetry: () => void;
}) => {
  const headingId = React.useId();
  const detailId = React.useId();
  const isDiscovering = status === "discovering";
  const copy = cameraStatusCopy[status];
  const isWalletRecovery = scanMode === "wallet-recovery";
  const liveRegionProperties = {
    role: isDiscovering ? "status" : "alert",
    "aria-live": isDiscovering ? "polite" : "assertive",
    "aria-busy": isDiscovering ? "true" : undefined,
    "aria-labelledby": headingId,
    "aria-describedby": detailId,
  } as const;

  if (isWalletRecovery) {
    return (
      <WalletCameraBlockedPanel
        {...liveRegionProperties}
        data-wallet-camera-blocked-panel={status}
      >
        <WalletCameraBlockedContent>
          <h2 id={headingId}>{copy.heading}</h2>
          <p id={detailId}>{copy.detail}</p>
          <WalletCameraBlockedActions>
            {isDiscovering ? null : (
              <PushButton onClick={onRetry}>Retry camera</PushButton>
            )}
            <PushButton onClick={onExit}>Exit recovery</PushButton>
          </WalletCameraBlockedActions>
        </WalletCameraBlockedContent>
      </WalletCameraBlockedPanel>
    );
  }

  return (
    <FullScreenNotification
      {...liveRegionProperties}
    >
      <FullScreenNotificationContent>
        <FullScreenNotificationPrimaryText as="h2" id={headingId}>
          {copy.heading}
        </FullScreenNotificationPrimaryText>
        <FullScreenNotificationSecondaryText as="p" id={detailId}>
          {copy.detail}
        </FullScreenNotificationSecondaryText>
        <CenteredControls>
          {isDiscovering ? null : (
            <PushButton onClick={onRetry}>Retry camera</PushButton>
          )}
          {editManually == null ? null : (
            <PushButton onClick={editManually}>Enter manually instead</PushButton>
          )}
        </CenteredControls>
      </FullScreenNotificationContent>
    </FullScreenNotification>
  );
};

const unmountScannerAttemptWithoutUnhandledRejection = (
  scannerAttempt: ScannerAttemptLifecycle,
): void => {
  try {
    void scannerAttempt.unmount().catch(() => {});
  } catch {}
};

export const beginScannerAttemptDisposal = (
  scannerAttempt: ScannerAttemptLifecycle,
  frameProcessorState: DiceKeyFrameProcessorState,
  mediaStreamState: MediaStreamState,
  disposeCapture?: () => void,
): Promise<void> => {
  let synchronousCleanupError: unknown;
  try {
    disposeCapture?.();
  } catch (error) {
    synchronousCleanupError = error;
  }
  try {
    frameProcessorState.dispose();
  } catch (error) {
    synchronousCleanupError = error;
  }
  try {
    mediaStreamState.dispose();
  } catch (error) {
    synchronousCleanupError ??= error;
  }
  let workerCleanup: Promise<void>;
  try {
    // unmount() drops the client synchronously before returning its settlement.
    workerCleanup = scannerAttempt.unmount();
  } catch (error) {
    workerCleanup = Promise.reject(error);
  }
  return workerCleanup.then(() => {
    if (synchronousCleanupError != null) throw synchronousCleanupError;
  });
};

const failWalletScannerAttempt = ({
  attemptId,
  scannerAttempt,
  walletAttemptHandle,
  onWalletAttemptCompleted,
  onWalletRecoveryScan,
}: {
  attemptId: string | undefined;
  scannerAttempt: ScannerAttemptLifecycle;
  walletAttemptHandle: WalletRecoveryScannerAcquisitionHandle | undefined;
  onWalletAttemptCompleted: () => void;
  onWalletRecoveryScan?: ScanDiceKeyViewProps["onWalletRecoveryScan"];
}): void => {
  if (
    attemptId == null ||
    scannerAttempt.acquisitionId !== attemptId ||
    walletAttemptHandle?.acquisitionId !== attemptId
  ) {
    return;
  }
  // Inert every scanner owner before exposing the fixed failure or its
  // attempt-bound cleanup settlement to caller-controlled code.
  walletAttemptHandle.dispose();
  onWalletAttemptCompleted();
  onWalletRecoveryScan?.(
    createWalletRecoveryScannerAttemptFailure(attemptId),
    walletAttemptHandle,
  );
};

export const mountScannerAttemptWithCleanup = (
  scannerAttempt: ScannerAttemptLifecycle,
  frameProcessorState: DiceKeyFrameProcessorState,
  mediaStreamState: MediaStreamState,
  disposeCapture?: () => void,
): void => {
  try {
    scannerAttempt.mount();
  } catch (error) {
    try { disposeCapture?.(); } catch {}
    frameProcessorState.dispose();
    mediaStreamState.dispose();
    unmountScannerAttemptWithoutUnhandledRejection(scannerAttempt);
    throw error;
  }
};

export const processCapturedFrameForScannerAttempt = async ({
  framesImageData,
  canvasRenderingContext,
  scanMode,
  scannerAttempt,
  frameProcessorState,
  mediaStreamState,
  onWalletAttemptCompleted,
  disposeCapture,
  onWalletRecoveryScan,
  walletAttemptHandle,
}: {
  framesImageData: ImageData;
  canvasRenderingContext: CanvasRenderingContext2D;
  scanMode?: DiceKeyScannerMode;
  scannerAttempt: ScannerAttemptLifecycle;
  frameProcessorState: DiceKeyFrameProcessorState;
  mediaStreamState: MediaStreamState;
  onWalletAttemptCompleted: () => void;
  disposeCapture?: () => void;
  onWalletRecoveryScan?: ScanDiceKeyViewProps["onWalletRecoveryScan"];
  walletAttemptHandle?: WalletRecoveryScannerAcquisitionHandle;
}): Promise<void> => {
  // Cleanup ownership is carried by walletAttemptHandle. These legacy helper
  // parameters remain accepted for callers exercising non-wallet behavior.
  void mediaStreamState;
  void disposeCapture;
  const attemptId = scannerAttempt.acquisitionId;
  if (
    scanMode === "wallet-recovery" &&
    (
      attemptId == null ||
      walletAttemptHandle?.acquisitionId !== attemptId
    )
  ) {
    try { framesImageData.data.fill(0); } catch {}
    throw new Error("Wallet scanner attempt handle is missing or stale");
  }
  let response: Awaited<ReturnType<
    ScannerAttemptLifecycle["processDiceKeyImageFrame"]
  >>;
  try {
    response = await scannerAttempt.processDiceKeyImageFrame(framesImageData);
  } catch {
    if (scanMode === "wallet-recovery") {
      failWalletScannerAttempt({
        attemptId,
        scannerAttempt,
        walletAttemptHandle,
        onWalletAttemptCompleted,
        onWalletRecoveryScan,
      });
    }
    return;
  }

  if (
    attemptId == null || scannerAttempt.acquisitionId !== attemptId
  ) {
    wipeScannerFaceImageResponse(response);
    return;
  }

  let responseHasException = false;
  try {
    responseHasException = response.exception != null;
  } catch {
    responseHasException = true;
  }
  if (scanMode === "wallet-recovery" && responseHasException) {
    wipeScannerFaceImageResponse(response);
    failWalletScannerAttempt({
      attemptId,
      scannerAttempt,
      walletAttemptHandle,
      onWalletAttemptCompleted,
      onWalletRecoveryScan,
    });
    return;
  }

  try {
    frameProcessorState.handleProcessedCameraFrame(
      response,
      canvasRenderingContext,
    );
  } catch {
    // Frame conversion and consumer exceptions retain their established
    // handling. Only worker/process promise rejection is an attempt failure.
  } finally {
    if (
      scanMode === "wallet-recovery" &&
      frameProcessorState.scanningSuccessfulEnoughToTerminate
    ) {
      // The stable attempt handle is already registered with the controller,
      // so its cleanup rejection remains observable through that settlement.
      walletAttemptHandle?.dispose();
      onWalletAttemptCompleted();
    }
  }
};

export const deliverWalletRecoveryScannerResult = ({
  result,
  scannerAttempt,
  frameProcessorState,
  mediaStreamState,
  walletAttemptHandle,
  onWalletAttemptCompleted,
  disposeCapture,
  onWalletRecoveryScan,
}: {
  result: WalletRecoveryScanResult;
  scannerAttempt: ScannerAttemptLifecycle;
  frameProcessorState: DiceKeyFrameProcessorState;
  mediaStreamState: MediaStreamState;
  walletAttemptHandle: WalletRecoveryScannerAcquisitionHandle;
  onWalletAttemptCompleted: () => void;
  disposeCapture?: () => void;
  onWalletRecoveryScan?: ScanDiceKeyViewProps["onWalletRecoveryScan"];
}): WalletRecoveryScannerAcquisitionHandle | undefined => {
  // The stable mount-time handle owns these resources; keep the helper's
  // historical arguments source-compatible while callers migrate.
  void frameProcessorState;
  void mediaStreamState;
  void disposeCapture;
  const acquisitionId = scannerAttempt.acquisitionId;
  if (
    acquisitionId == null ||
    walletAttemptHandle.acquisitionId !== acquisitionId
  ) {
    return undefined;
  }
  const correlatedResult = scannerResultForAcquisition(result, acquisitionId);
  if (result.status === "rescan") {
    onWalletRecoveryScan?.(correlatedResult);
    return walletAttemptHandle;
  }
  const acquisition = scannerCandidateToSanitizedAcquisition(
    result,
    walletAttemptHandle,
  );
  // The flow may call dispose again, but the old attempt is already inert and
  // bounded cleanup has already started before this callback can advance it.
  walletAttemptHandle.dispose();
  onWalletAttemptCompleted();
  onWalletRecoveryScan?.(correlatedResult, acquisition);
  return walletAttemptHandle;
};

interface WalletRecoveryCaptureResources {
  readonly frameProcessorState: DiceKeyFrameProcessorState;
  readonly mediaStreamState: MediaStreamState;
  readonly disposeCapture: () => void;
}

interface RegisteredWalletRecoveryScannerAttempt {
  readonly scannerAttempt: ScannerAttemptLifecycle;
  readonly handle: WalletRecoveryScannerAcquisitionHandle;
  readonly isActive: () => boolean;
  readonly attachCameraInventory: (
    camerasOnThisDevice: CamerasOnThisDevice,
  ) => boolean;
  readonly detachCameraInventory: (
    camerasOnThisDevice: CamerasOnThisDevice,
  ) => void;
  readonly attachCaptureResources: (
    resources: WalletRecoveryCaptureResources,
  ) => boolean;
  readonly detachCaptureResources: (
    resources: WalletRecoveryCaptureResources,
  ) => void;
  readonly startFrameAcquisitionWatchdog: () => void;
  readonly beginDeliveredFrame: () => boolean;
  readonly finishDeliveredFrame: () => void;
  readonly fail: () => void;
}

const disposeWalletRecoveryCaptureResources = (
  resources: WalletRecoveryCaptureResources,
): { readonly failed: boolean; readonly error?: unknown } => {
  let failed = false;
  let firstError: unknown;
  const recordFailure = (error: unknown): void => {
    if (!failed) firstError = error;
    failed = true;
  };
  try { resources.disposeCapture(); } catch (error) { recordFailure(error); }
  try { resources.frameProcessorState.dispose(); } catch (error) {
    recordFailure(error);
  }
  try { resources.mediaStreamState.dispose(); } catch (error) {
    recordFailure(error);
  }
  return failed ? { failed: true, error: firstError } : { failed: false };
};

/**
 * Owns the wallet worker and its stable cleanup handle before camera discovery.
 * Capture resources may attach/detach during React StrictMode effect replay,
 * but the registered handle and worker remain the authority for the attempt.
 */
const createRegisteredWalletRecoveryScannerAttempt = (
  onFailure: (
    result: WalletRecoveryScannerResult,
    handle: WalletRecoveryScannerAcquisitionHandle,
  ) => void,
): RegisteredWalletRecoveryScannerAttempt => {
  const scannerAttempt = new ScannerAttemptLifecycle(
    () => createDiceKeyFrameWorkerClient("wallet-recovery"),
  );
  scannerAttempt.mount();
  const acquisitionId = scannerAttempt.acquisitionId;
  if (acquisitionId == null) {
    unmountScannerAttemptWithoutUnhandledRejection(scannerAttempt);
    throw new Error("Wallet scanner attempt mounted without an acquisition id");
  }

  let active = true;
  let cameraInventory: CamerasOnThisDevice | undefined;
  let attachedResources: WalletRecoveryCaptureResources | undefined;
  let cleanupFailed = false;
  let firstCleanupError: unknown;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let deliveredFrame = false;
  let processingDeliveredFrame = false;

  const recordCleanupFailure = (error: unknown): void => {
    if (!cleanupFailed) firstCleanupError = error;
    cleanupFailed = true;
  };
  const recordCleanupResult = (
    result: ReturnType<typeof disposeWalletRecoveryCaptureResources>,
  ): void => {
    if (result.failed) recordCleanupFailure(result.error);
  };
  const clearWatchdog = (): void => {
    const currentWatchdog = watchdog;
    watchdog = undefined;
    if (currentWatchdog != null) clearTimeout(currentWatchdog);
  };
  const disposeAttachedResources = (): void => {
    const resources = attachedResources;
    attachedResources = undefined;
    if (resources != null) {
      recordCleanupResult(disposeWalletRecoveryCaptureResources(resources));
    }
  };
  const disposeCameraInventory = (): void => {
    const inventory = cameraInventory;
    cameraInventory = undefined;
    try { inventory?.dispose(); } catch (error) { recordCleanupFailure(error); }
  };

  let registeredAttempt!: RegisteredWalletRecoveryScannerAttempt;
  const handle = createWalletRecoveryScannerAcquisitionHandle(
    acquisitionId,
    () => {
      active = false;
      clearWatchdog();
      disposeAttachedResources();
      disposeCameraInventory();
      let workerCleanup: Promise<void>;
      try {
        workerCleanup = scannerAttempt.unmount();
      } catch (error) {
        workerCleanup = Promise.reject(error);
      }
      return workerCleanup.then(() => {
        if (cleanupFailed) throw firstCleanupError;
      });
    },
  );

  const fail = (): void => {
    if (
      !active ||
      scannerAttempt.acquisitionId !== acquisitionId ||
      handle.acquisitionId !== acquisitionId
    ) {
      return;
    }
    handle.dispose();
    onFailure(createWalletRecoveryScannerAttemptFailure(acquisitionId), handle);
  };
  const armWatchdog = (): void => {
    if (!active || watchdog != null || processingDeliveredFrame) return;
    watchdog = setTimeout(() => {
      watchdog = undefined;
      try { registeredAttempt.fail(); } catch {}
    }, deliveredFrame
      ? WALLET_RECOVERY_NEXT_FRAME_TIMEOUT_MS
      : WALLET_RECOVERY_FIRST_FRAME_TIMEOUT_MS);
  };

  registeredAttempt = Object.freeze({
    scannerAttempt,
    handle,
    isActive: () => active,
    attachCameraInventory: (inventory: CamerasOnThisDevice): boolean => {
      if (!active) {
        try { inventory.dispose(); } catch (error) {
          recordCleanupFailure(error);
        }
        return false;
      }
      if (cameraInventory === inventory) return true;
      disposeCameraInventory();
      if (!active) return false;
      cameraInventory = inventory;
      return true;
    },
    detachCameraInventory: (inventory: CamerasOnThisDevice): void => {
      if (cameraInventory !== inventory) return;
      disposeCameraInventory();
    },
    attachCaptureResources: (
      resources: WalletRecoveryCaptureResources,
    ): boolean => {
      if (!active) {
        recordCleanupResult(disposeWalletRecoveryCaptureResources(resources));
        return false;
      }
      if (attachedResources === resources) return true;
      disposeAttachedResources();
      if (!active) return false;
      attachedResources = resources;
      return true;
    },
    detachCaptureResources: (
      resources: WalletRecoveryCaptureResources,
    ): void => {
      if (attachedResources !== resources) return;
      disposeAttachedResources();
    },
    startFrameAcquisitionWatchdog: armWatchdog,
    beginDeliveredFrame: (): boolean => {
      if (!active || processingDeliveredFrame) return false;
      processingDeliveredFrame = true;
      deliveredFrame = true;
      clearWatchdog();
      return true;
    },
    finishDeliveredFrame: (): void => {
      if (!processingDeliveredFrame) return;
      processingDeliveredFrame = false;
      armWatchdog();
    },
    fail,
  });
  return registeredAttempt;
};

const CaptureView = observer(({
  camerasOnThisDevice,
  onCameraFailure,
  walletAttempt,
  ...scanDiceKeyViewProps
}: ScanDiceKeyViewProps & {
  camerasOnThisDevice: CamerasOnThisDevice;
  onCameraFailure: (reason: CameraAccessFailureReason) => void;
  walletAttempt?: RegisteredWalletRecoveryScannerAttempt;
}) => {
  const scannerAttemptRef = useRef<ScannerAttemptLifecycle>();
  if (walletAttempt == null && scannerAttemptRef.current == null) {
    // This holder owns no worker resources. The client is created by mount()
    // from the commit-phase effect below.
    scannerAttemptRef.current = new ScannerAttemptLifecycle(
      () => createDiceKeyFrameWorkerClient(scanDiceKeyViewProps.scanMode),
    );
  }
  const scannerAttempt = walletAttempt?.scannerAttempt ??
    scannerAttemptRef.current!;
  const walletResultDeliveryRef = useRef<(
    result: WalletRecoveryScanResult,
  ) => void>();
  const latestOnDiceKeyReadRef = useRef(scanDiceKeyViewProps.onDiceKeyRead);
  latestOnDiceKeyReadRef.current = scanDiceKeyViewProps.onDiceKeyRead;
  const [forwardDiceKeyRead] = useState(
    () => (diceKey?: DiceKeyWithoutKeyId): void => {
      latestOnDiceKeyReadRef.current?.(diceKey);
    },
  );
  const [forwardWalletRecoveryScan] = useState(
    () => (result: WalletRecoveryScanResult): void => {
      walletResultDeliveryRef.current?.(result);
    },
  );
  const [frameProcessorState] = useState(
    () => new DiceKeyFrameProcessorState({
      scanMode: scanDiceKeyViewProps.scanMode,
      onDiceKeyRead: forwardDiceKeyRead,
      onWalletRecoveryScan: forwardWalletRecoveryScan,
    }),
  );
  const [mediaStreamState] = useState(
    () => new MediaStreamState(camerasOnThisDevice, defaultMediaTrackConstraints),
  );
  const scannerAttemptMountedRef = useRef(false);
  const [walletAttemptCompleted, setWalletAttemptCompleted] = useState(false);
  const [walletAttemptRegistered, setWalletAttemptRegistered] = useState(false);
  const completeWalletAttempt = useCallback((): void => {
    scannerAttemptMountedRef.current = false;
    setWalletAttemptRegistered(false);
    setWalletAttemptCompleted(true);
  }, []);
  const acquisitionHandleRef = useRef<WalletRecoveryScannerAcquisitionHandle>();
  const captureDisposerRef = useRef<() => void>();
  const [registerSynchronousCaptureDisposer] = useState(
    () => (dispose: (() => void) | undefined): void => {
      captureDisposerRef.current = dispose;
    },
  );
  const [disposeCaptureSynchronously] = useState(
    () => (): void => {
      const disposeCapture = captureDisposerRef.current;
      captureDisposerRef.current = undefined;
      disposeCapture?.();
    },
  );

  walletResultDeliveryRef.current = (result): void => {
    const walletAttemptHandle = acquisitionHandleRef.current;
    if (walletAttemptHandle == null) return;
    deliverWalletRecoveryScannerResult({
      result,
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      walletAttemptHandle,
      onWalletAttemptCompleted: completeWalletAttempt,
      disposeCapture: disposeCaptureSynchronously,
      onWalletRecoveryScan: scanDiceKeyViewProps.onWalletRecoveryScan,
    });
  };
  const onFrameCaptured = async (
    framesImageData: ImageData,
    canvasRenderingContext: CanvasRenderingContext2D,
  ): Promise<void> => {
    const attemptId = scannerAttempt.acquisitionId;
    const walletAttemptHandle = acquisitionHandleRef.current;
    let genuineWalletFrame = false;
    try {
      genuineWalletFrame =
        scanDiceKeyViewProps.scanMode === "wallet-recovery" &&
        walletAttempt?.isActive() === true &&
        scannerAttemptMountedRef.current &&
        attemptId != null &&
        walletAttemptHandle?.acquisitionId === attemptId &&
        framesImageData.width > 0 &&
        framesImageData.height > 0 &&
        framesImageData.data.byteLength > 0 &&
        walletAttempt.beginDeliveredFrame();
    } catch {}
    try {
      await processCapturedFrameForScannerAttempt({
        framesImageData,
        canvasRenderingContext,
        scanMode: scanDiceKeyViewProps.scanMode,
        scannerAttempt,
        frameProcessorState,
        mediaStreamState,
        onWalletAttemptCompleted: completeWalletAttempt,
        disposeCapture: disposeCaptureSynchronously,
        onWalletRecoveryScan: scanDiceKeyViewProps.onWalletRecoveryScan,
        walletAttemptHandle,
      });
    } finally {
      if (
        genuineWalletFrame &&
        scannerAttemptMountedRef.current &&
        scannerAttempt.acquisitionId === attemptId &&
        acquisitionHandleRef.current === walletAttemptHandle &&
        walletAttempt != null
      ) {
        walletAttempt.finishDeliveredFrame();
      }
    }
  };
  useEffect(() => {
    const walletAttemptHandle = walletAttempt?.handle;
    const captureResources: WalletRecoveryCaptureResources = {
      frameProcessorState,
      mediaStreamState,
      disposeCapture: disposeCaptureSynchronously,
    };
    try {
      if (scanDiceKeyViewProps.scanMode === "wallet-recovery") {
        if (
          walletAttempt == null ||
          walletAttemptHandle == null ||
          !walletAttempt.isActive() ||
          walletAttempt.scannerAttempt !== scannerAttempt
        ) {
          setWalletAttemptCompleted(true);
          return;
        }
        const acquisitionId = scannerAttempt.acquisitionId;
        if (
          acquisitionId == null ||
          walletAttemptHandle.acquisitionId !== acquisitionId ||
          !walletAttempt.attachCaptureResources(captureResources)
        ) {
          setWalletAttemptCompleted(true);
          return;
        }
        frameProcessorState.activate({
          onDiceKeyRead: forwardDiceKeyRead,
          onWalletRecoveryScan: forwardWalletRecoveryScan,
        });
        acquisitionHandleRef.current = walletAttemptHandle;
        scannerAttemptMountedRef.current = true;
        setWalletAttemptRegistered(true);
      } else {
        frameProcessorState.activate({
          onDiceKeyRead: forwardDiceKeyRead,
          onWalletRecoveryScan: forwardWalletRecoveryScan,
        });
        mountScannerAttemptWithCleanup(
          scannerAttempt,
          frameProcessorState,
          mediaStreamState,
          disposeCaptureSynchronously,
        );
        scannerAttemptMountedRef.current = true;
      }
    } catch (error) {
      scannerAttemptMountedRef.current = false;
      setWalletAttemptRegistered(false);
      if (walletAttemptHandle != null) {
        walletAttemptHandle.dispose();
      } else {
        void beginScannerAttemptDisposal(
          scannerAttempt,
          frameProcessorState,
          mediaStreamState,
          disposeCaptureSynchronously,
        ).catch(() => {});
      }
      throw error;
    }
    return () => {
      scannerAttemptMountedRef.current = false;
      if (walletAttemptHandle != null) {
        if (acquisitionHandleRef.current === walletAttemptHandle) {
          acquisitionHandleRef.current = undefined;
        }
        walletAttempt?.detachCaptureResources(captureResources);
      } else {
        void beginScannerAttemptDisposal(
          scannerAttempt,
          frameProcessorState,
          mediaStreamState,
          disposeCaptureSynchronously,
        ).catch(() => {});
      }
    };
  }, [
    disposeCaptureSynchronously,
    forwardDiceKeyRead,
    forwardWalletRecoveryScan,
    frameProcessorState,
    scannerAttempt,
    mediaStreamState,
    scanDiceKeyViewProps.scanMode,
    walletAttempt,
  ]);

  const {deviceId, defaultDevice} = mediaStreamState;
  const {failureReason} = mediaStreamState;
  useEffect(() => {
    if (failureReason != null) onCameraFailure(failureReason);
  }, [failureReason, onCameraFailure]);
  useEffect(() => {
    if (!scannerAttemptMountedRef.current || walletAttemptCompleted) return;
    if (
      scanDiceKeyViewProps.scanMode === "wallet-recovery" &&
      walletAttempt?.isActive() !== true
    ) {
      return;
    }
    mediaStreamState.activate();
    if (deviceId == null && defaultDevice != null) {
      void mediaStreamState.setCamera(defaultDevice).catch(() => {});
    }
    if (scanDiceKeyViewProps.scanMode === "wallet-recovery") {
      walletAttempt?.startFrameAcquisitionWatchdog();
    }
  }, [
    deviceId,
    defaultDevice?.deviceId,
    mediaStreamState,
    scanDiceKeyViewProps.scanMode,
    walletAttempt,
    walletAttemptCompleted,
  ]);

  if (walletAttemptCompleted) return null;

  const capture = (
    <CameraCaptureWithOverlay
      {...{
        ...scanDiceKeyViewProps,
        onFrameCaptured,
        mediaStreamState,
        registerSynchronousCaptureDisposer,
      }}
      layoutMode={scanDiceKeyViewProps.scanMode === "wallet-recovery"
        ? "wallet-contained"
        : "legacy"}
    />
  );
  const hasCameraSelection = camerasOnThisDevice.cameras.length > 1;
  const cameraSelection = hasCameraSelection ? (
    <CameraSelectionView
      mediaStreamState={mediaStreamState}
      cameras={camerasOnThisDevice.cameras}
    />
  ) : null;

  if (scanDiceKeyViewProps.scanMode === "wallet-recovery") {
    return (
      <WalletScannerShell
        $hasCameraSelection={hasCameraSelection}
        data-wallet-scanner-layout="contained"
      >
        <WalletScannerPreview data-wallet-scanner-preview="contained">
          {walletAttemptRegistered && mediaStreamState.mediaStream != null ? (
            <WalletScannerReadyStatus
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              Camera active. Looking for 25 clear DiceKey faces.
            </WalletScannerReadyStatus>
          ) : null}
          {capture}
        </WalletScannerPreview>
        {hasCameraSelection ? (
          <WalletScannerControls data-wallet-scanner-controls="camera-selection">
            {cameraSelection}
          </WalletScannerControls>
        ) : null}
      </WalletScannerShell>
    );
  }

  return <>{capture}{cameraSelection}</>;
});


interface CameraDiscoveryViewProperties {
  readonly walletAttempt?: RegisteredWalletRecoveryScannerAttempt;
  readonly onWalletRetry?: () => void;
  readonly onWalletExit?: () => void;
}

const CameraDiscoveryView = observer(({
  walletAttempt,
  onWalletRetry,
  onWalletExit,
  ...props
}: ScanDiceKeyViewProps & CameraDiscoveryViewProperties) => {
  const [camerasOnThisDevice, setCamerasOnThisDevice] =
    useState<CamerasOnThisDevice>();
  const [attemptGeneration, setAttemptGeneration] = useState(0);
  const [runtimeFailure, setRuntimeFailure] =
    useState<CameraAccessFailureReason>();

  useEffect(() => {
    if (walletAttempt != null && !walletAttempt.isActive()) return;
    const cameras = CamerasOnThisDevice.instance(
      minCameraWidth,
      minCameraHeight,
    );
    if (
      walletAttempt != null &&
      !walletAttempt.attachCameraInventory(cameras)
    ) {
      return;
    }
    setCamerasOnThisDevice(cameras);
    return () => {
      if (walletAttempt != null) {
        walletAttempt.detachCameraInventory(cameras);
      } else {
        cameras.dispose();
      }
    };
  }, [attemptGeneration, walletAttempt]);

  const retryCamera = useCallback((): void => {
    setCamerasOnThisDevice(undefined);
    setRuntimeFailure(undefined);
    if (walletAttempt != null) {
      onWalletRetry?.();
    } else {
      camerasOnThisDevice?.dispose();
      setAttemptGeneration((generation) => generation + 1);
      try { props.onRetry?.(); } catch {}
    }
  }, [
    camerasOnThisDevice,
    onWalletRetry,
    props.onRetry,
    walletAttempt,
  ]);

  const exitCamera = useCallback((): void => {
    setCamerasOnThisDevice(undefined);
    setRuntimeFailure(undefined);
    if (walletAttempt != null) {
      onWalletExit?.();
    } else {
      camerasOnThisDevice?.dispose();
      props.onExit?.();
    }
  }, [camerasOnThisDevice, onWalletExit, props.onExit, walletAttempt]);

  const onCameraFailure = useCallback((
    reason: CameraAccessFailureReason,
  ): void => {
    if (walletAttempt != null) {
      walletAttempt.handle.dispose();
    } else {
      camerasOnThisDevice?.dispose();
    }
    setRuntimeFailure(reason);
  }, [camerasOnThisDevice, walletAttempt]);

//  const [rotationState, setRotationState] = useState<RotationState|undefined>(undefined);
  const onDiceKeyRead = (diceKey?: DiceKeyWithoutKeyId) => {
    props.onDiceKeyRead?.(diceKey);
  }

  const discoveryStatus: CameraDiscoveryStatus = camerasOnThisDevice?.status ??
    (camerasOnThisDevice?.readyAndNonEmpty ? "ready" :
      camerasOnThisDevice?.ready ? "no-camera" : "discovering");
  const cameraStatus = runtimeFailure ?? discoveryStatus;
  if (cameraStatus !== "ready") {
    const blockedStatus: CameraBlockedStatus = cameraStatus === "disposed"
      ? "camera-error"
      : cameraStatus;
    return (
      <CameraBlockedView
        status={blockedStatus}
        scanMode={props.scanMode}
        editManually={
          props.scanMode === "wallet-recovery" ? undefined : props.editManually
        }
        onExit={props.scanMode === "wallet-recovery" ? exitCamera : props.onExit}
        onRetry={retryCamera}
      />
    );
  }

  return (
      <CaptureView
        key={`${scannerAttemptKeyForMode(props.scanMode)}:${attemptGeneration}`}
        {...{
          ...props,
          camerasOnThisDevice: camerasOnThisDevice!,
          onCameraFailure,
          onDiceKeyRead,
          walletAttempt,
        }}
      />
  );
});

const WalletRecoveryScannerRegistrationBoundary = observer((
  props: WalletRecoveryScanDiceKeyViewProps,
) => {
  const latestAttemptStartedRef = useRef(
    props.onWalletRecoveryAttemptStarted,
  );
  latestAttemptStartedRef.current = props.onWalletRecoveryAttemptStarted;
  const latestScanRef = useRef(props.onWalletRecoveryScan);
  latestScanRef.current = props.onWalletRecoveryScan;
  const latestRetryRef = useRef(props.onRetry);
  latestRetryRef.current = props.onRetry;
  const [attemptGeneration, setAttemptGeneration] = useState(0);
  const [registeredAttempt, setRegisteredAttempt] =
    useState<RegisteredWalletRecoveryScannerAttempt>();
  const currentAttemptRef =
    useRef<RegisteredWalletRecoveryScannerAttempt>();
  const retryRequestRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      retryRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    let attempt!: RegisteredWalletRecoveryScannerAttempt;
    attempt = createRegisteredWalletRecoveryScannerAttempt((result, handle) => {
      if (currentAttemptRef.current !== attempt) return;
      setRegisteredAttempt((current) =>
        current === attempt ? undefined : current);
      try { latestScanRef.current?.(result, handle); } catch {}
    });
    currentAttemptRef.current = attempt;

    let registrationAccepted = false;
    try {
      registrationAccepted =
        latestAttemptStartedRef.current(attempt.handle) === true;
    } catch {}
    registrationAccepted = registrationAccepted &&
      currentAttemptRef.current === attempt &&
      attempt.isActive() &&
      attempt.scannerAttempt.acquisitionId === attempt.handle.acquisitionId;
    if (!registrationAccepted) {
      if (currentAttemptRef.current === attempt) {
        currentAttemptRef.current = undefined;
      }
      attempt.handle.dispose();
      return () => attempt.handle.dispose();
    }

    setRegisteredAttempt(attempt);
    const readiness = attempt.scannerAttempt.readiness;
    if (readiness != null) {
      void readiness.catch(() => {
        if (currentAttemptRef.current !== attempt) return;
        try { attempt.fail(); } catch {}
      });
    }

    return () => {
      if (currentAttemptRef.current === attempt) {
        currentAttemptRef.current = undefined;
      }
      attempt.handle.dispose();
    };
  }, [attemptGeneration]);

  const retryCamera = useCallback((): void => {
    const attempt = currentAttemptRef.current;
    currentAttemptRef.current = undefined;
    setRegisteredAttempt(undefined);
    const retryRequest = ++retryRequestRef.current;
    if (attempt == null) {
      if (!mountedRef.current) return;
      setAttemptGeneration((generation) => generation + 1);
      try { latestRetryRef.current?.(); } catch {}
      return;
    }
    attempt.handle.dispose();
    void attempt.handle.cleanupSettlement.then(() => {
      if (!mountedRef.current || retryRequestRef.current !== retryRequest) return;
      setAttemptGeneration((generation) => generation + 1);
      try { latestRetryRef.current?.(); } catch {}
    }, () => {
      // The accepted handle's original settlement is also observed by the
      // controller cleanup gate, which owns presentation of this failure.
    });
  }, []);

  const exitCamera = useCallback((): void => {
    retryRequestRef.current += 1;
    const attempt = currentAttemptRef.current;
    currentAttemptRef.current = undefined;
    setRegisteredAttempt(undefined);
    attempt?.handle.dispose();
    props.onExit();
  }, [props.onExit]);

  if (registeredAttempt == null) return null;
  return (
    <CameraDiscoveryView
      key={registeredAttempt.handle.acquisitionId}
      {...props}
      walletAttempt={registeredAttempt}
      onWalletRetry={retryCamera}
      onWalletExit={exitCamera}
    />
  );
});

export const ScanDiceKeyView = observer((props: ScanDiceKeyViewProps) =>
  props.scanMode === "wallet-recovery" ? (
    <WalletRecoveryScannerRegistrationBoundary {...props} />
  ) : (
    <CameraDiscoveryView {...props} />
  ),
);

export const Preview_ScanDiceKeyView = () => (
  <ScanDiceKeyView onDiceKeyRead={ (diceKey) => {
    const hrf = diceKey?.inHumanReadableForm;
    console.log(`Read ${hrf}`);
    alert(`Read ${hrf}`);
  }}
    height={`60vh`}
    editManually={() => alert("edit manually")}
  />
);
