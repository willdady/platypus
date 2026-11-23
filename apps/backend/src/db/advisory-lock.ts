import { logger } from "../logger.ts";

export const ADVISORY_LOCK_IDS = {
  scheduler: 987654321,
  memoryExtraction: 123456789,
  migrations: 314159265,
  seed: 271828182,
} as const;

export type LockClient = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
  release: (err?: Error) => void;
};

export type LockPool = { connect: () => Promise<LockClient> };

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
