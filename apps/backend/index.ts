import { serve } from "@hono/node-server";
import app from "./src/server.ts";
import { db } from "./src/index.ts";
import { sql } from "drizzle-orm";
import { auth } from "./src/auth.ts";
import { logger } from "./src/logger.ts";
import {
  NonRetryableSeedError,
  seedFirstBootExclusively,
  type AdminCreateUser,
} from "./src/db/seed.ts";
import { startMemoryScheduler } from "./src/jobs/memory-scheduler.ts";
import { startScheduler } from "./src/jobs/scheduler.ts";
import { startNotificationListener } from "./src/runs/notify-listener.ts";
// Register the channels the listener LISTENs on.
import "./src/runs/run-cancel.ts";
import "./src/services/a2a-events.ts";
import { installShutdownHandlers } from "./src/runs/shutdown.ts";
import { watchForCanceledA2aRuns } from "./src/services/a2a-cancel.ts";
import { loadPlugins, type LoadPluginsResult } from "./src/plugins/loader.ts";
import { setLoadedPlugins } from "./src/plugins/registry.ts";
import { installProviderWarningLogger } from "./src/provider-warnings.ts";
import { validateTriggerBreakerConfig } from "./src/services/trigger-breaker.ts";
import { validateInboundTriggerSettings } from "./src/services/inbound-trigger.ts";
import { validateA2aSettings } from "./src/services/a2a-call.ts";

const PORT = process.env.PORT || "4001";

/**
 * The production admin-User creator handed to the seed: the better-auth admin
 * plugin's create-user API, called in-process with no headers, which the
 * plugin treats as a trusted internal call needing no session. It hashes the
 * password and links a credential account exactly as public sign-up would,
 * without going through the public sign-up endpoint — so seeding works whether
 * or not `REQUIRE_INVITATION_TO_SIGN_UP` has closed it (#550, ADR-0019).
 */
const createAdminUser: AdminCreateUser = async (input) => {
  const { user } = await auth.api.createUser({ body: input });
  return { id: user.id };
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
  let loadedPlugins: LoadPluginsResult;
  try {
    // Fail loud before the database is touched: the run-rate breaker is the only
    // ceiling on an Event Trigger's run rate against one entity, and a
    // malformed setting must not silently become a default nobody chose.
    validateTriggerBreakerConfig();
    // Same rule for the Inbound Trigger caps (ADR-0030): the concurrency and
    // body caps are what bound what an outside caller can make this server do.
    validateInboundTriggerSettings();
    // And for the A2A load cap (ADR-0032).
    validateA2aSettings();

    await exponentialBackoff(async () => {
      // Enable pgvector extension for embedding storage (needed before drizzle-kit push in dev)
      await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);

      // Under an advisory lock: replicas booting together would otherwise
      // race to seed, and the loser fail on the admin User the winner created.
      await seedFirstBootExclusively(db, db.$client, {
        createUser: createAdminUser,
      });
    });

    // Load plugins before the HTTP server accepts traffic so their Tool set
    // contributions are registered by the time Chat turns resolve tools. Fail-loud
    // and all-or-nothing: a bad plugin aborts startup (ADR-0013). Outside the
    // retry, since a bad plugin fails the same way every time, but inside this
    // try so the fatal line names the plugin and the reason.
    loadedPlugins = await loadPlugins();
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

  // Enumerate each loaded plugin — version, origin, and the contributions it
  // fills — so the boot log is a complete, auditable statement of what runs
  // (ADR-0013 observability). Then hand the result to the registry, the single
  // read-only source behind `GET /plugins` and the catalog annotations.
  for (const p of loadedPlugins.plugins) {
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
  logger.info(`Loaded ${loadedPlugins.plugins.length} plugin(s)`);

  const server = serve({
    fetch: app.fetch,
    port: parseInt(PORT),
  });
  // A deploy or `docker stop` ends this process's runs as cancelled before it
  // exits, so their Chats are free at once rather than once their heartbeat
  // goes stale (#1297).
  installShutdownHandlers({ stopAccepting: () => server.close() });

  // Start background jobs (safe for horizontal scaling)
  startMemoryScheduler();
  startScheduler();
  // A cancel received by another instance reaches the runs held here, and an
  // A2A Task's events reach the streams following it here.
  startNotificationListener();
  // An A2A cancel that missed the run held here, as while listening resumed.
  watchForCanceledA2aRuns();
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
