import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { agent as agentTable } from "../db/schema.ts";
import { agentCreateSchema, agentUpdateSchema } from "@agent-kit/schemas";
import { eq } from "drizzle-orm";
import { dedupeArray } from "../utils.ts";

const agent = new Hono();

/** Create a new agent */
agent.post("/", sValidator("json", agentCreateSchema), async (c) => {
  const data = c.req.valid("json");
  if (data.tools) {
    data.tools = dedupeArray(data.tools);
  }
  const record = await db
    .insert(agentTable)
    .values({
      id: nanoid(),
      ...data,
    })
    .returning();
  return c.json(record[0], 201);
});

/** List all agents */
agent.get(
  "/",
  sValidator(
    "query",
    z.object({
      workspaceId: z.string(),
    }),
  ),
  async (c) => {
    const { workspaceId } = c.req.valid("query");
    const results = await db
      .select()
      .from(agentTable)
      .where(eq(agentTable.workspaceId, workspaceId));
    return c.json({ results });
  },
);

/** Get an agent by ID */
agent.get("/:id", async (c) => {
  const id = c.req.param("id");
  const record = await db
    .select()
    .from(agentTable)
    .where(eq(agentTable.id, id))
    .limit(1);
  if (record.length === 0) {
    return c.json({ message: "Agent not found" }, 404);
  }
  return c.json(record[0]);
});

/** Update an agent by ID */
agent.put("/:id", sValidator("json", agentUpdateSchema), async (c) => {
  const id = c.req.param("id");
  const data = c.req.valid("json");
  if (data.tools) {
    data.tools = dedupeArray(data.tools);
  }
  const record = await db
    .update(agentTable)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(eq(agentTable.id, id))
    .returning();
  return c.json(record, 200);
});

/** Delete an agent by ID */
agent.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await db.delete(agentTable).where(eq(agentTable.id, id));
  return c.json({ message: "Agent deleted" });
});

export { agent };
