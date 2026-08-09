import type { ProcessFrameResponse } from "../../workers/dicekey-image-frame-worker";

export interface ScannerAttemptWorkerClient {
  readonly acquisitionId: string;
  processDiceKeyImageFrame(imageData: ImageData): Promise<ProcessFrameResponse>;
  dispose(): Promise<void>;
}

/**
 * A render-safe holder. Construction allocates no worker/client resources;
 * mount must be called from React's commit phase.
 */
export class ScannerAttemptLifecycle {
  private client?: ScannerAttemptWorkerClient;

  constructor(
    private readonly createClient: () => ScannerAttemptWorkerClient,
  ) {}

  mount = (): void => {
    if (this.client != null) return;
    this.client = this.createClient();
  };

  get acquisitionId(): string | undefined {
    return this.client?.acquisitionId;
  }

  processDiceKeyImageFrame = (imageData: ImageData): Promise<ProcessFrameResponse> => {
    const client = this.client;
    if (client == null) {
      try { imageData.data.fill(0); } catch {}
      return Promise.reject(new Error("DiceKey scanner attempt is not mounted"));
    }
    return client.processDiceKeyImageFrame(imageData);
  };

  unmount = (): Promise<void> => {
    const client = this.client;
    this.client = undefined;
    return client?.dispose() ?? Promise.resolve();
  };
}
