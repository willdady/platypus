import { serve } from "@hono/node-server";
import app from "./src/server.ts";
import { db } from "./src/index.ts";
import { sql } from "drizzle-orm";
import { auth } from "./src/auth.ts";
import { logger } from "./src/logger.ts";
import {
  NonRetryableSeedError,
  seedFirstBoot,
  type AdminSignUp,
} from "./src/db/seed.ts";
import { startMemoryScheduler } from "./src/jobs/memory-scheduler.ts";
import { startTriggerScheduler } from "./src/jobs/trigger-scheduler.ts";
import { loadPlugins } from "./src/plugins/loader.ts";
import { setLoadedPlugins } from "./src/plugins/registry.ts";
import { installProviderWarningLogger } from "./src/provider-warnings.ts";

const PORT = process.env.PORT || "4001";

/** The production admin-User creator handed to the seed: better-auth sign-up. */
const signUpAdmin: AdminSignUp = async (input) => {
  const result = await auth.api.signUpEmail({ body: input });
  if (!result.user) {
    throw new Error("Sign up returned no user");
  }
  return { id: result.user.id };
};

const main = async () => {
  logger.info(`Serving on port: ${PORT}`);

  // Before anything can generate: the AI SDK's warning hook is a process
  // global, so this one call is what puts "the Provider ignored a setting you
  // gave it" in the log for every generation path there is (#411).
  installProviderWarningLogger();

  // A seed that cannot complete must not reach `serve()`: an HTTP server nobody
  // can authenticate against reports healthy while being unusable (#369). Retry
  // the transient failures, then exit non-zero so the orchestrator says so.
  try {
    await exponentialBackoff(async () => {
      // Enable pgvector extension for embedding storage (needed before drizzle-kit push in dev)
      await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);

      await seedFirstBoot(db, { signUpAdmin });
    });
  } catch (error) {
    // The message goes in the log line, not just the serialised error: it is
    // the one thing the Operator has to work from (#369).
    logger.fatal(
      { err: error },
      `Startup failed, not starting the HTTP server: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }

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
        webBackends: p.webBackendIds,
      },
      `Loaded plugin ${p.name}@${p.version} (${p.origin}): ${p.toolSetIds.length} tool set(s), ${p.sandboxBackendIds.length} sandbox backend(s), ${p.webBackendIds.length} web backend(s)`,
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
    // A missing environment variable or input better-auth rejected fails the
    // same way every time — retrying only delays the message the Operator needs.
    if (retries > 0 && !(error instanceof NonRetryableSeedError)) {
      logger.warn(
        { err: error },
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
