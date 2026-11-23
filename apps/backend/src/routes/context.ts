import { Hono } from "hono";
import { validate } from "../validate.ts";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  context as contextTable,
  workspace as workspaceTable,
  organization as organizationTable,
} from "../db/schema.ts";
import { contextCreateSchema, contextUpdateSchema } from "@platypus/schemas";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import { userMayUseWorkspace, userOf } from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { ConflictError, isUniqueViolation } from "../errors.ts";

const context = new Hono<{ Variables: Variables }>();

context.get("/", requireAuth, async (c) => {
  const user = userOf(c);

  const results = await db
    .select({
      id: contextTable.id,
      userId: contextTable.userId,
      workspaceId: contextTable.workspaceId,
      content: contextTable.content,
      createdAt: contextTable.createdAt,
      updatedAt: contextTable.updatedAt,
      workspaceName: workspaceTable.name,
      organizationName: organizationTable.name,
    })
    .from(contextTable)
    .leftJoin(workspaceTable, eq(contextTable.workspaceId, workspaceTable.id))
    .leftJoin(
      organizationTable,
      eq(workspaceTable.organizationId, organizationTable.id),
    )
    .where(eq(contextTable.userId, user.id))
    .orderBy(sql`${contextTable.workspaceId} NULLS FIRST`);

  return c.json({ results });
});

context.get("/:contextId", requireAuth, async (c) => {
  const user = userOf(c);
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
      organizationName: organizationTable.name,
    })
    .from(contextTable)
    .leftJoin(workspaceTable, eq(contextTable.workspaceId, workspaceTable.id))
    .leftJoin(
      organizationTable,
      eq(workspaceTable.organizationId, organizationTable.id),
    )
    .where(
      and(eq(contextTable.id, contextId), eq(contextTable.userId, user.id)),
    )
    .limit(1);

  if (result.length === 0) {
    return c.json({ error: "Context not found" }, 404);
  }

  return c.json(result[0]);
});

context.post(
  "/",
  requireAuth,
  validate("json", contextCreateSchema),
  async (c) => {
    const user = userOf(c);
    const data = c.req.valid("json");

    if (
      data.workspaceId !== null &&
      !(await userMayUseWorkspace(db, user, data.workspaceId))
    ) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    try {
      const record = await db
        .insert(contextTable)
        .values({
          id: nanoid(),
          userId: user.id,
          workspaceId: data.workspaceId,
          content: data.content,
        })
        .returning();

      return c.json(record[0], 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError("You already have a context for this scope");
      }
      throw error;
    }
  },
);

context.put(
  "/:contextId",
  requireAuth,
  validate("json", contextUpdateSchema),
  async (c) => {
    const user = userOf(c);
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
      return c.json({ error: "Context not found" }, 404);
    }

    return c.json(record[0]);
  },
);

context.delete("/:contextId", requireAuth, async (c) => {
  const user = userOf(c);
  const contextId = c.req.param("contextId");

  const result = await db
    .delete(contextTable)
    .where(
      and(eq(contextTable.id, contextId), eq(contextTable.userId, user.id)),
    )
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Context not found" }, 404);
  }

  return c.json({ message: "Context deleted" });
});

export { context };
