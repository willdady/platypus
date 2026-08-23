import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { db } from "../index.ts";
import { agent as agentTable } from "../db/schema.ts";
import { agentCreateSchema, agentUpdateSchema } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import {
  createAgent as createAgentRow,
  updateAgent as updateAgentRow,
  deleteAgent as deleteAgentRow,
} from "../services/agent.ts";
import { findNonSharedReferences } from "../services/agent-scope-validation.ts";
import { promoteScoped } from "../services/promote.ts";
import {
  listScoped,
  requireScoped,
  requireWorkspaceMutable,
  workspaceScopedWhere,
} from "../services/scoped-resource.ts";
import { storeAvatar, deleteAvatar } from "../services/avatar.ts";
import { agentWithAvatarUrl } from "../utils/avatar-url.ts";
import { getOrigin } from "../utils/get-origin.ts";

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
    const scope = workspaceScopeOf(c);
    const baseUrl = getOrigin(c);

    const result = await createAgentRow(scope, data);
    if ("error" in result) {
      return c.json({ error: result.error }, 400);
    }
    return c.json(agentWithAvatarUrl(result.row, baseUrl), 201);
  },
);

/** List agents visible in this workspace (workspace-scoped + attached org-scoped) */
agent.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const baseUrl = getOrigin(c);

    const scoped = await listScoped(db, "agent", workspaceScopeOf(c));
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
    const baseUrl = getOrigin(c);

    const found = await requireScoped(
      db,
      "agent",
      agentId,
      workspaceScopeOf(c),
    );
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
    const scope = workspaceScopeOf(c);
    const baseUrl = getOrigin(c);

    // A Shared Agent is a single source of truth edited only on the Organization
    // surface (ADR-0007); `updateAgentRow` throws NotFound (→404) when the
    // Agent is not visible here, then Locked (→403) when it is org-scoped.
    const result = await updateAgentRow(
      { kind: "workspace", ctx: scope },
      agentId,
      data,
    );
    if ("error" in result) {
      return c.json({ error: result.error }, 400);
    }
    return c.json(agentWithAvatarUrl(result.row, baseUrl), 200);
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
    const scope = workspaceScopeOf(c);
    const baseUrl = getOrigin(c);

    // Shared agents are managed only on the Organization surface (ADR-0007).
    const found = await requireWorkspaceMutable(db, "agent", agentId, scope);

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
      .where(workspaceScopedWhere("agent", agentId, scope.workspaceId))
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
    const scope = workspaceScopeOf(c);
    const baseUrl = getOrigin(c);

    // Shared agents are managed only on the Organization surface (ADR-0007).
    const found = await requireWorkspaceMutable(db, "agent", agentId, scope);

    await deleteAvatar(found.row.avatarKey);

    const record = await db
      .update(agentTable)
      .set({ avatarKey: null, updatedAt: new Date() })
      .where(workspaceScopedWhere("agent", agentId, scope.workspaceId))
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
    const scope = workspaceScopeOf(c);

    // A Shared Agent is deleted only from the Organization surface (ADR-0007):
    // `deleteAgentRow` throws NotFound (→404) when the Agent is not visible
    // here, then Locked (→403) when it is org-scoped.
    await deleteAgentRow({ kind: "workspace", ctx: scope }, agentId);

    return c.json({ message: "Agent deleted" });
  },
);

/**
 * Promote a workspace-scoped Agent to Organization scope (admin only — ADR-0007).
 *
 * Runs the no-cascade rule (`findNonSharedReferences`) as the module's guard: a
 * shared Agent may reference only other Shared resources, so Promotion is
 * blocked unless the Agent's Provider, every Skill, every sub-agent, and every
 * MCP-backed tool set is already Organization-scoped. When blocked, the
 * offending references are returned as `blockers`. On success the Agent
 * re-scopes to the Organization and its origin Workspace is auto-attached.
 */
agent.post(
  "/:agentId/promote",
  requireAuth,
  requireOrgAccess(["admin"]),
  requireWorkspaceAccess,
  async (c) => {
    const { orgId, workspaceId } = workspaceScopeOf(c);
    const agentId = c.req.param("agentId");
    const baseUrl = getOrigin(c);

    const outcome = await promoteScoped(db, {
      type: "agent",
      id: agentId,
      orgId,
      workspaceId,
      guard: (existing) =>
        findNonSharedReferences(orgId, {
          providerId: existing.providerId,
          skillIds: existing.skillIds,
          subAgentIds: existing.subAgentIds,
          toolSetIds: existing.toolSetIds,
        }),
    });

    if (!outcome.ok) {
      return c.json({ error: outcome.message, blockers: outcome.blockers }, 422);
    }
    return c.json(
      { ...agentWithAvatarUrl(outcome.row, baseUrl), scope: "organization" },
      200,
    );
  },
);

export { agent };
