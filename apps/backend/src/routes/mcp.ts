import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import {
  experimental_createMCPClient as createMCPClient,
  auth as mcpAuth,
} from "@ai-sdk/mcp";
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
  requireWorkspaceConfigAccess,
  workspaceCredentialsVisible,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import {
  mcpReadModel,
  sanitizeMcpResponse,
} from "../services/credential-redaction.ts";
import {
  listScoped,
  requireScoped,
  requireWorkspaceMutable,
  workspaceScopedWhere,
} from "../services/scoped-resource.ts";
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
} from "../services/mcp-oauth-provider.ts";
import {
  assertMcpSlugAvailable,
  deriveMcpSlug,
} from "../services/mcp-namespace.ts";
import { resolveMcpTestToolNames } from "../services/mcp-test-tools.ts";

/** Fields to null-out when clearing OAuth tokens. */
export const OAUTH_TOKEN_CLEAR_FIELDS = {
  oauthAccessToken: null,
  oauthRefreshToken: null,
  oauthTokenExpiresAt: null,
  oauthScope: null,
} as const;

const mcp = new Hono<{ Variables: Variables }>();

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
    const { orgId, workspaceId } = workspaceScopeOf(c);
    const slug = deriveMcpSlug(data.name);
    await assertMcpSlugAvailable(slug, { orgId });
    const record = await db
      .insert(mcpTable)
      .values({
        id: nanoid(),
        ...data,
        slug,
        // The scope comes from the route, never the body — as it does for Agents
        // and Skills. Spreading the body let a caller name another Workspace, or
        // set `organizationId` and mint a Shared MCP from the Workspace surface,
        // which only an Org Admin may do (ADR-0006, ADR-0007).
        workspaceId,
        organizationId: null,
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
    // Workspace-scoped MCPs plus the Shared (org-scoped) MCPs attached here
    // (ADR-0007), each tagged with its scope for the frontend.
    const scoped = await listScoped(db, "mcp", workspaceScopeOf(c));
    // Request credentials are revealed only to a caller who may manage this MCP
    // (ADR-0006) — the same rule the write routes reject on. The rows still list,
    // because granting an MCP to an Agent does not require self-management.
    const reveal = await workspaceCredentialsVisible(c, "mcp");
    const results = scoped.map(({ row, scope }) =>
      mcpReadModel(row, { reveal, scope }),
    );

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
    const found = await requireScoped(db, "mcp", mcpId, workspaceScopeOf(c));
    // See the list route: redacted unless this caller may manage the MCP.
    const reveal = await workspaceCredentialsVisible(c, "mcp");
    return c.json(mcpReadModel(found.row, { reveal, scope: found.scope }));
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
    const scope = workspaceScopeOf(c);
    const data = c.req.valid("json");

    // A Shared MCP is a single source of truth edited only on the Organization
    // surface (ADR-0007); requireWorkspaceMutable throws NotFound (→404) when the
    // MCP is not visible here, then Locked (→403) when it is org-scoped. On
    // success the row is guaranteed Workspace-scoped.
    const { row } = await requireWorkspaceMutable(db, "mcp", mcpId, scope);

    // If the URL is changing, clear stored OAuth tokens (they're server-specific)
    const urlChanged = row.url !== data.url;

    const slug = deriveMcpSlug(data.name);
    await assertMcpSlugAvailable(slug, { orgId: scope.orgId }, mcpId);

    const record = await db
      .update(mcpTable)
      .set({
        ...data,
        slug,
        ...(urlChanged && {
          ...OAUTH_TOKEN_CLEAR_FIELDS,
          oauthClientId: null,
          oauthClientSecret: null,
        }),
        updatedAt: new Date(),
      })
      .where(workspaceScopedWhere("mcp", mcpId, scope.workspaceId))
      .returning();
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
    const scope = workspaceScopeOf(c);

    // A Shared MCP is deleted only from the Organization surface (ADR-0007):
    // requireWorkspaceMutable throws NotFound (→404) when the MCP is not visible
    // here, then Locked (→403) when it is org-scoped.
    await requireWorkspaceMutable(db, "mcp", mcpId, scope);

    await db
      .delete(mcpTable)
      .where(workspaceScopedWhere("mcp", mcpId, scope.workspaceId))
      .returning();
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
    // Read outside the try: the catch below turns anything thrown into a 400
    // "connection failed", which is the wrong answer for a misconfigured route.
    const { workspaceId } = workspaceScopeOf(c);

    try {
      // For OAuth, use authProvider with stored tokens
      if (data.authType === "OAuth" && data.mcpId) {
        const mcpRecord = await db
          .select()
          .from(mcpTable)
          .where(workspaceScopedWhere("mcp", data.mcpId, workspaceId))
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
      const rawToolNames = Object.keys(mcpTools);

      // Close connection
      await mcpClient.close();

      // Namespaced under the MCP's slug (issue #467), so this reports exactly
      // what a Chat turn will see.
      const { toolNames, invalidToolNames } = await resolveMcpTestToolNames(
        rawToolNames,
        data.name,
        data.mcpId,
        async (id) =>
          (
            await db
              .select({ name: mcpTable.name })
              .from(mcpTable)
              .where(workspaceScopedWhere("mcp", id, workspaceId))
              .limit(1)
          )[0]?.name,
      );

      return c.json(
        {
          success: true,
          toolNames,
          invalidToolNames,
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
    const { workspaceId } = workspaceScopeOf(c);

    const mcpRecord = await db
      .select()
      .from(mcpTable)
      .where(workspaceScopedWhere("mcp", mcpId, workspaceId))
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
    // Capture the narrowed URL before the `force` block reassigns
    // `mcpRecord[0]`, which widens the property back to `string | null`.
    const serverUrl = mcpRecord[0].url;

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
        serverUrl,
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
    const { workspaceId } = workspaceScopeOf(c);

    const record = await db
      .update(mcpTable)
      .set({
        ...OAUTH_TOKEN_CLEAR_FIELDS,
        updatedAt: new Date(),
      })
      .where(workspaceScopedWhere("mcp", mcpId, workspaceId))
      .returning();

    if (record.length === 0) {
      return c.json({ error: "MCP not found" }, 404);
    }

    return c.json({ success: true });
  },
);

export { mcp };
