import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import sharp from "sharp";
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
import { getStorage } from "../storage/index.ts";
import { avatarKeyToUrl } from "../utils/avatar-url.ts";
import { getOrigin } from "../utils/get-origin.ts";
import type { Variables } from "../server.ts";

const ALLOWED_AVATAR_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];
const MAX_AVATAR_SIZE = 5 * 1024 * 1024;
const MIN_AVATAR_DIMENSION = 64;
const AVATAR_SIZE = 512;

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

/** Detects a Postgres unique-constraint violation across driver shapes. */
const isUniqueViolation = (error: any): boolean =>
  error.code === "23505" ||
  error.cause?.code === "23505" ||
  error.message?.includes("unique constraint") ||
  error.cause?.message?.includes("unique constraint");

const NAME_CONFLICT = {
  error: "An agent with this name already exists in this organization",
} as const;

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
    return c.json({ error: "Agent not found" }, 404);
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

    try {
      const record = await db
        .update(agentTable)
        .set({ ...data, updatedAt: new Date() })
        .where(
          and(eq(agentTable.id, agentId), eq(agentTable.organizationId, orgId)),
        )
        .returning();
      if (record.length === 0) {
        return c.json({ error: "Agent not found" }, 404);
      }
      return c.json(agentWithAvatarUrl(record[0], baseUrl), 200);
    } catch (error: any) {
      if (isUniqueViolation(error)) {
        return c.json(NAME_CONFLICT, 409);
      }
      throw error;
    }
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
      return c.json({ error: "Agent not found" }, 404);
    }

    const body = await c.req.parseBody();
    const file = body["file"];
    if (!file || !(file instanceof File)) {
      return c.json({ error: "No file provided" }, 400);
    }
    if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
      return c.json({ error: "Invalid file type" }, 400);
    }
    if (file.size > MAX_AVATAR_SIZE) {
      return c.json({ error: "File too large (max 5MB)" }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(buffer).metadata();
    } catch {
      return c.json({ error: "Invalid image" }, 400);
    }
    if (
      metadata.width &&
      metadata.height &&
      (metadata.width < MIN_AVATAR_DIMENSION ||
        metadata.height < MIN_AVATAR_DIMENSION)
    ) {
      return c.json(
        {
          error: `Image must be at least ${MIN_AVATAR_DIMENSION}x${MIN_AVATAR_DIMENSION} pixels`,
        },
        400,
      );
    }

    const processedBuffer = await sharp(buffer)
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover" })
      .webp()
      .toBuffer();

    // Avatars are keyed by the Agent's globally-unique id, independent of scope.
    const key = `agents/${agentId}/avatar-${nanoid()}.webp`;

    if (existing.avatarKey) {
      try {
        await getStorage().delete(existing.avatarKey);
      } catch {
        // Ignore deletion errors
      }
    }

    await getStorage().put(key, processedBuffer, "image/webp");

    const record = await db
      .update(agentTable)
      .set({ avatarKey: key, updatedAt: new Date() })
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
      return c.json({ error: "Agent not found" }, 404);
    }

    if (existing.avatarKey) {
      try {
        await getStorage().delete(existing.avatarKey);
      } catch {
        // Ignore deletion errors
      }
    }

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
      return c.json({ error: "Agent not found" }, 404);
    }
    return c.json({ message: "Agent deleted" });
  },
);

export { orgAgent };
