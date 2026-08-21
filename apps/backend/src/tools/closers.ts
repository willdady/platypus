import type { CloserRegistrar } from "@platypuschat/plugin-sdk";
import { logger } from "../logger.ts";

/**
 * Per-turn teardown, shared by the two Extension points that have one.
 *
 * Its own module rather than part of `tool-session.ts` because both compose
 * layers need it — `tools/index.ts` and `web-backends/index.ts` — and
 * `tool-session.ts` already imports the first of those.
 */

/** Something a Contribution wants closed when the turn ends. */
export type Closer = () => Promise<void> | void;

/**
 * How long one registered closer gets before the session abandons it.
 *
 * A judgement call, not a derived number, and this is the constraint it answers
 * to: the run's `onTerminate` awaits `dispose` *before* it writes the run's
 * terminal state, so a closer that hangs delays the last thing a reader is
 * waiting for. Five seconds is long enough for a socket to shut politely and
 * short enough that nobody watching the reply notices.
 *
 * Closers run **sequentially**, as they always have, so the bound on a whole
 * teardown is `closers × CLOSER_TIMEOUT_MS` rather than this value. Stated
 * because it is the real ceiling; parallelising teardown to tighten it is a
 * separate decision, and one an MCP transport may not want made for it.
 */
export const CLOSER_TIMEOUT_MS = 5_000;

/** Raised inside {@link runCloser} when a closer outruns its deadline. */
class CloserTimeoutError extends Error {}

/**
 * Run one closer: bounded, caught, logged, never throwing.
 *
 * Every closer goes through here — a Contribution's, and an MCP client's
 * `close()`. That second one is a behaviour change worth naming: an MCP server
 * whose `close()` hangs used to stall the run's terminal write indefinitely, and
 * is now abandoned like anything else.
 *
 * `attribution` is what the log line needs in order to name a culprit — the
 * plugin, and the Tool set or backend the closer came from. It rides a parameter
 * rather than a wrapper around `close` so that a session can still dedupe on the
 * closer's own identity.
 */
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
    // `warn`, not `error`, and for the same reason a cancelled executor call is
    // logged at debug: the level has to match what the event costs. A closer
    // failing means something a Contribution opened was not released — worth an
    // Operator's attention, never worth paging for, and it cannot fail the turn
    // or reach the User. `error` is what the sibling degrade paths in this
    // change deliberately avoid (a throwing factory, a non-function closer), and
    // most closers that reach here belong to third-party code core cannot fix.
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

/**
 * Core's own view of a registrar: the SDK's {@link CloserRegistrar} plus the
 * attribution the plugin-facing type has no room for.
 *
 * Assignable to `CloserRegistrar` — the extra parameter is optional — which is
 * how a Contribution only ever sees the one-argument shape.
 */
export type CoreCloserRegistrar = (
  close: Closer,
  attribution?: Record<string, unknown>,
) => void;

/**
 * A runtime context as **core** builds it: the same fields a Contribution sees,
 * with the registrar core actually put there. Assignable to the plain SDK
 * context, so what reaches a Contribution is still the published shape.
 */
export type WithCoreRegistrar<T> = Omit<T, "registerCloser"> & {
  registerCloser?: CoreCloserRegistrar;
};

/**
 * Narrow core's registrar to the plugin-facing shape, pinning the attribution a
 * failure from this Contribution should be logged under.
 *
 * The closer passes through unwrapped, so the same function registered twice is
 * still one function when the session dedupes it.
 */
export const attributeCloser = (
  register: CoreCloserRegistrar,
  attribution: Record<string, unknown>,
): CloserRegistrar => {
  return (close) => {
    register(close, attribution);
  };
};

/**
 * Derive the context a Contribution is handed from the one core holds: the same
 * fields, with the registrar narrowed to the plugin-facing shape and pinned to
 * this Contribution's attribution.
 *
 * Both Extension points go through here rather than each spreading the context
 * themselves, because the spread is the easy place to widen what crosses the
 * seam by accident — core-only fields have to be stripped by the caller *before*
 * this point, and one shared helper is one place to check that.
 *
 * A context that carries no registrar is returned as-is, so a core that never
 * supplies one hands a Contribution exactly the object it did before.
 */
export const withAttributedRegistrar = <
  T extends { registerCloser?: CoreCloserRegistrar },
>(
  ctx: T,
  attribution: Record<string, unknown>,
): Omit<T, "registerCloser"> & { registerCloser?: CloserRegistrar } => {
  if (!ctx.registerCloser) return ctx;
  return {
    ...ctx,
    registerCloser: attributeCloser(ctx.registerCloser, attribution),
  };
};
