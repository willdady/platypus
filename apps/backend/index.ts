// why: first import: it parses the environment before any later module reads it
import { failStartup } from "./src/boot-env.ts";
import { serve } from "@hono/node-server";
import app from "./src/server.ts";
import { db, pool } from "./src/index.ts";
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
// why: side-effect imports register the channels the notification listener LISTENs on
import "./src/runs/run-cancel.ts";
import "./src/services/a2a-events.ts";
import {
  installShutdownHandlers,
  installCrashHandlers,
} from "./src/runs/shutdown.ts";
import { watchForCanceledA2aRuns } from "./src/services/a2a-cancel.ts";
import { loadPlugins, type LoadPluginsResult } from "./src/plugins/loader.ts";
import { setLoadedPlugins } from "./src/plugins/registry.ts";
import { installProviderWarningLogger } from "./src/provider-warnings.ts";
import { validateTriggerBreakerConfig } from "./src/services/trigger-breaker.ts";
import { validateInboundTriggerSettings } from "./src/services/inbound-trigger.ts";
import { validateA2aSettings } from "./src/services/a2a-call.ts";
import { env } from "./src/env.ts";
import { getStorage } from "./src/storage/index.ts";

const { PORT } = env();

const createAdminUser: AdminCreateUser = async (input) => {
  const { user } = await auth.api.createUser({ body: input });
  return { id: user.id };
};

const main = async () => {
  logger.info(`Serving on port: ${PORT}`);

  installProviderWarningLogger();

  let loadedPlugins: LoadPluginsResult;
  try {
    validateTriggerBreakerConfig();
    validateInboundTriggerSettings();
    validateA2aSettings();
    // why: builds the storage backend now, so a bad one stops boot rather than the first upload
    getStorage();

    await exponentialBackoff(async () => {
      await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);

      await seedFirstBootExclusively(db, db.$client, {
        createUser: createAdminUser,
      });
    });

    loadedPlugins = await loadPlugins();
  } catch (error) {
    failStartup(error);
  }

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
    port: PORT,
  });
  const httpServer = server as import("node:http").Server;

  installShutdownHandlers({
    stopBackground: () => {
      stopMemoryScheduler();
      stopScheduler();
      stopNotificationListener();
      stopA2aWatcher();
    },
    stopAccepting: () => httpServer.close(),
    closeIdleConnections: () => httpServer.closeIdleConnections(),
    close: () =>
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
    endPool: () => pool.end(),
  });
  installCrashHandlers();

  const stopMemoryScheduler = startMemoryScheduler();
  const stopScheduler = startScheduler();
  const stopNotificationListener = startNotificationListener();
  const stopA2aWatcher = watchForCanceledA2aRuns();
};

const exponentialBackoff = async <T>(
  fn: () => Promise<T>,
  retries: number = 5,
  delay: number = 1000,
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
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

export {};
