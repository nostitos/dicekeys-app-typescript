import DiceKeyImageFrameWorker from "../../workers/dicekey-image-frame-worker?worker";
import { DiceKeyFrameWorkerClient } from "./wallet-recovery-scanner-worker-client";

export { DiceKeyFrameWorkerClient } from "./wallet-recovery-scanner-worker-client";

/** Create one worker client for one mounted scanner attempt. */
export const createDiceKeyFrameWorkerClient = (): DiceKeyFrameWorkerClient =>
  new DiceKeyFrameWorkerClient({
    createWorker: () => new DiceKeyImageFrameWorker(),
  });
