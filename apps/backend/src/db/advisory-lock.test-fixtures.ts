import { vi, type Mock } from "vitest";
import type { LockClient, LockPool } from "./advisory-lock.ts";

export type FakeLockClient = LockClient & {
  release: Mock<(err?: Error) => void>;
};

/**
 * A stand-in for a node-postgres Pool modelling what `withAdvisoryLock` turns
 * on: `pg_advisory_lock` blocks until no other connection holds the lock, and
 * only the connection holding a lock can release it.
 */
export const fakeLockPool = () => {
  const held = new Map<number, number>();
  const waiters = new Map<number, (() => void)[]>();
  const checkedOut: FakeLockClient[] = [];
  let nextId = 1;

  const run = async (connection: number, text: string, values: unknown[]) => {
    const lockId = Number(values[0]);
    if (text.includes("pg_advisory_lock")) {
      while (held.has(lockId) && held.get(lockId) !== connection) {
        await new Promise<void>((resolve) =>
          waiters.set(lockId, [...(waiters.get(lockId) ?? []), resolve]),
        );
      }
      held.set(lockId, connection);
      return { rows: [] };
    }
    if (text.includes("pg_advisory_unlock")) {
      const released = held.get(lockId) === connection;
      if (released) {
        held.delete(lockId);
        const queue = waiters.get(lockId) ?? [];
        waiters.delete(lockId);
        queue.forEach((wake) => wake());
      }
      return { rows: [{ released }] };
    }
    return { rows: [] };
  };

  const pool: LockPool = {
    connect: () => {
      const connection = nextId++;
      const client: FakeLockClient = {
        query: (text: string, values: unknown[] = []) =>
          run(connection, text, values),
        release: vi.fn<(err?: Error) => void>(),
      };
      checkedOut.push(client);
      return Promise.resolve(client);
    },
  };

  return { pool, held, checkedOut };
};
