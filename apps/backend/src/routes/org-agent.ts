import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { db } from "../index.ts";
import {
  agent as agentTable,
  attachment as attachmentTable,
} from "../db/schema.ts";
import { agentUpdateSchema } from "@platypus/schemas";
import { eq, and } from "drizzle-orm";
import { dedupeArray } from "../utils.ts";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess } from "../middleware/authorization.ts";
import { findNonSharedReferences } from "../services/agent-scope-validation.ts";
import { scrubDeletedAgentReference } from "../services/agent-references.ts";
import { isResourceListedInBlueprint } from "../services/blueprint-guard.ts";
import { storeAvatar, deleteAvatar } from "../services/avatar.ts";
import { avatarKeyToUrl } from "../utils/avatar-url.ts";
import { getOrigin } from "../utils/get-origin.ts";
import { NotFoundError } from "../errors.ts";
import type { Variables } from "../server.ts";

// Org-scoped Agents are Shared resources (ADR-0007): a single source of truth
// defined once at Organization scope (via Promote) and referenced by Workspaces
// through an Attachment. They are managed only by Org Admins on the Organization
// surface, so all mutations are org-admin-only; any member may read them.
const orgAgent = new Hono<{ Variables: Variables }>();

function agentWithAvatarUrl(
  agent: Record<string, unknown>,
  baseUrl: string,
): Record<string, unknown> {
  const key = agent.avatarKey as string | null | undefined;
  const { avatarKey: _avatarKey, ...rest } = agent;
  return { ...rest, avatarUrl: avatarKeyToUrl(key, baseUrl) ?? undefined };
}

/** List org-scoped Agents */
orgAgent.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const orgId = c.req.param("orgId")!;
  const baseUrl = getOrigin(c);
  const results = await db
    .select()
    .from(agentTable)
    .where(eq(agentTable.organizationId, orgId));
  return c.json({
    results: results.map((r) => agentWithAvatarUrl(r, baseUrl)),
  });
});

/** Get an org-scoped Agent by ID */
orgAgent.get("/:agentId", requireAuth, requireOrgAccess(), async (c) => {
  const orgId = c.req.param("orgId")!;
  const agentId = c.req.param("agentId");
  const baseUrl = getOrigin(c);
  const record = await db
    .select()
    .from(agentTable)
    .where(
      and(eq(agentTable.id, agentId), eq(agentTable.organizationId, orgId)),
    )
    .limit(1);
  if (record.length === 0) {
    throw new NotFoundError("Agent not found");
  }
  return c.json(agentWithAvatarUrl(record[0], baseUrl));
});

/** Update an org-scoped Agent by ID (admin only) */
orgAgent.put(
  "/:agentId",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", agentUpdateSchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const agentId = c.req.param("agentId");
    const data = c.req.valid("json");
    const baseUrl = getOrigin(c);

    if (data.toolSetIds) data.toolSetIds = dedupeArray(data.toolSetIds);
    if (data.skillIds) data.skillIds = dedupeArray(data.skillIds);
    if (data.subAgentIds) data.subAgentIds = dedupeArray(data.subAgentIds);

    if (data.subAgentIds?.includes(agentId)) {
      return c.json(
        { error: "An agent cannot assign itself as a sub-agent" },
        400,
      );
    }

    // A Shared Agent may reference only other Shared resources (ADR-0007).
    const blockers = await findNonSharedReferences(orgId, {
      providerId: data.providerId,
      skillIds: data.skillIds,
      subAgentIds: data.subAgentIds,
      toolSetIds: data.toolSetIds,
    });
    if (blockers.length > 0) {
      return c.json(
        {
          error:
            "A shared agent may only reference other shared (organization-scoped) resources",
          blockers,
        },
        422,
      );
    }

    // A duplicate name surfaces as a Postgres unique violation, mapped to 409
    // by the central onError (ADR-0009).
    const record = await db
      .update(agentTable)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(eq(agentTable.id, agentId), eq(agentTable.organizationId, orgId)),
      )
      .returning();
    if (record.length === 0) {
      throw new NotFoundError("Agent not found");
    }
    return c.json(agentWithAvatarUrl(record[0], baseUrl), 200);
  },
);

/** Upload avatar for an org-scoped Agent (admin only) */
orgAgent.post(
  "/:agentId/avatar",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const agentId = c.req.param("agentId");
    const baseUrl = getOrigin(c);

    const [existing] = await db
      .select({ avatarKey: agentTable.avatarKey })
      .from(agentTable)
      .where(
        and(eq(agentTable.id, agentId), eq(agentTable.organizationId, orgId)),
      )
      .limit(1);
    if (!existing) {
      throw new NotFoundError("Agent not found");
    }

    const body = await c.req.parseBody();
    const result = await storeAvatar(body["file"], agentId, existing.avatarKey);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    const record = await db
      .update(agentTable)
      .set({ avatarKey: result.key, updatedAt: new Date() })
      .where(
        and(eq(agentTable.id, agentId), eq(agentTable.organizationId, orgId)),
      )
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
    const orgId = c.req.param("orgId")!;
    const agentId = c.req.param("agentId");
    const baseUrl = getOrigin(c);

    const [existing] = await db
      .select({ avatarKey: agentTable.avatarKey })
      .from(agentTable)
      .where(
        and(eq(agentTable.id, agentId), eq(agentTable.organizationId, orgId)),
      )
      .limit(1);
    if (!existing) {
      throw new NotFoundError("Agent not found");
    }

    await deleteAvatar(existing.avatarKey);

    const record = await db
      .update(agentTable)
      .set({ avatarKey: null, updatedAt: new Date() })
      .where(
        and(eq(agentTable.id, agentId), eq(agentTable.organizationId, orgId)),
      )
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
    const orgId = c.req.param("orgId")!;
    const agentId = c.req.param("agentId");

    // A Shared resource cannot be deleted while any Attachment references it
    // (ADR-0007) — detach it from every Workspace first.
    const [attached] = await db
      .select()
      .from(attachmentTable)
      .where(
        and(
          eq(attachmentTable.resourceType, "agent"),
          eq(attachmentTable.resourceId, agentId),
        ),
      )
      .limit(1);
    if (attached) {
      return c.json(
        {
          error:
            "Cannot delete: this agent is attached to one or more workspaces. Detach it first.",
        },
        409,
      );
    }

    // Nor while it is listed in a Blueprint (ADR-0008) — remove it from every
    // Blueprint first, so nothing still points at it.
    if (await isResourceListedInBlueprint("agent", agentId)) {
      return c.json(
        {
          error:
            "Cannot delete: this agent is listed in one or more blueprints. Remove it from them first.",
        },
        409,
      );
    }

    // Delete the Agent and scrub its (now-dead) id from any Agent's subAgentIds
    // in the same transaction, so deletion never leaves dangling references.
    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .delete(agentTable)
        .where(
          and(eq(agentTable.id, agentId), eq(agentTable.organizationId, orgId)),
        )
        .returning();
      if (rows.length > 0) {
        await scrubDeletedAgentReference(tx, "subAgentIds", agentId);
      }
      return rows;
    });
    if (result.length === 0) {
      throw new NotFoundError("Agent not found");
    }

    // Clean up the (now-orphaned) avatar, matching the Workspace surface — the
    // avatar is keyed by the Agent id alone, so nothing else can reference it
    // once the row is gone. Best-effort: a storage miss must not fail the
    // delete that already committed.
    await deleteAvatar(result[0].avatarKey);

    return c.json({ message: "Agent deleted" });
  },
);

export { orgAgent };
