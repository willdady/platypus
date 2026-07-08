import { serve } from "@hono/node-server";
import app from "./src/server.ts";
import { db } from "./src/index.ts";
import {
  organization,
  workspace,
  organizationMember,
  user,
} from "./src/db/schema.ts";
import { nanoid } from "nanoid";
import { count, eq, sql } from "drizzle-orm";
import { auth } from "./src/auth.ts";
import { logger } from "./src/logger.ts";
import { startMemoryScheduler } from "./src/jobs/memory-scheduler.ts";
import { startTriggerScheduler } from "./src/jobs/trigger-scheduler.ts";
import { loadPlugins } from "./src/plugins/loader.ts";
import { setLoadedPlugins } from "./src/plugins/registry.ts";

const PORT = process.env.PORT || "4001";

const main = async () => {
  logger.info(`Serving on port: ${PORT}`);

  await exponentialBackoff(async () => {
    // Enable pgvector extension for embedding storage (needed before drizzle-kit push in dev)
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);

    const [orgCount] = await db.select({ value: count() }).from(organization);

    if (orgCount.value === 0) {
      logger.info("No organizations found. Creating initial organization...");
      const orgId = nanoid();
      await db.insert(organization).values({
        id: orgId,
        name: "Default Organization",
      });
      logger.info(`- Organization created: ${orgId}`);

      logger.info("Creating default user...");
      const defaultEmail = process.env.ADMIN_EMAIL;
      const defaultPassword = process.env.ADMIN_PASSWORD;

      if (!defaultEmail || !defaultPassword) {
        throw new Error(
          "ADMIN_EMAIL and ADMIN_PASSWORD environment variables are required for initial setup",
        );
      }

      try {
        const result = await auth.api.signUpEmail({
          body: {
            email: defaultEmail,
            password: defaultPassword,
            name: "Admin User",
          },
        });

        if (!result.user) {
          throw new Error("Failed to get user from sign up response");
        }

        logger.info(`- User created: ${defaultEmail}`);

        // Update role to admin and verify email after creation
        await db
          .update(user)
          .set({ role: "admin", emailVerified: true })
          .where(eq(user.id, result.user.id));

        logger.info(`- User upgraded to admin role`);

        // Create organization membership with admin role
        logger.info("Creating organization membership...");
        await db.insert(organizationMember).values({
          id: nanoid(),
          organizationId: orgId,
          userId: result.user.id,
          role: "admin",
        });
        logger.info(`- Organization membership created for ${defaultEmail}`);

        // Create default workspace owned by the admin user
        logger.info("Creating initial workspace...");
        const workspaceId = nanoid();
        await db.insert(workspace).values({
          id: workspaceId,
          organizationId: orgId,
          ownerId: result.user.id,
          name: "Default Workspace",
        });
        logger.info(`- Workspace created: ${workspaceId}`);

        logger.info(
          `- Default credentials: ${defaultEmail} / ${defaultPassword}`,
        );
        logger.info(
          "⚠️  Please change the default password after first login!",
        );
      } catch (error) {
        logger.error({ error }, "Failed to create default user");
        throw error;
      }
    }
  });

  // Load plugins before the HTTP server accepts traffic so their Tool set
  // contributions are registered by the time Chat turns resolve tools. Fail-loud
  // and all-or-nothing: a bad plugin aborts startup (ADR-0013).
  const loadedPlugins = await loadPlugins();

  // Enumerate each loaded plugin — version, origin, and the contributions it
  // fills — so the boot log is a complete, auditable statement of what runs
  // (ADR-0013 observability). Then hand the result to the registry, the single
  // read-only source behind `GET /plugins` and the catalog annotations.
  for (const p of loadedPlugins) {
    logger.info(
      {
        plugin: p.name,
        version: p.version,
        origin: p.origin,
        toolSets: p.toolSetIds,
        sandboxBackends: p.sandboxBackendIds,
      },
      `Loaded plugin ${p.name}@${p.version} (${p.origin}): ${p.toolSetIds.length} tool set(s), ${p.sandboxBackendIds.length} sandbox backend(s)`,
    );
  }
  setLoadedPlugins(loadedPlugins);
  logger.info(`Loaded ${loadedPlugins.length} plugin(s)`);

  serve({
    fetch: app.fetch,
    port: parseInt(PORT),
  });

  // Start background jobs (safe for horizontal scaling)
  startMemoryScheduler();
  startTriggerScheduler();
};

const exponentialBackoff = async <T>(
  fn: () => Promise<T>,
  retries: number = 5,
  delay: number = 1000,
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0) {
      logger.warn(
        { error },
        `Operation failed, retrying in ${delay / 1000} seconds...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      return exponentialBackoff(fn, retries - 1, delay * 2);
    }
    throw error;
  }
};

await main();

// Needed for top-level await to work
export {};
