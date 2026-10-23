import { Hono } from "hono";
import { validate } from "../validate.ts";
import { db } from "../index.ts";
import { agent as agentTable } from "../db/schema.ts";
import { agentUpdateSchema } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import { orgScopeOf, requireOrgAccess } from "../middleware/authorization.ts";
import {
  updateAgent as updateAgentRow,
  deleteAgent as deleteAgentRow,
} from "../services/agent.ts";
import {
  listOrgScoped,
  orgScopedWhere,
  requireOrgScoped,
} from "../services/scoped-resource.ts";
import { storeAvatar, deleteAvatar } from "../services/avatar.ts";
import { agentWithAvatarUrl } from "../utils/avatar-url.ts";
import { getOrigin } from "../utils/get-origin.ts";
import type { Variables } from "../server.ts";
import { NotFoundError } from "../errors.ts";

// Org-scoped Agents are Shared resources (ADR-0007): a single source of truth
// defined once at Organization scope (via Promote) and referenced by Workspaces
// through an Attachment. They are managed only by Org Admins on the Organization
// surface, so all mutations are org-admin-only; any member may read them.
const orgAgent = new Hono<{ Variables: Variables }>();

/** List org-scoped Agents */
orgAgent.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const baseUrl = getOrigin(c);
  const results = await listOrgScoped(db, "agent", orgId);
  return c.json({
    results: results.map((r) => agentWithAvatarUrl(r, baseUrl)),
  });
});

/** Get an org-scoped Agent by ID */
orgAgent.get("/:agentId", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const agentId = c.req.param("agentId");
  const baseUrl = getOrigin(c);
  const record = await requireOrgScoped(db, "agent", agentId, orgId);
  return c.json(agentWithAvatarUrl(record, baseUrl));
});

/** Update an org-scoped Agent by ID (admin only) */
orgAgent.put(
  "/:agentId",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", agentUpdateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const agentId = c.req.param("agentId");
    const data = c.req.valid("json");
    const baseUrl = getOrigin(c);

    // `updateAgentRow` throws NotFound (→404) when the Agent is not visible
    // here; a duplicate name surfaces as a Postgres unique violation, mapped
    // to 409 by the central onError (ADR-0010).
    const result = await updateAgentRow(
      { kind: "organization", orgId },
      agentId,
      data,
    );
    if ("error" in result) {
      // A reference that isn't Shared reads as not found here; the message
      // names each one so nothing is lost by dropping the list.
      if (result.blockers) {
        throw new NotFoundError(
          `${result.error}: ${result.blockers
            .map((b) => `${b.name} (${b.type})`)
            .join(", ")}`,
        );
      }
      return c.json({ error: result.error }, 400);
    }
    return c.json(agentWithAvatarUrl(result.row, baseUrl), 200);
  },
);

/** Upload avatar for an org-scoped Agent (admin only) */
orgAgent.post(
  "/:agentId/avatar",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const agentId = c.req.param("agentId");
    const baseUrl = getOrigin(c);

    const existing = await requireOrgScoped(db, "agent", agentId, orgId);

    const body = await c.req.parseBody();
    const result = await storeAvatar(body["file"], agentId, existing.avatarKey);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    const record = await db
      .update(agentTable)
      .set({ avatarKey: result.key, updatedAt: new Date() })
      .where(orgScopedWhere("agent", agentId, orgId))
      .returning();
    return c.json(agentWithAvatarUrl(record[0], baseUrl));
  },
);

/** Delete avatar for an org-scoped Agent (admin only) */
orgAgent.delete(
  "/:agentId/avatar",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const agentId = c.req.param("agentId");
    const baseUrl = getOrigin(c);

    const existing = await requireOrgScoped(db, "agent", agentId, orgId);

    await deleteAvatar(existing.avatarKey);

    const record = await db
      .update(agentTable)
      .set({ avatarKey: null, updatedAt: new Date() })
      .where(orgScopedWhere("agent", agentId, orgId))
      .returning();
    return c.json(agentWithAvatarUrl(record[0], baseUrl));
  },
);

/** Delete an org-scoped Agent by ID (admin only) */
orgAgent.delete(
  "/:agentId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const agentId = c.req.param("agentId");

    // `deleteAgentRow` throws ConflictError (→409, ADR-0007/0008) while an
    // Attachment or Blueprint still references the Agent, and NotFound (→404)
    // when it is not visible here.
    await deleteAgentRow({ kind: "organization", orgId }, agentId);

    return c.json({ message: "Agent deleted" });
  },
);

export { orgAgent };
