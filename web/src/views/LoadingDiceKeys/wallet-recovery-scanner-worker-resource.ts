export interface NativeDeletable {
  delete(): void;
}

/** Owns native processors and guarantees each stored instance is deleted once. */
export class ScannerNativeProcessorStore<T extends NativeDeletable> {
  private readonly sessionIdToProcessor = new Map<string, T>();
  private readonly deletedProcessors = new WeakSet<object>();

  constructor(private readonly createProcessor: () => T) {}

  getOrCreate = (sessionId: string): T => {
    const existing = this.sessionIdToProcessor.get(sessionId);
    if (existing != null) return existing;
    const processor = this.createProcessor();
    this.sessionIdToProcessor.set(sessionId, processor);
    return processor;
  };

  private deleteExactlyOnce = (processor: T): void => {
    if (this.deletedProcessors.has(processor)) return;
    this.deletedProcessors.add(processor);
    processor.delete();
  };

  deleteSession = (sessionId: string): void => {
    const processor = this.sessionIdToProcessor.get(sessionId);
    if (processor == null) return;
    this.sessionIdToProcessor.delete(sessionId);
    this.deleteExactlyOnce(processor);
  };

  dispose = (): void => {
    const processors = [...this.sessionIdToProcessor.values()];
    this.sessionIdToProcessor.clear();
    processors.forEach(this.deleteExactlyOnce);
  };
}
