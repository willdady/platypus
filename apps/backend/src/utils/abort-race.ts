/**
 * Racing a Contribution's call against the run's abort.
 *
 * Every Extension point that hands work to code Platypus did not write has the
 * same problem: honouring an abort signal is optional — it arrives as an
 * appended parameter on a v1 contract — so an implementation is free to ignore
 * it and never come back. That the *turn* is not pinned open cannot rest on a
 * Contribution's cooperation, which is why core races rather than merely
 * signalling. The signal is the courtesy; the race is the guarantee.
 *
 * Shared between the Web-search backend's deadline wrapper and the Sandbox
 * tools because they want the identical thing and a second copy of it is a
 * second chance to get the listener release wrong (issue #921).
 */

/**
 * Reject as soon as `signal` aborts, and hand back the means to drop the
 * listener.
 *
 * Released in a `finally` rather than left to garbage collection. The signal
 * listened on is usually derived from the run's, which outlives every
 * individual tool call — and the shape of that retention is the platform's
 * business, not something a busy turn should depend on being generous.
 */
const rejectOnAbort = (
  signal: AbortSignal,
): { promise: Promise<never>; release: () => void } => {
  let release = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    // The signal's own `reason` is `any` — a caller may abort with anything —
    // and it is not read here: classifying *which* signal fired is the caller's
    // job. Carried as `cause` so nothing is lost.
    const onAbort = () =>
      reject(new Error("aborted", { cause: signal.reason }));
    // Not the live path: {@link raceAbort} refuses an already-aborted call
    // before it gets here, precisely so this promise is never handed back
    // already rejected with nothing attached to it. The branch stays as the
    // guard that keeps that true for a second caller.
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    release = () => signal.removeEventListener("abort", onAbort);
  });
  return { promise, release };
};

/**
 * Run `work` with `signal`, and stop waiting the moment that signal aborts.
 *
 * An already-aborted signal means `work` is never invoked at all: an
 * implementation that ignores its signal would otherwise spend a live upstream
 * request, or a live command, on a turn nobody will read.
 *
 * Rejects with a plain `Error("aborted")` carrying the signal's reason as its
 * cause. Callers that need to tell one abort from another — a deadline from a
 * cancellation — inspect their own signals in a `catch` and re-throw what they
 * want the caller to see.
 */
export const raceAbort = async <T>(
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T> | T,
): Promise<T> => {
  if (signal.aborted) throw new Error("aborted", { cause: signal.reason });
  const abort = rejectOnAbort(signal);
  try {
    return await Promise.race([Promise.resolve(work(signal)), abort.promise]);
  } finally {
    abort.release();
  }
};
