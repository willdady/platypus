import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  agent as agentTable,
  attachment as attachmentTable,
} from "../db/schema.ts";
import { agentCreateSchema, agentUpdateSchema } from "@platypus/schemas";
import { eq, and } from "drizzle-orm";
import { dedupeArray } from "../utils.ts";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { validateSubAgentAssignment } from "../services/sub-agent-validation.ts";
import { findNonSharedReferences } from "../services/agent-scope-validation.ts";
import {
  listScoped,
  requireScoped,
  requireWorkspaceMutable,
} from "../services/scoped-resource.ts";
import { NotFoundError } from "../errors.ts";
import { storeAvatar, deleteAvatar } from "../services/avatar.ts";
import { avatarKeyToUrl } from "../utils/avatar-url.ts";
import { getOrigin } from "../utils/get-origin.ts";

function agentWithAvatarUrl(
  agent: Record<string, unknown>,
  baseUrl: string,
): Record<string, unknown> {
  const key = agent.avatarKey as string | null | undefined;
  const { avatarKey: _avatarKey, ...rest } = agent;
  return { ...rest, avatarUrl: avatarKeyToUrl(key, baseUrl) ?? undefined };
}

const agent = new Hono<{ Variables: Variables }>();

/** Create a new agent (admin or editor) — always Workspace-scoped */
agent.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", agentCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const workspaceId = c.req.param("workspaceId")!;

    // Deduplicate arrays
    if (data.toolSetIds) {
      data.toolSetIds = dedupeArray(data.toolSetIds);
    }
    if (data.skillIds) {
      data.skillIds = dedupeArray(data.skillIds);
    }
    if (data.subAgentIds) {
      data.subAgentIds = dedupeArray(data.subAgentIds);
    }

    // Validate sub-agent assignments
    if (data.subAgentIds && data.subAgentIds.length > 0) {
      const validation = await validateSubAgentAssignment(
        workspaceId,
        "", // No ID yet for new agent
        data.subAgentIds,
      );
      if (!validation.valid) {
        return c.json({ error: validation.error }, 400);
      }
    }

    const baseUrl = getOrigin(c);
    // The workspace route only ever creates Workspace-scoped Agents; the scope
    // comes from the route, never the body (org-scoped Agents arrive via
    // Promote).
    const record = await db
      .insert(agentTable)
      .values({
        id: nanoid(),
        ...data,
        workspaceId,
        organizationId: null,
      })
      .returning();
    return c.json(agentWithAvatarUrl(record[0], baseUrl), 201);
  },
);

/** List agents visible in this workspace (workspace-scoped + attached org-scoped) */
agent.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;
    const baseUrl = getOrigin(c);

    const scoped = await listScoped(db, "agent", { orgId, wsId: workspaceId });
    const results = scoped.map(({ row, scope }) => ({
      ...agentWithAvatarUrl(row, baseUrl),
      scope,
    }));
    return c.json({ results });
  },
);

/** Get an agent by ID (workspace-scoped, or attached org-scoped) */
agent.get(
  "/:agentId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const agentId = c.req.param("agentId");
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;
    const baseUrl = getOrigin(c);

    const found = await requireScoped(db, "agent", agentId, {
      orgId,
      wsId: workspaceId,
    });
    return c.json({
      ...agentWithAvatarUrl(found.row, baseUrl),
      scope: found.scope,
    });
  },
);

/** Update an agent by ID (workspace-scoped only; Shared agents edit on org surface) */
agent.put(
  "/:agentId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", agentUpdateSchema),
  async (c) => {
    const agentId = c.req.param("agentId");
    const data = c.req.valid("json");
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;

    // Deduplicate arrays
    if (data.toolSetIds) {
      data.toolSetIds = dedupeArray(data.toolSetIds);
    }
    if (data.skillIds) {
      data.skillIds = dedupeArray(data.skillIds);
    }
    if (data.subAgentIds) {
      data.subAgentIds = dedupeArray(data.subAgentIds);
    }

    // A Shared Agent is a single source of truth edited only on the Organization
    // surface (ADR-0007); requireWorkspaceMutable throws NotFound (→404) when the
    // Agent is not visible here, then Locked (→403) when it is org-scoped.
    await requireWorkspaceMutable(db, "agent", agentId, {
      orgId,
      wsId: workspaceId,
    });

    const baseUrl = getOrigin(c);

    // Workspace-scoped update.
    if (data.subAgentIds) {
      const validation = await validateSubAgentAssignment(
        workspaceId,
        agentId,
        data.subAgentIds,
      );
      if (!validation.valid) {
        return c.json({ error: validation.error }, 400);
      }
    }

    const record = await db
      .update(agentTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentTable.id, agentId),
          eq(agentTable.workspaceId, workspaceId),
        ),
      )
      .returning();
    return c.json(agentWithAvatarUrl(record[0], baseUrl), 200);
  },
);

/** Upload avatar for an agent */
agent.post(
  "/:agentId/avatar",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const agentId = c.req.param("agentId");
    const workspaceId = c.req.param("workspaceId")!;
    const orgId = c.req.param("orgId")!;
    const baseUrl = getOrigin(c);

    // Shared agents are managed only on the Organization surface (ADR-0007).
    const found = await requireWorkspaceMutable(db, "agent", agentId, {
      orgId,
      wsId: workspaceId,
    });

    const body = await c.req.parseBody();
    const result = await storeAvatar(
      body["file"],
      agentId,
      found.row.avatarKey,
    );
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    const record = await db
      .update(agentTable)
      .set({ avatarKey: result.key, updatedAt: new Date() })
      .where(
        and(
          eq(agentTable.id, agentId),
          eq(agentTable.workspaceId, workspaceId),
        ),
      )
      .returning();

    return c.json(agentWithAvatarUrl(record[0], baseUrl));
  },
);

/** Delete avatar for an agent */
agent.delete(
  "/:agentId/avatar",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const agentId = c.req.param("agentId");
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;
    const baseUrl = getOrigin(c);

    // Shared agents are managed only on the Organization surface (ADR-0007).
    const found = await requireWorkspaceMutable(db, "agent", agentId, {
      orgId,
      wsId: workspaceId,
    });

    await deleteAvatar(found.row.avatarKey);

    const record = await db
      .update(agentTable)
      .set({ avatarKey: null, updatedAt: new Date() })
      .where(
        and(
          eq(agentTable.id, agentId),
          eq(agentTable.workspaceId, workspaceId),
        ),
      )
      .returning();

    return c.json(agentWithAvatarUrl(record[0], baseUrl));
  },
);

/** Delete an agent by ID — Workspace-scoped only (Shared agents via org surface) */
agent.delete(
  "/:agentId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const agentId = c.req.param("agentId");
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;

    // A Shared Agent is deleted only from the Organization surface (ADR-0007):
    // requireWorkspaceMutable throws NotFound (→404) when the Agent is not
    // visible here, then Locked (→403) when it is org-scoped.
    const found = await requireWorkspaceMutable(db, "agent", agentId, {
      orgId,
      wsId: workspaceId,
    });

    await deleteAvatar(found.row.avatarKey);

    await db
      .delete(agentTable)
      .where(
        and(
          eq(agentTable.id, agentId),
          eq(agentTable.workspaceId, workspaceId),
        ),
      );
    return c.json({ message: "Agent deleted" });
  },
);

/**
 * Promote a workspace-scoped Agent to Organization scope (admin only — ADR-0007).
 *
 * Enforces the no-cascade rule: a Shared Agent may reference only other Shared
 * resources, so Promotion is blocked unless the Agent's Provider, every Skill,
 * every sub-Agent, and every MCP-backed tool set is already Organization-scoped.
 * When blocked, the offending references are returned as `blockers` so the UI
 * can present a fix-this checklist. On success the Agent re-scopes to the
 * Organization and its origin Workspace is auto-attached so it stays visible
 * and usable there; editing thereafter happens on the Organization surface.
 */
agent.post(
  "/:agentId/promote",
  requireAuth,
  requireOrgAccess(["admin"]),
  requireWorkspaceAccess,
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;
    const agentId = c.req.param("agentId");
    const baseUrl = getOrigin(c);

    // Only a workspace-scoped Agent in this workspace can be promoted.
    const [existing] = await db
      .select()
      .from(agentTable)
      .where(
        and(
          eq(agentTable.id, agentId),
          eq(agentTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new NotFoundError("Agent not found");
    }

    // No-cascade guard (ADR-0007): every travels-with reference must already be
    // Organization-scoped, or Promotion is blocked with a fix-this checklist.
    const blockers = await findNonSharedReferences(orgId, {
      providerId: existing.providerId,
      skillIds: existing.skillIds,
      subAgentIds: existing.subAgentIds,
      toolSetIds: existing.toolSetIds,
    });
    if (blockers.length > 0) {
      return c.json(
        {
          error:
            "Promote blocked: this agent references workspace-private resources. Promote them first.",
          blockers,
        },
        422,
      );
    }

    // Sentinel for a lost TOCTOU race: the Agent was re-scoped or deleted between
    // the lookup above and the in-transaction update. Throwing rolls back the
    // auto-attach so we never leave a dangling Attachment.
    const PROMOTE_RACE = "agent_no_longer_workspace_scoped";

    try {
      const promoted = await db.transaction(async (tx) => {
        const [record] = await tx
          .update(agentTable)
          .set({
            organizationId: orgId,
            workspaceId: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(agentTable.id, agentId),
              eq(agentTable.workspaceId, workspaceId),
            ),
          )
          .returning();

        if (!record) {
          throw new Error(PROMOTE_RACE);
        }

        // Auto-attach the origin Workspace so it keeps seeing the Agent.
        await tx
          .insert(attachmentTable)
          .values({
            id: nanoid(),
            workspaceId,
            resourceType: "agent",
            resourceId: agentId,
          })
          .onConflictDoNothing();

        return record;
      });

      return c.json(
        { ...agentWithAvatarUrl(promoted, baseUrl), scope: "organization" },
        200,
      );
    } catch (error: any) {
      if (error?.message === PROMOTE_RACE) {
        throw new NotFoundError("Agent not found");
      }
      // A duplicate Shared-Agent name surfaces as a Postgres unique violation,
      // mapped to 409 by the central onError (ADR-0009).
      throw error;
    }
  },
);

export { agent };
