import { observer } from "mobx-react";
import React, { useEffect, useRef, useState } from "react";
import { CameraCaptureWithOverlay } from "./CameraCaptureWithOverlay";
import {
  DiceKeyFrameProcessorState,
  scannerAttemptKeyForMode,
  type DiceKeyScannerMode,
} from "./DiceKeyFrameProcessorState";
import { createDiceKeyFrameWorkerClient } from "./process-dicekey-image-frame";
import { CamerasOnThisDevice } from "./CamerasOnThisDevice";
import { MediaStreamState } from "./MediaStreamState";
import { CameraSelectionView } from "./CameraSelectionView";
import { RUNNING_IN_BROWSER } from "../../utilities/is-electron";
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
  WALLET_RECOVERY_SCANNER_ATTEMPT_FAILED,
  createWalletRecoveryScannerAcquisitionHandle,
  scannerCandidateToSanitizedAcquisition,
  type WalletRecoveryScannerAcquisitionHandle,
  type WalletRecoveryScannerResult,
  type WalletRecoveryScannerTerminal,
} from "./wallet-recovery-scanner-acquisition";
import { wipeScannerFaceImageResponse } from "./wallet-recovery-scanner-worker-session-handler";

const minCameraWidth = 1024;
const minCameraHeight = 720;

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
export interface ScanDiceKeyViewProps extends OnDiceKeyRead, DiceKeyAnimationRotationProps {
  height: string;
  showBoxOverlay?: boolean;
  editManually?: () => void;
  /** Wallet recovery must be selected explicitly; legacy behavior is default. */
  scanMode?: DiceKeyScannerMode;
  onWalletRecoveryScan?: (
    result: WalletRecoveryScannerResult,
    terminal?: WalletRecoveryScannerTerminal,
  ) => void;
}

const PermissionRequiredView = ({editManually}: ScanDiceKeyViewProps) => (
  <FullScreenNotification>
    <FullScreenNotificationContent>
      <FullScreenNotificationPrimaryText>
        You need to grant &ldquo;allow always&rdquo; permission to your device's cameras to scan DiceKeys.
      </FullScreenNotificationPrimaryText>
      <FullScreenNotificationSecondaryText>
        If this message does not go away after granting permissions, refresh this page.
      </FullScreenNotificationSecondaryText>
      { editManually == null ? null : (
        <CenteredControls>
          <PushButton onClick={editManually}>enter manually instead</PushButton>
        </CenteredControls>
      )}
    </FullScreenNotificationContent>
  </FullScreenNotification>
);


const NoCameraAvailableView = ({minCameraWidth, minCameraHeight, editManually}: {
  minCameraWidth: number,
  minCameraHeight: number
} & ScanDiceKeyViewProps) => {
  return (
    <FullScreenNotification>    
      <FullScreenNotificationContent>
        <FullScreenNotificationPrimaryText>
          You do not have a sufficiently-high resolution camera available to scan your DiceKey
          or you have not provided permission to access it.
        </FullScreenNotificationPrimaryText>
        <FullScreenNotificationSecondaryText>
          You need a camera with resolution at least {minCameraWidth}&times;{minCameraHeight}.
        </FullScreenNotificationSecondaryText>
        { editManually == null ? null : (
        <CenteredControls>
          <PushButton onClick={editManually}>enter manually instead</PushButton>
        </CenteredControls>
      )}
      </FullScreenNotificationContent>
    </FullScreenNotification>
  )
}

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

const beginScannerAttemptDisposalAndMarkCompleted = (
  scannerAttempt: ScannerAttemptLifecycle,
  frameProcessorState: DiceKeyFrameProcessorState,
  mediaStreamState: MediaStreamState,
  onWalletAttemptCompleted: () => void,
  disposeCapture?: () => void,
): Promise<void> => {
  // Make the acquisition inert before any completion callback can throw or
  // synchronously re-enter scanner ownership.
  const cleanupSettlement = beginScannerAttemptDisposal(
    scannerAttempt,
    frameProcessorState,
    mediaStreamState,
    disposeCapture,
  );
  try {
    onWalletAttemptCompleted();
  } catch (error) {
    return cleanupSettlement.then(() => {
      throw error;
    });
  }
  return cleanupSettlement;
};

const failWalletScannerAttempt = ({
  attemptId,
  scannerAttempt,
  frameProcessorState,
  mediaStreamState,
  onWalletAttemptCompleted,
  disposeCapture,
  onWalletRecoveryScan,
  onAcquisitionHandleCreated,
}: {
  attemptId: string | undefined;
  scannerAttempt: ScannerAttemptLifecycle;
  frameProcessorState: DiceKeyFrameProcessorState;
  mediaStreamState: MediaStreamState;
  onWalletAttemptCompleted: () => void;
  disposeCapture?: () => void;
  onWalletRecoveryScan?: ScanDiceKeyViewProps["onWalletRecoveryScan"];
  onAcquisitionHandleCreated?: (
    handle: WalletRecoveryScannerAcquisitionHandle,
  ) => void;
}): void => {
  if (
    attemptId == null ||
    scannerAttempt.acquisitionId !== attemptId
  ) {
    return;
  }
  const handle = createWalletRecoveryScannerAcquisitionHandle(
    attemptId,
    () => beginScannerAttemptDisposalAndMarkCompleted(
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      onWalletAttemptCompleted,
      disposeCapture,
    ),
  );
  // Inert every scanner owner before exposing the fixed failure or its
  // attempt-bound cleanup settlement to caller-controlled code.
  handle.dispose();
  try { onAcquisitionHandleCreated?.(handle); } catch {}
  try {
    onWalletRecoveryScan?.(
      WALLET_RECOVERY_SCANNER_ATTEMPT_FAILED,
      handle,
    );
  } catch {}
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
  onAcquisitionHandleCreated,
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
  onAcquisitionHandleCreated?: (
    handle: WalletRecoveryScannerAcquisitionHandle,
  ) => void;
}): Promise<void> => {
  const attemptId = scannerAttempt.acquisitionId;
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
        frameProcessorState,
        mediaStreamState,
        onWalletAttemptCompleted,
        disposeCapture,
        onWalletRecoveryScan,
        onAcquisitionHandleCreated,
      });
    }
    return;
  }

  if (
    scanMode === "wallet-recovery" &&
    (attemptId == null || scannerAttempt.acquisitionId !== attemptId)
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
      frameProcessorState,
      mediaStreamState,
      onWalletAttemptCompleted,
      disposeCapture,
      onWalletRecoveryScan,
      onAcquisitionHandleCreated,
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
      // The consumer already received a sanitized result. Stop all acquisition
      // even if it threw or intentionally keeps the scanner view mounted.
      try {
        onWalletAttemptCompleted();
      } finally {
        void beginScannerAttemptDisposal(
          scannerAttempt,
          frameProcessorState,
          mediaStreamState,
          disposeCapture,
        ).catch(() => {});
      }
    }
  }
};

export const deliverWalletRecoveryScannerResult = ({
  result,
  scannerAttempt,
  frameProcessorState,
  mediaStreamState,
  existingHandle,
  onWalletAttemptCompleted,
  disposeCapture,
  onAcquisitionHandleCreated,
  onWalletRecoveryScan,
}: {
  result: WalletRecoveryScanResult;
  scannerAttempt: ScannerAttemptLifecycle;
  frameProcessorState: DiceKeyFrameProcessorState;
  mediaStreamState: MediaStreamState;
  existingHandle?: WalletRecoveryScannerAcquisitionHandle;
  onWalletAttemptCompleted: () => void;
  disposeCapture?: () => void;
  onAcquisitionHandleCreated?: (
    handle: WalletRecoveryScannerAcquisitionHandle,
  ) => void;
  onWalletRecoveryScan?: ScanDiceKeyViewProps["onWalletRecoveryScan"];
}): WalletRecoveryScannerAcquisitionHandle | undefined => {
  if (result.status === "rescan") {
    onWalletRecoveryScan?.(result);
    return existingHandle;
  }
  const acquisitionId = scannerAttempt.acquisitionId;
  if (acquisitionId == null) {
    void beginScannerAttemptDisposalAndMarkCompleted(
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      onWalletAttemptCompleted,
      disposeCapture,
    ).catch(() => {});
    return existingHandle;
  }
  const handle = existingHandle ??
    createWalletRecoveryScannerAcquisitionHandle(
      acquisitionId,
      () => beginScannerAttemptDisposalAndMarkCompleted(
        scannerAttempt,
        frameProcessorState,
        mediaStreamState,
        onWalletAttemptCompleted,
        disposeCapture,
      ),
    );
  onAcquisitionHandleCreated?.(handle);
  const acquisition = scannerCandidateToSanitizedAcquisition(result, handle);
  // The flow may call dispose again, but the old attempt is already inert and
  // bounded cleanup has already started before this callback can advance it.
  handle.dispose();
  onWalletRecoveryScan?.(result, acquisition);
  return handle;
};

const CaptureView = observer(({camerasOnThisDevice, ...scanDiceKeyViewProps}: ScanDiceKeyViewProps & {
  camerasOnThisDevice: CamerasOnThisDevice;
}) => {
  const scannerAttemptRef = useRef<ScannerAttemptLifecycle>();
  if (scannerAttemptRef.current == null) {
    // This holder owns no worker resources. The client is created by mount()
    // from the commit-phase effect below.
    scannerAttemptRef.current = new ScannerAttemptLifecycle(
      createDiceKeyFrameWorkerClient,
    );
  }
  const scannerAttempt = scannerAttemptRef.current;
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
    deliverWalletRecoveryScannerResult({
      result,
      scannerAttempt,
      frameProcessorState,
      mediaStreamState,
      existingHandle: acquisitionHandleRef.current,
      onWalletAttemptCompleted: () => {
        scannerAttemptMountedRef.current = false;
        setWalletAttemptCompleted(true);
      },
      disposeCapture: disposeCaptureSynchronously,
      onAcquisitionHandleCreated: (handle) => {
        acquisitionHandleRef.current = handle;
      },
      onWalletRecoveryScan: scanDiceKeyViewProps.onWalletRecoveryScan,
    });
  };
  const onFrameCaptured = async (
    framesImageData: ImageData,
    canvasRenderingContext: CanvasRenderingContext2D,
  ): Promise<void> => processCapturedFrameForScannerAttempt({
    framesImageData,
    canvasRenderingContext,
    scanMode: scanDiceKeyViewProps.scanMode,
    scannerAttempt,
    frameProcessorState,
    mediaStreamState,
    onWalletAttemptCompleted: () => setWalletAttemptCompleted(true),
    disposeCapture: disposeCaptureSynchronously,
    onWalletRecoveryScan: scanDiceKeyViewProps.onWalletRecoveryScan,
    onAcquisitionHandleCreated: (handle) => {
      acquisitionHandleRef.current = handle;
    },
  });
  useEffect(() => {
    try {
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
    } catch (error) {
      scannerAttemptMountedRef.current = false;
      throw error;
    }
    return () => {
      scannerAttemptMountedRef.current = false;
      const acquisitionHandle = acquisitionHandleRef.current;
      if (acquisitionHandle != null) {
        acquisitionHandle.dispose();
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
  ]);

  const {deviceId, defaultDevice} = mediaStreamState;
  useEffect(() => {
    if (!scannerAttemptMountedRef.current || walletAttemptCompleted) return;
    mediaStreamState.activate();
    if (deviceId == null && defaultDevice != null) {
      void mediaStreamState.setCamera(defaultDevice).catch(() => {});
    }
  }, [
    deviceId,
    defaultDevice?.deviceId,
    mediaStreamState,
    walletAttemptCompleted,
  ]);

  if (walletAttemptCompleted) return null;

  return (
    <>
    <CameraCaptureWithOverlay
      {...{
        ...scanDiceKeyViewProps,
        onFrameCaptured,
        mediaStreamState,
        registerSynchronousCaptureDisposer,
      }}
    />
    <CameraSelectionView mediaStreamState={mediaStreamState} cameras={camerasOnThisDevice.cameras} />
  </>
  );
});


export const ScanDiceKeyView = observer ( (props: ScanDiceKeyViewProps) => {
  const [camerasOnThisDevice, setCamerasOnThisDevice] =
    useState<CamerasOnThisDevice>();

  useEffect(() => {
    setCamerasOnThisDevice(
      CamerasOnThisDevice.instance(minCameraWidth, minCameraHeight),
    );
  }, []);

//  const [rotationState, setRotationState] = useState<RotationState|undefined>(undefined);
  const onDiceKeyRead = (diceKey?: DiceKeyWithoutKeyId) => {
    props.onDiceKeyRead?.(diceKey);
  }
  const [
    componentHasBeenLoadedForLongEnoughToShowCameraPermissionRequiredWarning,
    setComponentHasBeenLoadedForLongEnoughToShowCameraPermissionRequiredWarning
  ] = useState(false);
  useEffect(() => {
    if (
      camerasOnThisDevice == null ||
      !RUNNING_IN_BROWSER ||
      camerasOnThisDevice.readyAndNonEmpty
    ) {
      setComponentHasBeenLoadedForLongEnoughToShowCameraPermissionRequiredWarning(false);
      return;
    }
    const permissionWarningTimeout = setTimeout(() => {
      if (!camerasOnThisDevice.readyAndNonEmpty) {
        setComponentHasBeenLoadedForLongEnoughToShowCameraPermissionRequiredWarning(true);
      }
    }, 5000);
    return () => clearTimeout(permissionWarningTimeout);
  }, [camerasOnThisDevice, camerasOnThisDevice?.readyAndNonEmpty]);

  if (camerasOnThisDevice == null) return null;


  // Uncomment if we want to provide transparency into the
  // camera scanning process rather than just wait for it to complete...
  if (
    componentHasBeenLoadedForLongEnoughToShowCameraPermissionRequiredWarning &&
    !camerasOnThisDevice.readyAndNonEmpty
  ) {
    return ( <PermissionRequiredView {...props} /> );
  }
  if (camerasOnThisDevice.ready && camerasOnThisDevice.cameras.length === 0) {
    return ( <NoCameraAvailableView {...props} minCameraWidth={minCameraWidth} minCameraHeight={minCameraHeight} /> );
  }

  return (
      <CaptureView
        key={scannerAttemptKeyForMode(props.scanMode)}
        {...{...props, camerasOnThisDevice, onDiceKeyRead}}
      />
  );
});

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
