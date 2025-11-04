import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { organisation, workspace } from "./db/schema.ts";

export const organisationMiddleware = createMiddleware(async (c, next) => {
  try {
    const body = await c.req.json();

    if (!body.organisationId) {
      return c.json(
        { error: "organisationId is required in request body" },
        400,
      );
    }

    const db = c.get("db");
    const organisationRecord = await db
      .select()
      .from(organisation)
      .where(eq(organisation.id, body.organisationId))
      .limit(1);

    if (organisationRecord.length === 0) {
      return c.json({ error: "Organisation not found" }, 404);
    }

    c.set("organisation", organisationRecord[0]);
    await next();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }
    throw error;
  }
});

export const workspaceMiddleware = createMiddleware(async (c, next) => {
  try {
    const body = await c.req.json();

    if (!body.workspaceId) {
      return c.json({ error: "workspaceId is required in request body" }, 400);
    }

    const db = c.get("db");
    const workspaceRecord = await db
      .select()
      .from(workspace)
      .where(eq(workspace.id, body.workspaceId))
      .limit(1);

    if (workspaceRecord.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    c.set("workspace", workspaceRecord[0]);
    await next();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }
    throw error;
  }
});
