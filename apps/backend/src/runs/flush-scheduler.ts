/**
 * Coalesces calls to a flush function on a fixed interval.
 *
 * `bump()` schedules a flush within `intervalMs`. Repeated `bump()` calls
 * within the same window collapse to one invocation. `flush()` runs the
 * function immediately and resets the timer. `dispose()` cancels any
 * pending flush; subsequent `bump()` calls are no-ops.
 *
 * Sinks instantiate one of these per Run to bound the rate of partial
 * persistence writes regardless of how often the model produces progress.
 */
export class FlushScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private inFlight: Promise<void> = Promise.resolve();
  private readonly intervalMs: number;
  private readonly flushFn: () => Promise<void> | void;

  constructor(intervalMs: number, flushFn: () => Promise<void> | void) {
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

  /** Run the flush function immediately and reset the timer. */
  async flush(): Promise<void> {
    if (this.disposed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.runFlush();
    await this.inFlight;
  }

  /**
   * Stop accepting new bumps and wait for any in-flight flush to settle
   * before returning. Awaiting matters because callers persist a
   * terminal write immediately after dispose; without the wait, a
   * stale running-state flush can land after the terminal write and
   * revert the row.
   */
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
      } catch {
        // Swallowed: callers don't await scheduled bumps. Errors should be
        // logged inside flushFn itself.
      }
    });
  }
}
