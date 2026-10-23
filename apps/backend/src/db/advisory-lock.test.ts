import { describe, expect, it, vi } from "vitest";
import {
  ADVISORY_LOCK_IDS,
  withAdvisoryLock,
  type LockPool,
} from "./advisory-lock.ts";
import {
  fakeLockPool as fakePool,
  type FakeLockClient,
} from "./advisory-lock.test-fixtures.ts";
import { mockLogger } from "../test-setup.ts";

describe.each([{ wait: true }, { wait: false }] as const)(
  "withAdvisoryLock (wait: $wait)",
  (options) => {
    it("returns the work's result and releases the lock and its connection", async () => {
      const pg = fakePool();

      const result = await withAdvisoryLock(
        pg.pool,
        7,
        () => Promise.resolve("done"),
        options,
      );

      expect(result).toBe("done");
      expect(pg.held.has(7)).toBe(false);
      expect(pg.checkedOut).toHaveLength(1);
      expect(pg.checkedOut[0].release).toHaveBeenCalledWith(undefined);
    });

    it("releases the lock even when the work issues its own queries", async () => {
      const pg = fakePool();
      // The work's queries land on other pooled connections, as a job's do.
      // The unlock must still go through the connection holding the lock.
      const work = async () => {
        const other = await pg.pool.connect();
        await other.query("SELECT 1");
        other.release();
      };

      await withAdvisoryLock(pg.pool, 7, work, options);

      expect(pg.held.has(7)).toBe(false);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("lets the next caller take the lock again", async () => {
      const pg = fakePool();
      const work = vi.fn(() => Promise.resolve());

      await withAdvisoryLock(pg.pool, 7, work, options);
      await withAdvisoryLock(pg.pool, 7, work, options);

      expect(work).toHaveBeenCalledTimes(2);
      expect(pg.held.has(7)).toBe(false);
    });

    it("does not stop callers of a different lock", async () => {
      const pg = fakePool();
      let finishFirst!: () => void;

      const first = withAdvisoryLock(
        pg.pool,
        7,
        () => new Promise<void>((resolve) => (finishFirst = resolve)),
        options,
      );
      await vi.waitFor(() => expect(finishFirst).toBeDefined());

      await expect(
        withAdvisoryLock(pg.pool, 8, () => Promise.resolve("other"), options),
      ).resolves.toBe("other");

      finishFirst();
      await first;
    });

    it("releases the lock and rethrows when the work throws", async () => {
      const pg = fakePool();

      await expect(
        withAdvisoryLock(
          pg.pool,
          7,
          () => Promise.reject(new Error("boom")),
          options,
        ),
      ).rejects.toThrow("boom");

      expect(pg.held.has(7)).toBe(false);
      // The unlock worked, so the connection is fit to go back to the pool.
      expect(pg.checkedOut[0].release).toHaveBeenCalledWith(undefined);
    });

    it("discards the connection, and with it the lock, when the unlock fails", async () => {
      const pg = fakePool();

      const result = await withAdvisoryLock(
        pg.pool,
        7,
        () => {
          // The lock is already taken by now; only the unlock hits this.
          pg.checkedOut[0].query = () =>
            Promise.reject(new Error("connection reset"));
          return Promise.resolve("done");
        },
        options,
      );

      // The work succeeded; ending the session is what frees the lock.
      expect(result).toBe("done");
      expect(pg.checkedOut[0].release).toHaveBeenCalledWith(expect.any(Error));
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ lockId: 7 }),
        expect.any(String),
      );
    });

    it("warns when the unlock reports the lock was not held", async () => {
      const pg = fakePool();

      await withAdvisoryLock(
        pg.pool,
        7,
        () => {
          pg.held.delete(7);
          return Promise.resolve();
        },
        options,
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ lockId: 7 }),
        expect.any(String),
      );
      expect(pg.checkedOut[0].release).toHaveBeenCalledTimes(1);
    });

    it("runs no work and discards the connection when taking the lock fails", async () => {
      const pg = fakePool();
      const pool: LockPool = {
        connect: async () => {
          const client = (await pg.pool.connect()) as FakeLockClient;
          client.query = () => Promise.reject(new Error("connection reset"));
          return client;
        },
      };
      const work = vi.fn();

      await expect(withAdvisoryLock(pool, 7, work, options)).rejects.toThrow(
        "connection reset",
      );

      expect(work).not.toHaveBeenCalled();
      expect(pg.checkedOut[0].release).toHaveBeenCalledWith(expect.any(Error));
    });
  },
);

describe("withAdvisoryLock (wait: true)", () => {
  it("makes a concurrent caller wait until the holder has finished", async () => {
    const pg = fakePool();
    const order: string[] = [];
    let finishFirst!: () => void;

    const first = withAdvisoryLock(
      pg.pool,
      7,
      async () => {
        order.push("first:start");
        await new Promise<void>((resolve) => (finishFirst = resolve));
        order.push("first:end");
      },
      { wait: true },
    );
    // Let the first caller take the lock before the second asks for it.
    await vi.waitFor(() => expect(order).toEqual(["first:start"]));

    const second = withAdvisoryLock(
      pg.pool,
      7,
      () => {
        order.push("second");
        return Promise.resolve();
      },
      { wait: true },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["first:start"]);

    finishFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(pg.held.has(7)).toBe(false);
  });
});

describe("withAdvisoryLock (wait: false)", () => {
  it("skips the work when a peer holds the lock, and hands the connection back", async () => {
    const pg = fakePool();
    pg.held.set(7, 999);
    const work = vi.fn(() => Promise.resolve("done"));

    const result = await withAdvisoryLock(pg.pool, 7, work, { wait: false });

    expect(result).toBeUndefined();
    expect(work).not.toHaveBeenCalled();
    // The peer's lock is untouched: a skipped caller never unlocks.
    expect(pg.held.get(7)).toBe(999);
    expect(pg.checkedOut).toHaveLength(1);
    expect(pg.checkedOut[0].release).toHaveBeenCalledWith(undefined);
  });

  it("skips a concurrent caller rather than making it wait", async () => {
    const pg = fakePool();
    let finishFirst!: () => void;

    const first = withAdvisoryLock(
      pg.pool,
      7,
      () => new Promise<void>((resolve) => (finishFirst = resolve)),
      { wait: false },
    );
    await vi.waitFor(() => expect(finishFirst).toBeDefined());

    const second = vi.fn(() => Promise.resolve());
    await withAdvisoryLock(pg.pool, 7, second, { wait: false });
    expect(second).not.toHaveBeenCalled();

    finishFirst();
    await first;
    expect(pg.held.has(7)).toBe(false);
  });
});

describe("ADVISORY_LOCK_IDS", () => {
  it("gives every lock its own id", () => {
    const ids = Object.values(ADVISORY_LOCK_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the ids already in use by deployed backends", () => {
    // An old and a new instance must contend for the same lock during a
    // rolling restart, so these values never change.
    expect(ADVISORY_LOCK_IDS.scheduler).toBe(987654321);
    expect(ADVISORY_LOCK_IDS.memoryExtraction).toBe(123456789);
    expect(ADVISORY_LOCK_IDS.migrations).toBe(314159265);
    expect(ADVISORY_LOCK_IDS.seed).toBe(271828182);
  });
});
