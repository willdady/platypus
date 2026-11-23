import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbError, seedDb, type Store } from "../test-utils.ts";
import { fakeLockPool } from "./advisory-lock.test-fixtures.ts";
import {
  seedFirstBoot,
  seedFirstBootExclusively,
  NonRetryableSeedError,
  type SeedDatabase,
  type AdminCreateUser,
} from "./seed.ts";
import { logger } from "../logger.ts";

const createFakeDb = (
  options: { onInsert?: (table: string) => void } = {},
): { handle: unknown; tables: Store } =>
  seedDb(
    { organization: [], user: [], organization_member: [], workspace: [] },
    {
      onInsert: options.onInsert,
      unique: { user: [{ name: "user_email_key", columns: ["email"] }] },
    },
  );

const asSeedDb = (fake: { handle: unknown }) => fake.handle as SeedDatabase;

const createUserApi = (
  tables: Store,
  behaviour: { fail?: Error } = {},
): AdminCreateUser => {
  let n = 0;
  return vi.fn(({ email, name }) => {
    if (behaviour.fail) return Promise.reject(behaviour.fail);
    if (tables.user.some((row) => row.email === email)) {
      return Promise.reject(
        new Error("duplicate key value violates unique constraint"),
      );
    }
    const id = `user-${++n}`;
    tables.user.push({
      id,
      email,
      name,
      role: "user",
      emailVerified: false,
    });
    return Promise.resolve({ id });
  });
};

const VALID_ENV = {
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_PASSWORD: "s3cret!!",
};

describe("seedFirstBoot", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("seeds an organization, admin user and membership, and no workspace, on an empty database", async () => {
    const fake = createFakeDb();
    const createUser = createUserApi(fake.tables);

    const result = await seedFirstBoot(asSeedDb(fake), {
      createUser,
      env: VALID_ENV,
    });

    expect(result.seeded).toBe(true);
    expect(fake.tables.organization).toHaveLength(1);
    expect(fake.tables.user).toHaveLength(1);
    expect(fake.tables.organization_member).toHaveLength(1);
    expect(fake.tables.workspace).toHaveLength(0);

    const [admin] = fake.tables.user;
    expect(admin).toMatchObject({
      email: VALID_ENV.ADMIN_EMAIL,
      role: "admin",
      emailVerified: true,
    });
    expect(fake.tables.organization_member[0]).toMatchObject({
      organizationId: fake.tables.organization[0].id,
      userId: admin.id,
      role: "admin",
    });
  });

  it("writes nothing and names the missing variable when ADMIN_EMAIL is unset", async () => {
    const fake = createFakeDb();
    const createUser = createUserApi(fake.tables);

    await expect(
      seedFirstBoot(asSeedDb(fake), {
        createUser,
        env: { ADMIN_PASSWORD: "s3cret!!" },
      }),
    ).rejects.toThrow(/ADMIN_EMAIL/);

    expect(fake.tables.organization).toHaveLength(0);
    expect(fake.tables.user).toHaveLength(0);
    expect(createUser).not.toHaveBeenCalled();
  });

  it("names ADMIN_PASSWORD when it is the unset one, and does not retry", async () => {
    const fake = createFakeDb();

    const error = await seedFirstBoot(asSeedDb(fake), {
      createUser: createUserApi(fake.tables),
      env: { ADMIN_EMAIL: "admin@example.com" },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NonRetryableSeedError);
    expect((error as Error).message).toMatch(/ADMIN_PASSWORD/);
    expect(fake.tables.organization).toHaveLength(0);
  });

  it("names both variables when neither is set", async () => {
    const fake = createFakeDb();

    await expect(
      seedFirstBoot(asSeedDb(fake), {
        createUser: createUserApi(fake.tables),
        env: {},
      }),
    ).rejects.toThrow(
      "ADMIN_EMAIL and ADMIN_PASSWORD environment variables are required",
    );
  });

  it("refuses an ADMIN_PASSWORD shorter than 8 characters before writing anything", async () => {
    const fake = createFakeDb();
    const createUser = createUserApi(fake.tables);

    const error = await seedFirstBoot(asSeedDb(fake), {
      createUser,
      env: { ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: "short" },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NonRetryableSeedError);
    expect((error as Error).message).toMatch(/ADMIN_PASSWORD/);
    expect((error as Error).message).toMatch(/8 characters/);
    expect(createUser).not.toHaveBeenCalled();
    expect(fake.tables.user).toHaveLength(0);
    expect(fake.tables.organization).toHaveLength(0);
  });

  it("refuses the well-known admin credentials in production", async () => {
    const fake = createFakeDb();
    const createUser = createUserApi(fake.tables);

    const error = await seedFirstBoot(asSeedDb(fake), {
      createUser,
      env: {
        ADMIN_EMAIL: "admin@example.com",
        ADMIN_PASSWORD: "admin123",
        NODE_ENV: "production",
      },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NonRetryableSeedError);
    expect((error as Error).message).toMatch(/ADMIN_EMAIL \/ ADMIN_PASSWORD/);
    expect(createUser).not.toHaveBeenCalled();
    expect(fake.tables.organization).toHaveLength(0);
  });

  it("keeps the development flow working with those credentials outside production", async () => {
    const fake = createFakeDb();

    const result = await seedFirstBoot(asSeedDb(fake), {
      createUser: createUserApi(fake.tables),
      env: {
        ADMIN_EMAIL: "admin@example.com",
        ADMIN_PASSWORD: "admin123",
        NODE_ENV: "development",
      },
    });

    expect(result.seeded).toBe(true);
  });

  it("leaves no organization behind when a write after the organization insert fails", async () => {
    const fake = createFakeDb({
      onInsert: (table) => {
        if (table === "organization_member")
          throw dbError("08006", "connection terminated");
      },
    });

    await expect(
      seedFirstBoot(asSeedDb(fake), {
        createUser: createUserApi(fake.tables),
        env: VALID_ENV,
      }),
    ).rejects.toMatchObject({ cause: { message: "connection terminated" } });

    expect(fake.tables.organization).toHaveLength(0);
    expect(fake.tables.organization_member).toHaveLength(0);
    expect(fake.tables.workspace).toHaveLength(0);
    expect(fake.tables.user).toHaveLength(0);
  });

  it("tells the operator which User to delete when the compensation itself fails", async () => {
    const fake = createFakeDb({
      onInsert: (table) => {
        if (table === "organization_member")
          throw dbError("08006", "connection terminated");
      },
    });
    const handle = asSeedDb(fake);
    const noDelete = new Proxy(handle, {
      get: (target, prop, receiver) =>
        prop === "delete"
          ? () => {
              throw dbError("08006", "database gone");
            }
          : (Reflect.get(target, prop, receiver) as unknown),
    });
    const error = vi.spyOn(logger, "error");

    await expect(
      seedFirstBoot(noDelete, {
        createUser: createUserApi(fake.tables),
        env: VALID_ENV,
      }),
    ).rejects.toMatchObject({ cause: { message: "connection terminated" } });

    expect(fake.tables.user).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      { err: expect.any(Error) as unknown, userId: fake.tables.user[0].id },
      expect.stringContaining("Delete that user before the next attempt"),
    );
  });

  it("seeds successfully on a retry after a failed attempt (regression: #369)", async () => {
    let failing = true;
    const fake = createFakeDb({
      onInsert: (table) => {
        if (failing && table === "organization_member") {
          throw dbError("08006", "connection terminated");
        }
      },
    });
    const createUser = createUserApi(fake.tables);

    await expect(
      seedFirstBoot(asSeedDb(fake), { createUser, env: VALID_ENV }),
    ).rejects.toMatchObject({ cause: { message: "connection terminated" } });

    failing = false;

    const result = await seedFirstBoot(asSeedDb(fake), {
      createUser,
      env: VALID_ENV,
    });

    expect(result.seeded).toBe(true);
    expect(fake.tables.organization).toHaveLength(1);
    expect(fake.tables.user).toHaveLength(1);
    expect(fake.tables.organization_member).toHaveLength(1);
  });

  it("refuses to promote a User that already holds ADMIN_EMAIL", async () => {
    const fake = createFakeDb();
    fake.tables.user.push({
      id: "leftover-user",
      email: VALID_ENV.ADMIN_EMAIL,
      name: "Admin User",
      role: "user",
      emailVerified: false,
    });
    const createUser = createUserApi(fake.tables);

    const error = await seedFirstBoot(asSeedDb(fake), {
      createUser,
      env: VALID_ENV,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NonRetryableSeedError);
    expect((error as Error).message).toMatch(VALID_ENV.ADMIN_EMAIL);
    expect((error as Error).message).toMatch(/Delete that user/);
    expect(createUser).not.toHaveBeenCalled();
    expect(fake.tables.user[0]).toMatchObject({ role: "user" });
    expect(fake.tables.organization).toHaveLength(0);
    expect(fake.tables.organization_member).toHaveLength(0);
  });

  it("is a quiet no-op against an already-seeded database", async () => {
    const fake = createFakeDb();
    const createUser = createUserApi(fake.tables);
    await seedFirstBoot(asSeedDb(fake), { createUser, env: VALID_ENV });

    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");

    const result = await seedFirstBoot(asSeedDb(fake), {
      createUser,
      env: VALID_ENV,
    });

    expect(result).toEqual({ seeded: false });
    expect(fake.tables.organization).toHaveLength(1);
    expect(fake.tables.user).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("requires no admin config to skip an already-seeded database", async () => {
    const fake = createFakeDb();
    await seedFirstBoot(asSeedDb(fake), {
      createUser: createUserApi(fake.tables),
      env: VALID_ENV,
    });

    await expect(
      seedFirstBoot(asSeedDb(fake), {
        createUser: createUserApi(fake.tables),
        env: {},
      }),
    ).resolves.toEqual({ seeded: false });
  });

  it("reports a deterministic better-auth rejection as non-retryable", async () => {
    const fake = createFakeDb();
    const rejection = Object.assign(new Error("Invalid email"), {
      statusCode: 400,
    });

    const error = await seedFirstBoot(asSeedDb(fake), {
      createUser: createUserApi(fake.tables, { fail: rejection }),
      env: VALID_ENV,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NonRetryableSeedError);
    expect((error as Error).message).toMatch(/Invalid email/);
    expect(fake.tables.organization).toHaveLength(0);
    expect(fake.tables.user).toHaveLength(0);
  });

  it("retries a transient better-auth failure rather than giving up", async () => {
    const fake = createFakeDb();

    const error = await seedFirstBoot(asSeedDb(fake), {
      createUser: createUserApi(fake.tables, {
        fail: new Error("socket hang up"),
      }),
      env: VALID_ENV,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetryableSeedError);
    expect(fake.tables.organization).toHaveLength(0);
  });

  it("flags a database left half-seeded by an older release", async () => {
    const fake = createFakeDb();
    fake.tables.organization.push({
      id: "org-1",
      name: "Default Organization",
    });
    const error = vi.spyOn(logger, "error");

    const result = await seedFirstBoot(asSeedDb(fake), {
      createUser: createUserApi(fake.tables),
      env: VALID_ENV,
    });

    expect(result).toEqual({ seeded: false });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("no organization members"),
    );
    expect(fake.tables.organization).toHaveLength(1);
    expect(fake.tables.user).toHaveLength(0);
  });
});

describe("seedFirstBootExclusively", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("seeds once when several replicas boot together, and the others carry on", async () => {
    const fake = createFakeDb();
    const createUser = createUserApi(fake.tables);
    const { pool, held } = fakeLockPool();

    const results = await Promise.all(
      [1, 2, 3].map(() =>
        seedFirstBootExclusively(asSeedDb(fake), pool, {
          createUser,
          env: VALID_ENV,
        }),
      ),
    );

    expect(results.filter((r) => r.seeded)).toHaveLength(1);
    expect(results.filter((r) => !r.seeded)).toHaveLength(2);
    expect(createUser).toHaveBeenCalledTimes(1);
    expect(fake.tables.organization).toHaveLength(1);
    expect(fake.tables.user).toHaveLength(1);
    expect(fake.tables.organization_member).toHaveLength(1);
    expect(held.size).toBe(0);
  });

  it("lets a waiting replica seed after the first one failed", async () => {
    const fake = createFakeDb();
    const createUser = createUserApi(fake.tables);
    const failing = vi
      .fn<AdminCreateUser>()
      .mockRejectedValue(new Error("connection reset"));
    const { pool } = fakeLockPool();

    const [first, second] = await Promise.allSettled([
      seedFirstBootExclusively(asSeedDb(fake), pool, {
        createUser: failing,
        env: VALID_ENV,
      }),
      seedFirstBootExclusively(asSeedDb(fake), pool, {
        createUser,
        env: VALID_ENV,
      }),
    ]);

    expect(first.status).toBe("rejected");
    expect(second).toMatchObject({
      status: "fulfilled",
      value: { seeded: true },
    });
    expect(fake.tables.organization).toHaveLength(1);
  });
});
