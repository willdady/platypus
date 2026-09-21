/**
 * Keepalive for a streamed run's HTTP response.
 *
 * A Chat turn can go a long time with nothing to say: one slow MCP call or one
 * sandbox shell exec produces no model output at all, and the per-step bound
 * that would notice a genuine stall is measured in minutes. An intermediary
 * with a 60-second idle timeout — nginx, a corporate proxy — wins that race and
 * tears down a run that was perfectly healthy. Periodic bytes are what stop it,
 * and they are also the only thing a client could build a dead-socket watchdog
 * on: with no traffic at all, a socket that dies silently produces no event.
 *
 * The bytes are SSE comments, injected into the encoded response body rather
 * than the run's chunk stream. Two reasons that boundary matters:
 *
 * - A comment is inert by construction. The UI message protocol has no "no-op
 *   chunk", and anything that IS a chunk would reach the message the client is
 *   folding. `eventsource-parser` drops a comment line unless a consumer asks
 *   for one, which nothing here does.
 * - The run stream is teed — a client branch and a server-side drain that keeps
 *   the persisted messages current. Injecting after the response is built puts
 *   the heartbeat past the tee, so the drain cannot observe it.
 */

/** How often a silent stream puts bytes on the wire. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * One SSE comment frame. A line opening with `:` carries no event, so a
 * conforming parser reads it and moves on.
 */
export const SSE_HEARTBEAT_FRAME = ": heartbeat\n\n";

/**
 * Copies `source` through, adding a heartbeat frame every `intervalMs`.
 *
 * Frames are enqueued between whole source chunks — the encoder upstream emits
 * one complete `data:` frame per chunk, and a timer callback cannot interleave
 * with an enqueue — so a heartbeat can never land inside another frame.
 *
 * The source is read from `pull` rather than pumped from `start`, so
 * backpressure survives the wrapping: a slow client still slows the reads
 * instead of having the whole run's bytes buffered on its behalf. The heartbeat
 * is the one thing that does not wait to be asked for, which is the point of it.
 */
export const withHeartbeatFrames = (
  source: ReadableStream<Uint8Array>,
  intervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const reader = source.getReader();
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopBeating = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(SSE_HEARTBEAT_FRAME));
        } catch {
          // The consumer closed the stream between the tick being scheduled
          // and it running. Nothing left to keep alive.
          stopBeating();
        }
      }, intervalMs);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          stopBeating();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        stopBeating();
        controller.error(error);
      }
    },
    cancel(reason) {
      stopBeating();
      return reader.cancel(reason);
    },
  });
};

/**
 * The same response, with its body kept alive while the run is silent.
 *
 * Returned unchanged when there is no body to keep alive, so a caller wraps
 * unconditionally rather than testing first.
 */
export const withStreamKeepalive = (
  response: Response,
  intervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
): Response => {
  if (!response.body) return response;
  return new Response(withHeartbeatFrames(response.body, intervalMs), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
