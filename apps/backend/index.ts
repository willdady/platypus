import { serve } from "@hono/node-server";
import app from "./src/server.ts";
import { db } from "./src/index.ts";
import { organisation, workspace } from "./src/db/schema.ts";
import { nanoid } from "nanoid";
import { count } from "drizzle-orm";

const PORT = process.env.PORT || "3000";

const main = async () => {
  console.clear();
  console.log(`Serving on port: ${PORT}`);

  await exponentialBackoff(async () => {
    const [orgCount] = await db.select({ value: count() }).from(organisation);

    if (orgCount.value === 0) {
      console.log("No organisations found. Creating initial organisation...");
      const orgId = nanoid();
      await db.insert(organisation).values({
        id: orgId,
        name: "Default Organisation",
      });
      console.log(`- Organisation created: ${orgId}`);

      console.log("Creating initial workspace...");
      const workspaceId = nanoid();
      await db.insert(workspace).values({
        id: workspaceId,
        organisationId: orgId,
        name: "Default Workspace",
      });
      console.log(`- Workspace created: ${workspaceId}`);
    }
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
