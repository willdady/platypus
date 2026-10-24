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
 * when it drops. Returns a stop handle that closes the connection and stops
 * reconnecting.
 *
 * ponytail: reconnects only on a connection `error`; a silently half-open
 * socket stays deaf until something else notices. Add a periodic heartbeat
 * query if that bites.
 */
export const startNotificationListener = (): (() => void) => {
  let stopped = false;
  let client: PoolClient | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const listen = async (): Promise<void> => {
    let lost = false;
    const reconnect = (err: unknown) => {
      if (lost || stopped) return;
      lost = true;
      logger.error({ err }, "Notification listener lost its connection");
      client?.release(err instanceof Error ? err : true);
      client = undefined;
      retry = setTimeout(() => void listen(), RECONNECT_MS);
    };
    try {
      const connected = await db.$client.connect();
      // Stopped while connecting: nothing will release it otherwise.
      if (stopped) {
        connected.release(true);
        return;
      }
      client = connected;
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

  void listen();
  return () => {
    stopped = true;
    clearTimeout(retry);
    // Destroyed, not returned: a pooled connection would keep LISTENing.
    client?.release(true);
    client = undefined;
  };
};
