import { useEffect, useState } from "react";
import { formatDurationMs, formatToolDuration } from "@/lib/utils";

const isTerminalState = (state: string): boolean => state.startsWith("output-");

const toMs = (iso?: string): number | undefined => {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? undefined : t;
};

/**
 * Resolves a tool call's run-duration string for the tool header.
 *
 * - While the tool is running it shows a live elapsed timer, ticking once a
 *   second from when the tool was first observed (the server start time isn't
 *   carried on the streamed message, so we measure on the client).
 * - When it turns terminal it freezes: the exact server-measured span if both
 *   `startedAt`/`completedAt` are persisted (after a chat reload), otherwise
 *   the client-observed span.
 *
 * A client clock is only used when the tool was actually seen running this
 * session, so reloading a chat (tool already terminal at mount) never shows a
 * bogus value — it relies on the server timestamps or shows nothing.
 *
 * Returns undefined when there's nothing meaningful to show (e.g. a historical
 * message that predates duration tracking).
 */
export function useToolDuration(
  state: string,
  startedAt?: string,
  completedAt?: string,
): string | undefined {
  const running = !isTerminalState(state);
  // All render-visible values are state, never refs or live Date.now() reads
  // (upstream's react-hooks rules forbid both during render). Every write is
  // deferred into a timer callback — setState synchronously inside an effect
  // body is also disallowed, but a timer/interval callback is a permitted site.
  const [clientStart, setClientStart] = useState<number>();
  const [clientEnd, setClientEnd] = useState<number>();
  const [elapsedMs, setElapsedMs] = useState(0);

  // While running: record the client-observed start once and tick the elapsed
  // time every second. `start` is captured in the effect body (reading
  // Date.now() there is fine); the setState calls run in deferred callbacks.
  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    const startTimer = setTimeout(
      () => setClientStart((prev) => prev ?? start),
      0,
    );
    const id = setInterval(() => setElapsedMs(Date.now() - start), 1000);
    return () => {
      clearTimeout(startTimer);
      clearInterval(id);
    };
  }, [running]);

  // First terminal transition after we saw it running: freeze the end span.
  // Deferred to a timer callback so it is not a synchronous effect-body write.
  useEffect(() => {
    if (running || clientStart === undefined) return;
    const endTimer = setTimeout(
      () => setClientEnd((prev) => prev ?? Date.now()),
      0,
    );
    return () => clearTimeout(endTimer);
  }, [running, clientStart]);

  // Live elapsed timer while running. `elapsedMs` is 0 until the first tick and
  // `clientStart` is set on the next frame, so the very first render returns
  // undefined (nothing meaningful to show yet).
  if (running) {
    if (clientStart === undefined) return undefined;
    return formatDurationMs(elapsedMs);
  }

  // Terminal: exact server span if available, else the client-observed span.
  const serverDuration = formatToolDuration(startedAt, completedAt);
  if (serverDuration) return serverDuration;

  const startMs = toMs(startedAt) ?? clientStart;
  const endMs =
    toMs(completedAt) ?? (clientStart !== undefined ? clientEnd : undefined);
  if (startMs !== undefined && endMs !== undefined && endMs >= startMs) {
    return formatDurationMs(endMs - startMs);
  }
  return undefined;
}
