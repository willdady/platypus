import { and, isNull, lt, or } from "drizzle-orm";
import { chat as chatTable } from "../db/schema.ts";

/**
 * A Chat's run heartbeat (#1297).
 *
 * The one-run-per-Chat lock is the row's `running` status (#1237), and the
 * process holding the run is the only writer of its end. A process that dies
 * mid-turn — a crash, an OOM, a deploy that does not wait — leaves the row
 * `running` with nobody to end it. So the holder stamps `run_heartbeat_at`
 * every {@link RUN_HEARTBEAT_INTERVAL_MS} while the run lives (`ChatSink`), and
 * a `running` Chat whose stamp is older than {@link RUN_HEARTBEAT_STALE_MS}
 * holds no run: the next claim takes it, the chat routes do not refuse on it,
 * and the recovery sweep marks it failed.
 *
 * A row that has run only before the column existed has no stamp, and is
 * judged on its turn's start instead (`last_turn_at`, else `updated_at`).
 */
export const RUN_HEARTBEAT_INTERVAL_MS = 15_000;

/** Four missed beats: a slow write or a busy event loop is not a death. */
export const RUN_HEARTBEAT_STALE_MS = 4 * RUN_HEARTBEAT_INTERVAL_MS;

/** The moment before which a heartbeat no longer vouches for its run. */
export const runHeartbeatCutoff = (now: number = Date.now()): Date =>
  new Date(now - RUN_HEARTBEAT_STALE_MS);

/**
 * SQL: the Chat's last sign of a live run is older than `cutoff`. Says nothing
 * about the status: pair it with one.
 */
export const chatRunStale = (cutoff: Date) =>
  or(
    lt(chatTable.runHeartbeatAt, cutoff),
    and(
      isNull(chatTable.runHeartbeatAt),
      or(
        lt(chatTable.lastTurnAt, cutoff),
        and(isNull(chatTable.lastTurnAt), lt(chatTable.updatedAt, cutoff)),
      ),
    ),
  );

/** Whether a Chat row is held by a live run: `running`, with a fresh beat. */
export const chatRunIsLive = (
  chat: {
    status: string;
    runHeartbeatAt?: Date | null;
    lastTurnAt?: Date | null;
    updatedAt?: Date | null;
  },
  now: number = Date.now(),
): boolean => {
  if (chat.status !== "running") return false;
  const lastSign = chat.runHeartbeatAt ?? chat.lastTurnAt ?? chat.updatedAt;
  // No timestamp at all reads as live, as the SQL reads it: nothing proves
  // the run dead.
  return !lastSign || lastSign >= runHeartbeatCutoff(now);
};
