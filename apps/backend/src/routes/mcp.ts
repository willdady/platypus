import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { db } from "../index.ts";
import { mcp as mcpTable } from "../db/schema.ts";
import { mcpCreateSchema, mcpUpdateSchema, mcpTestSchema } from "@agent-kit/schemas";
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
  const workspaceId = c.req.query("workspaceId");
  const results = await db
    .select()
    .from(mcpTable)
    .where(workspaceId ? eq(mcpTable.workspaceId, workspaceId) : undefined);
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

/** Test MCP connection */
mcp.post("/test", sValidator("json", mcpTestSchema), async (c) => {
  const data = c.req.valid("json");

  let mcpClient;
  try {
    mcpClient = await createMCPClient({
      transport: {
        type: "http",
        url: data.url,
        headers:
          data.authType === "Bearer"
            ? { Authorization: `Bearer ${data.bearerToken}` }
            : undefined,
      },
    });

    // Fetch available tools
    const mcpTools = await mcpClient.tools();

    // Extract tool names from the tools object
    const toolNames = Object.keys(mcpTools);

    // Close connection
    await mcpClient.close();

    // Return success with tool names
    return c.json({
      success: true,
      toolNames
    }, 200);

  } catch (error) {
    // Close client if it was created
    if (mcpClient) {
      try {
        await mcpClient.close();
      } catch (closeError) {
        console.error("Error closing MCP client:", closeError);
      }
    }

    // Log the full error for debugging
    console.error("MCP test connection error:", error);

    // Return error details
    let errorMessage = "Unknown error connecting to MCP server";

    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'string') {
      errorMessage = error;
    }

    return c.json({
      success: false,
      error: errorMessage
    }, 400);
  }
});

export { mcp };
