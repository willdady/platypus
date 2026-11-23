import type { CloserRegistrar } from "@platypuschat/plugin-sdk";
import { logger } from "../logger.ts";

export type Closer = () => Promise<void> | void;

// why: onTerminate awaits dispose before the run's terminal write, so a hung closer delays it
export const CLOSER_TIMEOUT_MS = 5_000;

class CloserTimeoutError extends Error {}

export const runCloser = async (
  close: Closer,
  attribution?: Record<string, unknown>,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(close()),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new CloserTimeoutError(
                `closer did not settle within ${CLOSER_TIMEOUT_MS}ms`,
              ),
            ),
          CLOSER_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    logger.warn(
      { ...attribution, error },
      error instanceof CloserTimeoutError
        ? "A tool session's closer did not settle in time; abandoning it"
        : "Error closing a tool session's connection",
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export type CoreCloserRegistrar = (
  close: Closer,
  attribution?: Record<string, unknown>,
) => void;

export type WithCoreRegistrar<T> = Omit<T, "registerCloser"> & {
  registerCloser: CoreCloserRegistrar;
};

const attributeCloser = (
  register: CoreCloserRegistrar,
  attribution: Record<string, unknown>,
): CloserRegistrar => {
  return (close) => {
    register(close, attribution);
  };
};

export const withAttributedRegistrar = <
  T extends { registerCloser: CoreCloserRegistrar },
>(
  ctx: T,
  attribution: Record<string, unknown>,
): Omit<T, "registerCloser"> & { registerCloser: CloserRegistrar } => ({
  ...ctx,
  registerCloser: attributeCloser(ctx.registerCloser, attribution),
});
