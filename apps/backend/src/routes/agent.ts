import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { agent as agentTable } from "../db/schema.ts";
import { agentCreateSchema, agentUpdateSchema } from "@platypus/schemas";
import { eq } from "drizzle-orm";
import { dedupeArray } from "../utils.ts";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";

const agent = new Hono<{ Variables: Variables }>();

/** Create a new agent (admin or editor) */
agent.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess(["admin", "editor"]),
  sValidator("json", agentCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    if (data.toolSetIds) {
      data.toolSetIds = dedupeArray(data.toolSetIds);
    }
    if (data.skillIds) {
      data.skillIds = dedupeArray(data.skillIds);
    }
    const record = await db
      .insert(agentTable)
      .values({
        id: nanoid(),
        ...data,
      })
      .returning();
    return c.json(record[0], 201);
  },
);

/** List all agents */
agent.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess(),
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const results = await db
      .select()
      .from(agentTable)
      .where(eq(agentTable.workspaceId, workspaceId));
    return c.json({ results });
  },
);

/** Get an agent by ID */
agent.get(
  "/:agentId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess(),
  async (c) => {
    const agentId = c.req.param("agentId");
    const record = await db
      .select()
      .from(agentTable)
      .where(eq(agentTable.id, agentId))
      .limit(1);
    if (record.length === 0) {
      return c.json({ message: "Agent not found" }, 404);
    }
    return c.json(record[0]);
  },
);

/** Update an agent by ID (admin or editor) */
agent.put(
  "/:agentId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess(["admin", "editor"]),
  sValidator("json", agentUpdateSchema),
  async (c) => {
    const agentId = c.req.param("agentId");
    const data = c.req.valid("json");
    if (data.toolSetIds) {
      data.toolSetIds = dedupeArray(data.toolSetIds);
    }
    if (data.skillIds) {
      data.skillIds = dedupeArray(data.skillIds);
    }
    const record = await db
      .update(agentTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(agentTable.id, agentId))
      .returning();
    return c.json(record, 200);
  },
);

/** Delete an agent by ID (admin only) */
agent.delete(
  "/:agentId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess(["admin"]),
  async (c) => {
    const agentId = c.req.param("agentId");
    await db.delete(agentTable).where(eq(agentTable.id, agentId));
    return c.json({ message: "Agent deleted" });
  },
);

export { agent };
