import { serve } from "@hono/node-server";
import app from "./src/server.ts";
import { db } from "./src/index.ts";
import { organisation, workspace } from "./src/db/schema.ts";

const PORT = process.env.PORT || "3000";

const main = async () => {
  console.clear();
  console.log(`Serving on port: ${PORT}`);

  await exponentialBackoff(async () => {
    console.log("Upserting default organisation...");
    await db
      .insert(organisation)
      .values({ id: "default", name: "Default" })
      .onConflictDoUpdate({ target: organisation.id, set: { name: "Default" } });
    console.log("- Default organisation upserted.");

    console.log("Upserting default workspace...");
    await db
      .insert(workspace)
      .values({ id: "default", organisationId: "default", name: "Default" })
      .onConflictDoUpdate({ target: workspace.id, set: { name: "Default" } });
    console.log("- Default workspace upserted.");
  });

  serve({
    fetch: app.fetch,
    port: parseInt(PORT),
  });
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
      console.warn(
        `Operation failed, retrying in ${delay / 1000} seconds...`,
        error,
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
