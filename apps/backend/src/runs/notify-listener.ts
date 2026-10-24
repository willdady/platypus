import type { PoolClient } from "pg";
import { db } from "../index.ts";
import { logger } from "../logger.ts";

/**
 * What passes between backend instances through Postgres (#1237, #1308).
 * Every instance holds one connection LISTENing on each channel a module has
 * registered, and hands each notification to that channel's handler. A
 * notification sent while it is down is missed: each channel's users say
 * what covers that.
 */
const RECONNECT_MS = 5_000;

const handlers = new Map<string, (payload: string) => void>();

/** The one running connection; held so the stop handle can release it. */
let client: PoolClient | undefined;
/** The pending reconnect, cancelled by the stop handle. */
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
/** `true` once the stop handle ran; the listener then stays down. */
let stopped = false;

/**
 * Hands every notification on `channel` to `handler`. Registered when its
 * module loads, before {@link startNotificationListener} LISTENs.
 */
export const onNotification = (
  channel: string,
  handler: (payload: string) => void,
): void => {
  handlers.set(channel, handler);
};

/** Sends `payload` on `channel` to every instance listening, this one too. */
export const notify = async (
  channel: string,
  payload: string,
): Promise<void> => {
  await db.$client.query("SELECT pg_notify($1, $2)", [channel, payload]);
};

/**
 * Holds one connection LISTENing on every registered channel, reconnecting
 * when it drops.
 *
 * ponytail: reconnects only on a connection `error`; a silently half-open
 * socket stays deaf until something else notices. Add a periodic heartbeat
 * query if that bites.
 *
 * Returns a stop handle for a graceful shutdown: it releases the LISTEN
 * client back to the pool — without that, `pool.end()` waits on the one
 * connection this listener holds for ever — and cancels a pending reconnect.
 */
export const startNotificationListener = (): (() => void) => {
  stopped = false;
  void listen();
  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    const held = client;
    client = undefined;
    // Already errored (released by `reconnect`); releasing again is safe.
    held?.release();
  };
};

const listen = async (): Promise<void> => {
  if (stopped) return;
  // A reconnect scheduled while a later one won raced — only one listen loop.
  let lost = false;
  const reconnect = (err: unknown) => {
    if (lost || stopped) return;
    lost = true;
    logger.error({ err }, "Notification listener lost its connection");
    client?.release(err instanceof Error ? err : true);
    client = undefined;
    reconnectTimer = setTimeout(() => void listen(), RECONNECT_MS);
  };
  try {
    client = await db.$client.connect();
    // Stopped while the connect was in flight: hand the client straight back,
    // so the shutdown drain's `pool.end()` is not held open by it.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set by the returned stop callback during the await, which TS narrowing does not track
    if (stopped) {
      client.release();
      client = undefined;
      return;
    }
    client.on("error", reconnect);
    client.on("notification", ({ channel, payload }) => {
      if (!payload) return;
      handlers.get(channel)?.(payload);
    });
    for (const channel of handlers.keys()) {
      await client.query(`LISTEN ${channel}`);
    }
  } catch (err) {
    reconnect(err);
  }
};
