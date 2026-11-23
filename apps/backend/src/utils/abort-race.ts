const rejectOnAbort = (
  signal: AbortSignal,
): { promise: Promise<never>; release: () => void } => {
  let release = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    const onAbort = () =>
      reject(new Error("aborted", { cause: signal.reason }));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    release = () => signal.removeEventListener("abort", onAbort);
  });
  return { promise, release };
};

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

export class DeadlineExceededError extends Error {}

export class CallerAbortedError extends Error {}

export const withDeadline = async <T>(
  work: (signal: AbortSignal) => Promise<T> | T,
  timeoutMs: number,
  caller?: AbortSignal,
): Promise<T> => {
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new DeadlineExceededError(`timed out after ${timeoutMs}ms`),
      ),
    timeoutMs,
  );
  const signal = caller
    ? AbortSignal.any([deadline.signal, caller])
    : deadline.signal;
  try {
    return await raceAbort(signal, work);
  } catch (cause) {
    if (deadline.signal.aborted) {
      throw deadline.signal.reason as DeadlineExceededError;
    }
    if (caller?.aborted) {
      throw new CallerAbortedError("turn cancelled");
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
};
