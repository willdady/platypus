import { count, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { db } from "../index.ts";
import { logger } from "../logger.ts";
import { errorMessage } from "../utils/error-message.ts";
import {
  ADVISORY_LOCK_IDS,
  withAdvisoryLock,
  type LockPool,
} from "./advisory-lock.ts";
import { organization, organizationMember, user } from "./schema.ts";

export type SeedDatabase = typeof db;

type SeedEnv = {
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  NODE_ENV?: string;
};

const WELL_KNOWN_ADMIN_EMAIL = "admin@example.com";
const WELL_KNOWN_ADMIN_PASSWORD = "admin123";

export type AdminCreateUser = (input: {
  email: string;
  password: string;
  name: string;
}) => Promise<{ id: string }>;

export type SeedDeps = {
  createUser: AdminCreateUser;
  env?: SeedEnv;
};

export type SeedResult =
  | { seeded: false }
  | {
      seeded: true;
      organizationId: string;
      userId: string;
    };

export class NonRetryableSeedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NonRetryableSeedError";
  }
}

const isDeterministicRejection = (error: unknown): boolean => {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" && status >= 400 && status < 500;
};

const MIN_ADMIN_PASSWORD_LENGTH = 8;

export const seedFirstBoot = async (
  database: SeedDatabase,
  deps: SeedDeps,
): Promise<SeedResult> => {
  const env = deps.env ?? process.env;

  const [orgCount] = await database
    .select({ value: count() })
    .from(organization);

  if ((orgCount?.value ?? 0) > 0) {
    await warnIfHalfSeeded(database);
    return { seeded: false };
  }

  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = env;
  if (!email || !password) {
    const missing = (["ADMIN_EMAIL", "ADMIN_PASSWORD"] as const).filter(
      (name) => !env[name],
    );
    const names = missing.join(" and ");
    const isAre =
      missing.length > 1
        ? "environment variables are"
        : "environment variable is";
    throw new NonRetryableSeedError(
      `${names} ${isAre} required to seed the initial admin user. Set ${names} and restart.`,
    );
  }
  if (
    env.NODE_ENV === "production" &&
    email.trim().toLowerCase() === WELL_KNOWN_ADMIN_EMAIL &&
    password === WELL_KNOWN_ADMIN_PASSWORD
  ) {
    throw new NonRetryableSeedError(
      `ADMIN_EMAIL / ADMIN_PASSWORD are the well-known example credentials, which a production deployment must not use. Set your own (ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters) and restart.`,
    );
  }
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new NonRetryableSeedError(
      `ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters. Set a longer one and restart.`,
    );
  }

  logger.info("No organizations found. Seeding initial data...");

  const adminId = await createAdminUser(database, deps.createUser, {
    email,
    password,
  });

  try {
    const result = await database.transaction(async (tx) => {
      const organizationId = nanoid();
      await tx.insert(organization).values({
        id: organizationId,
        name: "Default Organization",
      });

      await tx
        .update(user)
        .set({ role: "admin", emailVerified: true })
        .where(eq(user.id, adminId));

      await tx.insert(organizationMember).values({
        id: nanoid(),
        organizationId,
        userId: adminId,
        role: "admin",
      });

      return {
        seeded: true as const,
        organizationId,
        userId: adminId,
      };
    });

    logger.info(
      {
        organizationId: result.organizationId,
        userId: result.userId,
      },
      "Seeded Default Organization, admin user and membership",
    );
    logger.info(`- Default credentials: ${email} / ${password}`);
    logger.info("⚠️  Please change the default password after first login!");

    return result;
  } catch (error) {
    await compensateUser(database, adminId);
    throw error;
  }
};

export const seedFirstBootExclusively = (
  database: SeedDatabase,
  lockPool: LockPool,
  deps: SeedDeps,
): Promise<SeedResult> =>
  withAdvisoryLock(
    lockPool,
    ADVISORY_LOCK_IDS.seed,
    () => seedFirstBoot(database, deps),
    { wait: true },
  );

const createAdminUser = async (
  database: SeedDatabase,
  createUser: AdminCreateUser,
  credentials: { email: string; password: string },
): Promise<string> => {
  const [existing] = await database
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, credentials.email))
    .limit(1);

  if (existing) {
    throw new NonRetryableSeedError(
      `A user already exists for ${credentials.email} in a database with no organizations, most likely left behind by a first boot that failed. Refusing to seed rather than promote an existing account to admin. Delete that user (or point ADMIN_EMAIL at a different address) and restart.`,
    );
  }

  try {
    const created = await createUser({
      email: credentials.email,
      password: credentials.password,
      name: "Admin User",
    });
    logger.info(`- User created: ${credentials.email}`);
    return created.id;
  } catch (error) {
    if (isDeterministicRejection(error)) {
      throw new NonRetryableSeedError(
        `Could not create the admin user for ${credentials.email}: ${errorMessage(
          error,
        )}. Fix ADMIN_EMAIL / ADMIN_PASSWORD and restart.`,
        { cause: error },
      );
    }
    throw error;
  }
};

const compensateUser = async (database: SeedDatabase, userId: string) => {
  try {
    await database.delete(user).where(eq(user.id, userId));
    logger.warn(
      { userId },
      "Seed failed — removed the admin user created before the failure so the next attempt starts clean",
    );
  } catch (error) {
    logger.error(
      { err: error, userId },
      "Seed failed and the admin user created before the failure could not be removed. Delete that user before the next attempt, which will otherwise refuse to seed over it.",
    );
  }
};

const warnIfHalfSeeded = async (database: SeedDatabase) => {
  const [memberCount] = await database
    .select({ value: count() })
    .from(organizationMember);

  if ((memberCount?.value ?? 0) === 0) {
    logger.error(
      'This database has an organization but no organization members, so nobody can sign in. A first boot failed partway through, before seeding was atomic. To recover, either delete the empty organization ("DELETE FROM organization;" against a database with no other data) and restart so this seed runs again, or start over with "docker compose down -v".',
    );
  }
};
