import { lt } from "drizzle-orm";
import { chat as chatTable } from "../db/schema.ts";
import type { ChatStatus } from "@platypus/schemas";

export const RUN_HEARTBEAT_INTERVAL_MS = 15_000;

// why: four missed beats, so a slow write or a busy event loop isn't read as a dead run
export const RUN_HEARTBEAT_STALE_MS = 4 * RUN_HEARTBEAT_INTERVAL_MS;

export const runHeartbeatCutoff = (now: number = Date.now()): Date =>
  new Date(now - RUN_HEARTBEAT_STALE_MS);

export const chatRunStale = (cutoff: Date) =>
  lt(chatTable.runHeartbeatAt, cutoff);

export const chatRunIsLive = (
  chat: { status: ChatStatus; runHeartbeatAt: Date },
  now: number = Date.now(),
): boolean =>
  chat.status === "running" && chat.runHeartbeatAt >= runHeartbeatCutoff(now);
