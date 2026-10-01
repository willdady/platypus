import { logger } from "../logger.ts";

/**
 * Every Postgres advisory lock id the backend takes, in one place so no two
 * ever collide. The values are load bearing across deploys: an old and a new
 * instance must contend for the same lock during a rolling restart, so never
 * change one when renaming things — only add new ids.
 */
export const ADVISORY_LOCK_IDS = {
  /** The background trigger/chat scheduler's tick (`startScheduler`). */
  scheduler: 987654321,
  /** The memory extraction tick (`startMemoryScheduler`). */
  memoryExtraction: 123456789,
  /** The Drizzle migrator run by `scripts/migrate.ts` before startup. */
  migrations: 314159265,
  /** The first-boot seed (`seedFirstBoot`). */
  seed: 271828182,
} as const;

/** The slice of a node-postgres PoolClient the lock needs. */
export type LockClient = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
  release: (err?: Error) => void;
};

/** The slice of a node-postgres Pool the lock needs. */
export type LockPool = { connect: () => Promise<LockClient> };

/**
 * Runs `fn` while holding the advisory lock `lockId`, waiting for as long as
 * another session holds it. Use it for one-off startup work that every replica
 * must see done before it continues — the waiter then finds the work already
 * done — rather than for periodic work a peer can simply skip, which is what
 * `runWithLock` in the scheduler is for.
 *
 * An advisory lock belongs to the connection that took it, so the lock and its
 * unlock go through one connection checked out for the whole call; `fn`'s own
 * queries can still use the pool. A lock query that fails destroys that
 * connection rather than returning it to the pool: ending its session is what
 * frees any lock it still holds.
 */
export async function withAdvisoryLock<T>(
  pool: LockPool,
  lockId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;

  try {
    try {
      await client.query("SELECT pg_advisory_lock($1)", [lockId]);
    } catch (error) {
      broken = toError(error);
      throw error;
    }

    try {
      return await fn();
    } finally {
      try {
        const unlockResult = await client.query(
          "SELECT pg_advisory_unlock($1) as released",
          [lockId],
        );
        if (!unlockResult.rows[0]?.released) {
          logger.warn(
            { lockId },
            "Unlock found no advisory lock held by this connection",
          );
        }
      } catch (error) {
        broken = toError(error);
        logger.error(
          { error, lockId },
          "Failed to release an advisory lock, discarding its connection",
        );
      }
    }
  } finally {
    client.release(broken);
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
