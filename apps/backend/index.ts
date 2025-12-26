import { serve } from "@hono/node-server";
import app from "./src/server.ts";
import { db } from "./src/index.ts";
import {
  organisation,
  workspace,
  organisationMember,
  user,
} from "./src/db/schema.ts";
import { nanoid } from "nanoid";
import { count, eq } from "drizzle-orm";
import { auth } from "./src/auth.ts";

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

      console.log("Creating default user...");
      const defaultEmail = "admin@example.com";
      const defaultPassword = "admin123";

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

        console.log(`- User created: ${defaultEmail}`);

        // Update role to admin after creation
        await db
          .update(user)
          .set({ role: "admin" })
          .where(eq(user.id, result.user.id));

        console.log(`- User upgraded to admin role`);

        // Create organization membership with admin role
        console.log("Creating organization membership...");
        await db.insert(organisationMember).values({
          id: nanoid(),
          organisationId: orgId,
          userId: result.user.id,
          role: "admin",
        });
        console.log(`- Organization membership created for ${defaultEmail}`);

        console.log(
          `- Default credentials: ${defaultEmail} / ${defaultPassword}`,
        );
        console.log(
          "⚠️  Please change the default password after first login!",
        );
      } catch (error) {
        console.error("Failed to create default user:", error);
        throw error;
      }
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
