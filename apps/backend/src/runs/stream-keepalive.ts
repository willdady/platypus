const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export const SSE_HEARTBEAT_FRAME = ": heartbeat\n\n";

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

// why: SSE comments past the tee, so neither the client's message nor the server's drain sees them
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
