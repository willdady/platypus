import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import {
  experimental_createMCPClient as createMCPClient,
  auth as mcpAuth,
} from "@ai-sdk/mcp";
import { db } from "../index.ts";
import {
  mcp as mcpTable,
  attachment as attachmentTable,
} from "../db/schema.ts";
import {
  mcpCreateSchema,
  mcpUpdateSchema,
  mcpTestSchema,
} from "@platypus/schemas";
import { eq, and, or } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { logger } from "../logger.ts";

// MCP mutations introduce credentials and external reach, so they are
// org-admin by default and delegatable to the workspace owner via the
// `mcpSelfManagement` flag (ADR-0006). Reused across every mutating route.
const requireMcpConfigAccess =
  requireWorkspaceConfigAccess("mcpSelfManagement");
import {
  DatabaseOAuthClientProvider,
  oauthFetchFn,
  buildOAuthCallbackUrl,
  buildMcpTransportConfig,
  type McpRecord,
} from "../services/mcp-oauth-provider.ts";

/** Fields to null-out when clearing OAuth tokens. */
export const OAUTH_TOKEN_CLEAR_FIELDS = {
  oauthAccessToken: null,
  oauthRefreshToken: null,
  oauthTokenExpiresAt: null,
  oauthScope: null,
} as const;

const mcp = new Hono<{ Variables: Variables }>();

/** Strips sensitive OAuth fields and adds computed oauthAuthorized flag */
export const sanitizeMcpResponse = (record: McpRecord) => {
  const {
    oauthAccessToken,
    oauthRefreshToken,
    oauthClientSecret,
    oauthTokenExpiresAt,
    oauthScope,
    ...rest
  } = record;
  return {
    ...rest,
    oauthAuthorized:
      record.authType === "OAuth" ? !!oauthAccessToken : undefined,
  };
};

/** Create a new MCP (org-admin, or owner when delegated — ADR-0006) */
mcp.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireMcpConfigAccess,
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
    return c.json(sanitizeMcpResponse(record[0]), 201);
  },
);

/** List MCPs visible in this workspace (workspace-scoped + org-scoped) */
mcp.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;

    // Workspace-scoped MCPs
    const workspaceMcps = await db
      .select()
      .from(mcpTable)
      .where(eq(mcpTable.workspaceId, workspaceId));

    // Org-scoped (Shared) MCPs appear in a Workspace only where attached
    // (ADR-0007 / #154) — gate by an inner join on the Attachment table.
    const attachedOrgRows = await db
      .select()
      .from(mcpTable)
      .innerJoin(
        attachmentTable,
        and(
          eq(attachmentTable.resourceId, mcpTable.id),
          eq(attachmentTable.resourceType, "mcp"),
          eq(attachmentTable.workspaceId, workspaceId),
        ),
      )
      .where(eq(mcpTable.organizationId, orgId));
    const orgMcps = attachedOrgRows.map((r) => r.mcp);

    // Tag each MCP with its scope for the frontend
    const results = [
      ...orgMcps.map((m) => ({
        ...sanitizeMcpResponse(m),
        scope: "organization" as const,
      })),
      ...workspaceMcps.map((m) => ({
        ...sanitizeMcpResponse(m),
        scope: "workspace" as const,
      })),
    ];

    return c.json({ results });
  },
);

/** Get a MCP by ID (workspace-scoped or org-scoped) */
mcp.get(
  "/:mcpId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const mcpId = c.req.param("mcpId");
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;
    const record = await db
      .select()
      .from(mcpTable)
      .where(
        and(
          eq(mcpTable.id, mcpId),
          or(
            eq(mcpTable.workspaceId, workspaceId),
            eq(mcpTable.organizationId, orgId),
          ),
        ),
      )
      .limit(1);
    if (record.length === 0) {
      return c.json({ error: "MCP not found" }, 404);
    }
    const scope = record[0].organizationId ? "organization" : "workspace";
    return c.json({ ...sanitizeMcpResponse(record[0]), scope });
  },
);

/** Update a MCP by ID (org-admin, or owner when delegated — ADR-0006) */
mcp.put(
  "/:mcpId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireMcpConfigAccess,
  sValidator("json", mcpUpdateSchema),
  async (c) => {
    const mcpId = c.req.param("mcpId");
    const workspaceId = c.req.param("workspaceId")!;
    const data = c.req.valid("json");

    // If URL is changing, clear stored OAuth tokens (they're server-specific)
    const existing = await db
      .select()
      .from(mcpTable)
      .where(and(eq(mcpTable.id, mcpId), eq(mcpTable.workspaceId, workspaceId)))
      .limit(1);

    const urlChanged = existing.length > 0 && existing[0].url !== data.url;

    const record = await db
      .update(mcpTable)
      .set({
        ...data,
        ...(urlChanged && {
          ...OAUTH_TOKEN_CLEAR_FIELDS,
          oauthClientId: null,
          oauthClientSecret: null,
        }),
        updatedAt: new Date(),
      })
      .where(and(eq(mcpTable.id, mcpId), eq(mcpTable.workspaceId, workspaceId)))
      .returning();
    if (record.length === 0) {
      return c.json({ error: "MCP not found" }, 404);
    }
    return c.json(sanitizeMcpResponse(record[0]), 200);
  },
);

/** Delete a MCP by ID (org-admin, or owner when delegated — ADR-0006) */
mcp.delete(
  "/:mcpId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireMcpConfigAccess,
  async (c) => {
    const mcpId = c.req.param("mcpId");
    const workspaceId = c.req.param("workspaceId")!;
    const result = await db
      .delete(mcpTable)
      .where(and(eq(mcpTable.id, mcpId), eq(mcpTable.workspaceId, workspaceId)))
      .returning();
    if (result.length === 0) {
      return c.json({ error: "MCP not found" }, 404);
    }
    return c.json({ message: "MCP deleted" });
  },
);

/** Test MCP connection (org-admin, or owner when delegated — ADR-0006) */
mcp.post(
  "/test",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireMcpConfigAccess,
  sValidator("json", mcpTestSchema),
  async (c) => {
    const data = c.req.valid("json");

    let mcpClient;
    try {
      // For OAuth, use authProvider with stored tokens
      if (data.authType === "OAuth" && data.mcpId) {
        const workspaceId = c.req.param("workspaceId")!;
        const mcpRecord = await db
          .select()
          .from(mcpTable)
          .where(
            and(
              eq(mcpTable.id, data.mcpId),
              eq(mcpTable.workspaceId, workspaceId),
            ),
          )
          .limit(1);

        if (mcpRecord.length === 0) {
          return c.json({ success: false, error: "MCP not found" }, 404);
        }

        if (!mcpRecord[0].oauthAccessToken) {
          return c.json(
            {
              success: false,
              error: "MCP not yet authorized. Click Authorize first.",
            },
            400,
          );
        }

        mcpClient = await createMCPClient({
          transport: buildMcpTransportConfig(mcpRecord[0]),
        });
      } else {
        mcpClient = await createMCPClient({
          transport: {
            type: "http",
            url: data.url,
            headers: {
              ...data.headers,
              ...(data.authType === "Bearer"
                ? { Authorization: `Bearer ${data.bearerToken}` }
                : {}),
            },
          },
        });
      }

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

/** Initiate OAuth authorization for an MCP (org-admin, or delegated owner) */
mcp.post(
  "/:mcpId/oauth/authorize",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireMcpConfigAccess,
  async (c) => {
    const mcpId = c.req.param("mcpId");
    const workspaceId = c.req.param("workspaceId")!;

    const mcpRecord = await db
      .select()
      .from(mcpTable)
      .where(and(eq(mcpTable.id, mcpId), eq(mcpTable.workspaceId, workspaceId)))
      .limit(1);

    if (mcpRecord.length === 0) {
      return c.json({ error: "MCP not found" }, 404);
    }

    if (mcpRecord[0].authType !== "OAuth") {
      return c.json({ error: "MCP auth type is not OAuth" }, 400);
    }

    if (!mcpRecord[0].url) {
      return c.json({ error: "MCP URL is not configured" }, 400);
    }

    // `force=true` clears stored tokens before running the OAuth flow so
    // mcpAuth always returns REDIRECT. Lets the UI offer a single-click
    // "Reauthorize" even when Platypus still holds a valid refresh token (the
    // SDK would otherwise silently refresh and report AUTHORIZED, which the
    // frontend currently shows as a failure because no authorizationUrl is
    // returned). The DCR/static `oauthClientId`/`oauthClientSecret` are
    // preserved so the same OAuth client is reused.
    const force = c.req.query("force") === "true";
    if (force) {
      await db
        .update(mcpTable)
        .set({
          oauthAccessToken: null,
          oauthRefreshToken: null,
          oauthTokenExpiresAt: null,
          oauthScope: null,
          updatedAt: new Date(),
        })
        .where(eq(mcpTable.id, mcpId));
      mcpRecord[0] = {
        ...mcpRecord[0],
        oauthAccessToken: null,
        oauthRefreshToken: null,
        oauthTokenExpiresAt: null,
        oauthScope: null,
      };
    }

    try {
      const callbackUrl = buildOAuthCallbackUrl();
      const provider = new DatabaseOAuthClientProvider(
        mcpRecord[0],
        callbackUrl,
      );

      const result = await mcpAuth(provider, {
        serverUrl: mcpRecord[0].url,
        fetchFn: oauthFetchFn,
      });

      if (result === "REDIRECT") {
        const authUrl = provider.getPendingAuthUrl();
        if (!authUrl) {
          return c.json({ error: "Failed to generate authorization URL" }, 500);
        }
        return c.json({ authorizationUrl: authUrl.toString() });
      }

      // Already authorized — refresh token still valid, SDK rotated silently.
      // Reported as success so the frontend can treat it as a no-op rather
      // than an error.
      return c.json({ alreadyAuthorized: true });
    } catch (error) {
      logger.error({ error }, "OAuth authorize error");
      const errorMessage =
        error instanceof Error ? error.message : "OAuth authorization failed";
      return c.json({ error: errorMessage }, 500);
    }
  },
);

/** Revoke OAuth tokens for an MCP (org-admin, or delegated owner) */
mcp.post(
  "/:mcpId/oauth/revoke",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireMcpConfigAccess,
  async (c) => {
    const mcpId = c.req.param("mcpId");
    const workspaceId = c.req.param("workspaceId")!;

    const record = await db
      .update(mcpTable)
      .set({
        ...OAUTH_TOKEN_CLEAR_FIELDS,
        updatedAt: new Date(),
      })
      .where(and(eq(mcpTable.id, mcpId), eq(mcpTable.workspaceId, workspaceId)))
      .returning();

    if (record.length === 0) {
      return c.json({ error: "MCP not found" }, 404);
    }

    return c.json({ success: true });
  },
);

export { mcp };
