import { count, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { db } from "../index.ts";
import { logger } from "../logger.ts";
import { organization, organizationMember, user } from "./schema.ts";

/** The Drizzle handle the seed writes through. */
export type SeedDatabase = typeof db;

/** Environment variables the seed reads. */
type SeedEnv = {
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
};

/**
 * Creates the admin User and returns its id. In production this is the
 * better-auth admin plugin's `createUser` — the administrative API, not public
 * sign-up, so seeding works whether or not the Operator has closed
 * registration (#550). It owns its own database access and so writes outside
 * any transaction the seed opens — the reason `seedFirstBoot` compensates for
 * the User explicitly instead of relying on rollback.
 */
export type AdminCreateUser = (input: {
  email: string;
  password: string;
  name: string;
}) => Promise<{ id: string }>;

export type SeedDeps = {
  createUser: AdminCreateUser;
  /** Defaults to `process.env`. */
  env?: SeedEnv;
};

export type SeedResult =
  | { seeded: false }
  | {
      seeded: true;
      organizationId: string;
      userId: string;
    };

/**
 * A seed failure no amount of retrying can fix — missing configuration, or
 * input better-auth rejected outright. Startup surfaces this immediately rather
 * than burning the backoff schedule on a deterministic error.
 */
export class NonRetryableSeedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NonRetryableSeedError";
  }
}

/**
 * better-auth rejects invalid input (a malformed email, an email already
 * taken) with a 4xx `APIError`. Those are deterministic; 5xx and plain
 * transport errors are not.
 */
const isDeterministicRejection = (error: unknown): boolean => {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" && status >= 400 && status < 500;
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * better-auth's default minimum, which its sign-up and password-change
 * endpoints enforce. The administrative create-user API the seed goes through
 * hashes whatever it is given, so the seed checks this itself — a short
 * ADMIN_PASSWORD fails loudly here rather than being accepted.
 */
const MIN_ADMIN_PASSWORD_LENGTH = 8;

/**
 * Bootstraps an empty database with the Default Organization, the admin User
 * from `ADMIN_EMAIL` / `ADMIN_PASSWORD` and that User's Organization membership.
 * No Workspace: one without a Provider cannot run a Chat, so the admin creates
 * the first one through the same flow as every other, which asks for a Provider.
 *
 * The invariant is that no partially seeded state survives a failure (#369).
 * Configuration is validated before anything is written; the Organization and
 * membership are written in one transaction; and the User — which
 * better-auth writes outside that transaction — is deleted again if the
 * transaction fails. A database that already has an Organization is left
 * untouched and nothing is logged, so restarts stay a silent no-op.
 */
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

  // Validate before writing: a missing variable must cost nothing, so that the
  // operator's next attempt starts from a clean database.
  const missing = (["ADMIN_EMAIL", "ADMIN_PASSWORD"] as const).filter(
    (name) => !env[name],
  );
  if (missing.length > 0) {
    const names = missing.join(" and ");
    const isAre =
      missing.length > 1
        ? "environment variables are"
        : "environment variable is";
    throw new NonRetryableSeedError(
      `${names} ${isAre} required to seed the initial admin user. Set ${names} and restart.`,
    );
  }
  const email = env.ADMIN_EMAIL!;
  const password = env.ADMIN_PASSWORD!;
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
    // The transaction rolled back, but better-auth's User row is outside it.
    // Remove it so the next attempt starts from an empty database.
    await compensateUser(database, adminId);
    throw error;
  }
};

/**
 * Creates the admin User through better-auth and returns its id.
 *
 * A User already holding `ADMIN_EMAIL` stops the seed rather than being adopted:
 * compensation runs against the database that just failed, so it can fail too,
 * and the account left behind is not necessarily one the Operator created —
 * promoting whoever holds that address to admin is an escalation, not a
 * recovery. Deleting one row is a cheap fix; the message says so.
 */
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

/** Best-effort removal of the User created before the failed transaction. */
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

/**
 * A database seeded by a release that wrote the Organization outside a
 * transaction can hold an Organization with no members — a stack nobody can
 * sign into, which every restart since has skipped silently. Say so, once, on
 * every boot: it is the only diagnostic such an operator gets.
 */
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
