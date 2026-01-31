import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  context as contextTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { contextCreateSchema, contextUpdateSchema } from "@platypus/schemas";
import { eq, and, isNull, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import type { Variables } from "../server.ts";
import { logger } from "../logger.ts";

const context = new Hono<{ Variables: Variables }>();

/** List all contexts for the current user */
context.get("/", requireAuth, async (c) => {
  const user = c.get("user")!;

  const results = await db
    .select({
      id: contextTable.id,
      userId: contextTable.userId,
      workspaceId: contextTable.workspaceId,
      content: contextTable.content,
      createdAt: contextTable.createdAt,
      updatedAt: contextTable.updatedAt,
      workspaceName: workspaceTable.name,
    })
    .from(contextTable)
    .leftJoin(workspaceTable, eq(contextTable.workspaceId, workspaceTable.id))
    .where(eq(contextTable.userId, user.id))
    .orderBy(sql`${contextTable.workspaceId} NULLS FIRST`);

  return c.json({ results });
});

/** Get a specific context by ID */
context.get("/:contextId", requireAuth, async (c) => {
  const user = c.get("user")!;
  const contextId = c.req.param("contextId");

  const result = await db
    .select({
      id: contextTable.id,
      userId: contextTable.userId,
      workspaceId: contextTable.workspaceId,
      content: contextTable.content,
      createdAt: contextTable.createdAt,
      updatedAt: contextTable.updatedAt,
      workspaceName: workspaceTable.name,
    })
    .from(contextTable)
    .leftJoin(workspaceTable, eq(contextTable.workspaceId, workspaceTable.id))
    .where(
      and(eq(contextTable.id, contextId), eq(contextTable.userId, user.id)),
    )
    .limit(1);

  if (result.length === 0) {
    return c.json({ message: "Context not found" }, 404);
  }

  return c.json(result[0]);
});

/** Create a new context */
context.post(
  "/",
  requireAuth,
  sValidator("json", contextCreateSchema),
  async (c) => {
    const user = c.get("user")!;
    const data = c.req.valid("json");

    try {
      const record = await db
        .insert(contextTable)
        .values({
          id: nanoid(),
          userId: user.id,
          workspaceId: data.workspaceId || null,
          content: data.content,
        })
        .returning();

      return c.json(record[0], 201);
    } catch (error: any) {
      // Handle unique constraint violation
      if (error.code === "23505") {
        return c.json(
          { message: "You already have a context for this scope" },
          409,
        );
      }
      logger.error({ error }, "Error creating context");
      throw error;
    }
  },
);

/** Update a context */
context.put(
  "/:contextId",
  requireAuth,
  sValidator("json", contextUpdateSchema),
  async (c) => {
    const user = c.get("user")!;
    const contextId = c.req.param("contextId");
    const data = c.req.valid("json");

    const record = await db
      .update(contextTable)
      .set({
        content: data.content,
        updatedAt: new Date(),
      })
      .where(
        and(eq(contextTable.id, contextId), eq(contextTable.userId, user.id)),
      )
      .returning();

    if (record.length === 0) {
      return c.json({ message: "Context not found" }, 404);
    }

    return c.json(record[0]);
  },
);

/** Delete a context */
context.delete("/:contextId", requireAuth, async (c) => {
  const user = c.get("user")!;
  const contextId = c.req.param("contextId");

  const result = await db
    .delete(contextTable)
    .where(
      and(eq(contextTable.id, contextId), eq(contextTable.userId, user.id)),
    )
    .returning();

  if (result.length === 0) {
    return c.json({ message: "Context not found" }, 404);
  }

  return c.json({ message: "Context deleted successfully" });
});

export { context };
