export interface StoreClock {
  now(): string;
}

export interface StoreIdGenerator {
  next(prefix: string): string;
}

export interface StoreRuntimeOptions {
  clock?: StoreClock;
  idGenerator?: StoreIdGenerator;
}

export class SystemStoreClock implements StoreClock {
  now(): string {
    return new Date().toISOString();
  }
}

export class IncrementingStoreIdGenerator implements StoreIdGenerator {
  private readonly counters = new Map<string, number>();
  private readonly sessionSeed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  next(prefix: string): string {
    const nextValue = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, nextValue);
    return `${prefix}_${this.sessionSeed}_${String(nextValue).padStart(4, "0")}`;
  }
}

export function resolveStoreRuntime(
  options: StoreRuntimeOptions = {},
): Required<StoreRuntimeOptions> {
  return {
    clock: options.clock ?? new SystemStoreClock(),
    idGenerator: options.idGenerator ?? new IncrementingStoreIdGenerator(),
  };
}
