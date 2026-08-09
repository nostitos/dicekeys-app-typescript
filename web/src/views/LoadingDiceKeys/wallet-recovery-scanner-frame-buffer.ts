/**
 * Owns the captured RGBA view and a dedicated worker-transfer copy. The source
 * is wiped immediately. Before a successful post the copy is wiped on every
 * exit; a successful transfer detaches main-thread access, after which the
 * worker wipes cooperatively or its isolated realm is reclaimed on fatal
 * bounded termination.
 */
export class ScannerOwnedFrameBuffer {
  private source?: Uint8ClampedArray;
  private copy?: ArrayBuffer;
  private disposed = false;

  constructor(source: Uint8ClampedArray) {
    this.source = source;
    try {
      this.copy = source.buffer.slice(
        source.byteOffset,
        source.byteOffset + source.byteLength,
      ) as ArrayBuffer;
      source.fill(0);
    } catch (error) {
      try { source.fill(0); } catch {}
      try {
        if (this.copy != null) new Uint8Array(this.copy).fill(0);
      } catch {}
      this.source = undefined;
      this.copy = undefined;
      this.disposed = true;
      throw error;
    }
  }

  get arrayBuffer(): ArrayBuffer {
    if (this.disposed || this.copy == null) {
      throw new Error("Scanner frame buffer has been disposed");
    }
    return this.copy;
  }

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    try { this.source?.fill(0); } catch {}
    try {
      if (this.copy != null) new Uint8Array(this.copy).fill(0);
    } catch {
      // A successfully transferred ArrayBuffer is detached in the client.
    }
    this.source = undefined;
    this.copy = undefined;
  };
}
