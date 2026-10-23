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
 * Runs `fn` while holding the advisory lock `lockId`.
 *
 * With `wait: true` it waits for as long as another session holds the lock.
 * Use it for one-off startup work that every replica must see done before it
 * continues — the waiter then finds the work already done.
 *
 * With `wait: false` it gives up at once when another session holds the lock,
 * skipping `fn` and resolving `undefined`. Use it for periodic work a peer can
 * simply skip, such as a background job's tick: the next tick tries again.
 *
 * An advisory lock belongs to the connection that took it, so the lock and its
 * unlock go through one connection checked out for the whole call. Sent through
 * the pool they could land on different connections: the unlock would then
 * release nothing, and the lock would stay held by an idle pooled connection.
 * `fn`'s own queries can still use the pool. A lock query that fails destroys
 * that connection rather than returning it to the pool: ending its session is
 * what frees any lock it still holds. `fn` failing says nothing about the
 * connection, so it goes back to the pool.
 */
export async function withAdvisoryLock<T>(
  pool: LockPool,
  lockId: number,
  fn: () => Promise<T>,
  options: { wait: true },
): Promise<T>;
export async function withAdvisoryLock<T>(
  pool: LockPool,
  lockId: number,
  fn: () => Promise<T>,
  options: { wait: boolean },
): Promise<T | undefined>;
export async function withAdvisoryLock<T>(
  pool: LockPool,
  lockId: number,
  fn: () => Promise<T>,
  { wait }: { wait: boolean },
): Promise<T | undefined> {
  const client = await pool.connect();
  let broken: Error | undefined;

  try {
    try {
      if (wait) {
        await client.query("SELECT pg_advisory_lock($1)", [lockId]);
      } else {
        const lockResult = await client.query(
          "SELECT pg_try_advisory_lock($1) as acquired",
          [lockId],
        );
        if (!lockResult.rows[0]?.acquired) {
          logger.debug(
            { lockId },
            "Another backend instance holds this advisory lock, skipping",
          );
          return undefined;
        }
      }
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
