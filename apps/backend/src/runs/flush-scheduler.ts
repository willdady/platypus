import { logger } from "../logger.ts";

export const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

export class FlushScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private inFlight: Promise<void> = Promise.resolve();
  private readonly intervalMs: number;
  private readonly flushFn: () => Promise<void> | void;

  constructor(
    flushFn: () => Promise<void> | void,
    intervalMs: number = DEFAULT_FLUSH_INTERVAL_MS,
  ) {
    this.intervalMs = intervalMs;
    this.flushFn = flushFn;
  }

  bump(): void {
    if (this.disposed) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.runFlush();
    }, this.intervalMs);
  }

  async flush(): Promise<void> {
    if (this.disposed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.runFlush();
    await this.inFlight;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  private runFlush(): void {
    this.inFlight = this.inFlight.then(async () => {
      try {
        await this.flushFn();
      } catch (error) {
        logger.error({ error }, "Scheduled run flush failed");
      }
    });
  }
}
