import DiceKeyImageFrameWorker from "../../workers/dicekey-image-frame-worker?worker";
import type { DiceKeyScannerMode } from "./DiceKeyFrameProcessorState";
import {
  DiceKeyFrameWorkerClient,
  WALLET_RECOVERY_FRAME_RESPONSE_TIMEOUT_MS,
  WALLET_RECOVERY_WORKER_READY_TIMEOUT_MS,
} from "./wallet-recovery-scanner-worker-client";

export { DiceKeyFrameWorkerClient } from "./wallet-recovery-scanner-worker-client";

/** Create one worker client for one mounted scanner attempt. */
export const createDiceKeyFrameWorkerClient = (
  scanMode: DiceKeyScannerMode = "legacy",
): DiceKeyFrameWorkerClient =>
  new DiceKeyFrameWorkerClient({
    createWorker: () => new DiceKeyImageFrameWorker(),
    ...(scanMode === "wallet-recovery" ? {
      workerReadyTimeoutMs: WALLET_RECOVERY_WORKER_READY_TIMEOUT_MS,
      frameResponseTimeoutMs: WALLET_RECOVERY_FRAME_RESPONSE_TIMEOUT_MS,
    } : {}),
  });
