import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { db } from "../index.ts";
import { mcp as mcpTable } from "../db/schema.ts";
import {
  mcpCreateSchema,
  mcpUpdateSchema,
  mcpTestSchema,
} from "@platypus/schemas";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { logger } from "../logger.ts";

const mcp = new Hono<{ Variables: Variables }>();

/** Create a new MCP (admin only) */
mcp.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", mcpCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const record = await db
      .insert(mcpTable)
      .values({
        id: nanoid(),
        ...data,
      })
      .returning();
    return c.json(record[0], 201);
  },
);

/** List all MCPs */
mcp.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const results = await db
      .select()
      .from(mcpTable)
      .where(eq(mcpTable.workspaceId, workspaceId));
    return c.json({ results });
  },
);

/** Get a MCP by ID */
mcp.get(
  "/:mcpId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const mcpId = c.req.param("mcpId");
    const record = await db
      .select()
      .from(mcpTable)
      .where(eq(mcpTable.id, mcpId))
      .limit(1);
    if (record.length === 0) {
      return c.json({ message: "MCP not found" }, 404);
    }
    return c.json(record[0]);
  },
);

/** Update a MCP by ID (admin only) */
mcp.put(
  "/:mcpId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", mcpUpdateSchema),
  async (c) => {
    const mcpId = c.req.param("mcpId");
    const data = c.req.valid("json");
    const record = await db
      .update(mcpTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(mcpTable.id, mcpId))
      .returning();
    return c.json(record, 200);
  },
);

/** Delete a MCP by ID (admin only) */
mcp.delete(
  "/:mcpId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const mcpId = c.req.param("mcpId");
    await db.delete(mcpTable).where(eq(mcpTable.id, mcpId));
    return c.json({ message: "MCP deleted" });
  },
);

/** Test MCP connection (admin only) */
mcp.post(
  "/test",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", mcpTestSchema),
  async (c) => {
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
      return c.json(
        {
          success: true,
          toolNames,
        },
        200,
      );
    } catch (error) {
      // Close client if it was created
      if (mcpClient) {
        try {
          await mcpClient.close();
        } catch (closeError) {
          logger.error({ error: closeError }, "Error closing MCP client");
        }
      }

      // Log the full error for debugging
      logger.error({ error }, "MCP test connection error");

      // Return error details
      let errorMessage = "Unknown error connecting to MCP server";

      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === "string") {
        errorMessage = error;
      }

      return c.json(
        {
          success: false,
          error: errorMessage,
        },
        400,
      );
    }
  },
);

export { mcp };
