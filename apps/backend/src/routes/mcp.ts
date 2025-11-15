import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { mcp as mcpTable } from "../db/schema.ts";
import { mcpCreateSchema, mcpUpdateSchema } from "@agent-kit/schemas";
import { eq } from "drizzle-orm";

const mcp = new Hono();

/** Create a new MCP */
mcp.post("/", sValidator("json", mcpCreateSchema), async (c) => {
  const data = c.req.valid("json");
  const record = await db
    .insert(mcpTable)
    .values({
      id: nanoid(),
      ...data,
    })
    .returning();
  return c.json(record[0], 201);
});

/** List all MCPs */
mcp.get("/", async (c) => {
  const results = await db.select().from(mcpTable);
  return c.json({ results });
});

/** Get a MCP by ID */
mcp.get("/:id", async (c) => {
  const id = c.req.param("id");
  const record = await db
    .select()
    .from(mcpTable)
    .where(eq(mcpTable.id, id))
    .limit(1);
  if (record.length === 0) {
    return c.json({ message: "MCP not found" }, 404);
  }
  return c.json(record[0]);
});

/** Update a MCP by ID */
mcp.put("/:id", sValidator("json", mcpUpdateSchema), async (c) => {
  const id = c.req.param("id");
  const data = c.req.valid("json");
  const record = await db
    .update(mcpTable)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(eq(mcpTable.id, id))
    .returning();
  return c.json(record, 200);
});

/** Delete a MCP by ID */
mcp.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await db.delete(mcpTable).where(eq(mcpTable.id, id));
  return c.json({ message: "MCP deleted" });
});

export { mcp };
