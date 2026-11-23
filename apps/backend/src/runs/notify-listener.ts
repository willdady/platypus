import type { PoolClient } from "pg";
import { db } from "../index.ts";
import { logger } from "../logger.ts";

const RECONNECT_MS = 5_000;

const handlers = new Map<string, (payload: string) => void>();

let client: PoolClient | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;

export const onNotification = (
  channel: string,
  handler: (payload: string) => void,
): void => {
  handlers.set(channel, handler);
};

export const notify = async (
  channel: string,
  payload: string,
): Promise<void> => {
  await db.$client.query("SELECT pg_notify($1, $2)", [channel, payload]);
};

export const startNotificationListener = (): (() => void) => {
  stopped = false;
  void listen();
  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    const held = client;
    client = undefined;
    held?.release();
  };
};

const listen = async (): Promise<void> => {
  if (stopped) return;
  // why: a reconnect racing a later one must not start a second listen loop
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
    // why: stopped mid-connect; release now or the shutdown's pool.end() waits on it
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
