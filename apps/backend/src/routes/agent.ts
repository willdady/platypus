import { Hono } from "hono";
import { validate } from "../validate.ts";
import { db } from "../index.ts";
import { agentCreateSchema, agentUpdateSchema } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import { pinAgent, pinnedAgentIds, unpinAgent } from "../services/agent-pin.ts";
import type { Variables } from "../server.ts";
import {
  createAgent as createAgentRow,
  updateAgent as updateAgentRow,
  deleteAgent as deleteAgentRow,
  setAgentAvatar,
  clearAgentAvatar,
} from "../services/agent.ts";
import { findNonSharedReferences } from "../services/agent-scope-validation.ts";
import { promoteScoped } from "../services/promote.ts";
import { listScoped, requireScoped } from "../services/scoped-resource.ts";
import { agentResponse } from "../services/scoped-response.ts";
import { avatarBodyLimit } from "./avatar-body-limit.ts";
import { backendBaseUrl } from "../base-urls.ts";

const agent = new Hono<{ Variables: Variables }>();

agent.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  validate("json", agentCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const scope = workspaceScopeOf(c);
    const baseUrl = backendBaseUrl();

    const result = await createAgentRow(scope, data);
    if ("error" in result) {
      return c.json({ error: result.error }, 400);
    }
    return c.json(agentResponse(result.row, "workspace", baseUrl), 201);
  },
);

agent.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const baseUrl = backendBaseUrl();

    const ctx = workspaceScopeOf(c);
    const [scoped, pinned] = await Promise.all([
      listScoped(db, "agent", ctx),
      pinnedAgentIds(ctx.workspaceId),
    ]);
    const results = scoped.map(({ row, scope }) => ({
      ...agentResponse(row, scope, baseUrl),
      isPinned: pinned.has(row.id),
    }));
    return c.json({ results });
  },
);

agent.get(
  "/:agentId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const agentId = c.req.param("agentId");
    const baseUrl = backendBaseUrl();

    const found = await requireScoped(
      db,
      "agent",
      agentId,
      workspaceScopeOf(c),
    );
    return c.json(agentResponse(found.row, found.scope, baseUrl));
  },
);

agent.put(
  "/:agentId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  validate("json", agentUpdateSchema),
  async (c) => {
    const agentId = c.req.param("agentId");
    const data = c.req.valid("json");
    const scope = workspaceScopeOf(c);
    const baseUrl = backendBaseUrl();

    const result = await updateAgentRow(
      { kind: "workspace", ctx: scope },
      agentId,
      data,
    );
    if ("error" in result) {
      return c.json({ error: result.error }, 400);
    }
    return c.json(agentResponse(result.row, "workspace", baseUrl), 200);
  },
);

agent.put(
  "/:agentId/pin",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    await pinAgent(workspaceScopeOf(c), c.req.param("agentId"));
    return c.json({ message: "Agent pinned" });
  },
);

agent.delete(
  "/:agentId/pin",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    await unpinAgent(workspaceScopeOf(c), c.req.param("agentId"));
    return c.json({ message: "Agent unpinned" });
  },
);

agent.post(
  "/:agentId/avatar",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  avatarBodyLimit,
  async (c) => {
    const body = await c.req.parseBody();
    const row = await setAgentAvatar(
      { kind: "workspace", ctx: workspaceScopeOf(c) },
      c.req.param("agentId"),
      body["file"],
    );
    return c.json(agentResponse(row, "workspace", backendBaseUrl()));
  },
);

agent.delete(
  "/:agentId/avatar",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const row = await clearAgentAvatar(
      { kind: "workspace", ctx: workspaceScopeOf(c) },
      c.req.param("agentId"),
    );
    return c.json(agentResponse(row, "workspace", backendBaseUrl()));
  },
);

agent.delete(
  "/:agentId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const agentId = c.req.param("agentId");
    const scope = workspaceScopeOf(c);

    await deleteAgentRow({ kind: "workspace", ctx: scope }, agentId);

    return c.json({ message: "Agent deleted" });
  },
);

agent.post(
  "/:agentId/promote",
  requireAuth,
  requireOrgAccess(["admin"]),
  requireWorkspaceAccess,
  async (c) => {
    const { orgId, workspaceId } = workspaceScopeOf(c);
    const agentId = c.req.param("agentId");
    const baseUrl = backendBaseUrl();

    const outcome = await promoteScoped(db, {
      type: "agent",
      id: agentId,
      orgId,
      workspaceId,
      guard: (existing) =>
        findNonSharedReferences(orgId, {
          providerId: existing.providerId,
          fallbackProviderId: existing.fallbackProviderId,
          skillIds: existing.skillIds,
          subAgentIds: existing.subAgentIds,
          toolSetIds: existing.toolSetIds,
        }),
    });

    if (!outcome.ok) {
      return c.json(
        { error: outcome.message, blockers: outcome.blockers },
        422,
      );
    }
    return c.json(agentResponse(outcome.row, "organization", baseUrl), 200);
  },
);

export { agent };
