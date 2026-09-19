import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { Pool } = pg;

const databaseUrl = process.env.INVITATION_ACCEPT_POSTGRES_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const schemaName = `invitation_accept_${process.pid}_${Date.now()}`.replace(
  /[^a-zA-Z0-9_]/g,
  "_",
);
const schemaSql = `"${schemaName}"`;

type AcceptInvitationForUser =
  typeof import("./invitation-accept.ts").acceptInvitationForUser;

let pool: pg.Pool | undefined;
let acceptInvitationForUser: AcceptInvitationForUser;

const user = {
  id: "user-1",
  name: "Ada",
  email: "ada@example.com",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createSchema = async (dbPool: pg.Pool) => {
  await dbPool.query(`CREATE SCHEMA ${schemaSql}`);
  await dbPool.query(`
    CREATE TABLE invitation (
      id text PRIMARY KEY,
      email text NOT NULL,
      organization_id text NOT NULL,
      invited_by text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      workspace_name text,
      token text,
      expires_at timestamp NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    );

    CREATE TABLE organization_member (
      id text PRIMARY KEY,
      organization_id text NOT NULL,
      user_id text NOT NULL,
      role text NOT NULL DEFAULT 'member',
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );

    CREATE TABLE workspace (
      id text PRIMARY KEY,
      organization_id text NOT NULL,
      owner_id text NOT NULL,
      name text NOT NULL,
      context text,
      task_model_provider_id text,
      memory_extraction_provider_id text,
      memory_embedding_provider_id text,
      max_daily_summaries integer DEFAULT 90,
      provider_self_management boolean NOT NULL DEFAULT false,
      mcp_self_management boolean NOT NULL DEFAULT false,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );

    CREATE TABLE invitation_blueprint (
      id text PRIMARY KEY,
      invitation_id text NOT NULL,
      blueprint_id text NOT NULL,
      position integer NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    );
  `);
};

const seedInvitation = async (id: string, expiresSql: string) => {
  await pool!.query(
    `
      INSERT INTO invitation (
        id, email, organization_id, invited_by, status, workspace_name, token, expires_at
      )
      VALUES ($1, $2, 'org-1', 'admin-1', 'pending', null, $3, ${expiresSql})
    `,
    [id, user.email, `token-${id}`],
  );
};

const scalar = async (sql: string): Promise<number> => {
  const result = await pool!.query<{ value: number }>(sql);
  return result.rows[0]?.value ?? 0;
};

describePostgres("acceptInvitationForUser PostgreSQL locking", () => {
  beforeAll(async () => {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 4,
      options: `-c search_path=${schemaName}`,
    });
    await createSchema(pool);
    const db = drizzle(pool);
    vi.doMock("../index.ts", () => ({ db }));
    ({ acceptInvitationForUser } = await import("./invitation-accept.ts"));
  }, 15_000);

  beforeEach(async () => {
    await pool!.query(
      "TRUNCATE invitation_blueprint, organization_member, workspace, invitation",
    );
  });

  afterAll(async () => {
    vi.doUnmock("../index.ts");
    vi.resetModules();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
      await pool.end();
    }
  });

  it("serializes concurrent accepts so only one workspace is provisioned", async () => {
    await seedInvitation(
      "invite-race",
      "(now() AT TIME ZONE 'UTC') + interval '1 minute'",
    );
    await pool!.query(`
      CREATE OR REPLACE FUNCTION delay_accept_update() RETURNS trigger AS $$
      BEGIN
        IF OLD.status = 'pending' AND NEW.status = 'accepted' THEN
          PERFORM pg_sleep(0.2);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER invitation_accept_delay
      BEFORE UPDATE OF status ON invitation
      FOR EACH ROW EXECUTE FUNCTION delay_accept_update();
    `);

    const first = acceptInvitationForUser("invite-race", user);
    await sleep(25);
    const second = acceptInvitationForUser("invite-race", user);

    const results = await Promise.all([first, second]);

    expect(results).toContainEqual({ outcome: "accepted" });
    expect(results).toContainEqual({ outcome: "not_found" });
    expect(await scalar("SELECT count(*)::int AS value FROM workspace")).toBe(
      1,
    );
    expect(
      await scalar("SELECT count(*)::int AS value FROM organization_member"),
    ).toBe(1);
  }, 10_000);

  it("checks expiry after waiting for a row lock", async () => {
    await seedInvitation(
      "invite-expiring",
      "(now() AT TIME ZONE 'UTC') + interval '120 milliseconds'",
    );

    const locker = await pool!.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM invitation WHERE id = $1 FOR UPDATE", [
        "invite-expiring",
      ]);

      const accepting = acceptInvitationForUser("invite-expiring", user);
      await sleep(250);
      await locker.query("COMMIT");

      await expect(accepting).resolves.toEqual({ outcome: "expired" });
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      locker.release();
    }

    expect(await scalar("SELECT count(*)::int AS value FROM workspace")).toBe(
      0,
    );
    const status = await pool!.query<{ status: string }>(
      "SELECT status FROM invitation WHERE id = $1",
      ["invite-expiring"],
    );
    expect(status.rows[0]?.status).toBe("expired");
  }, 10_000);
});
