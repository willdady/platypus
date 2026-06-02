import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  agent as agentTable,
  attachment as attachmentTable,
} from "../db/schema.ts";
import { agentCreateSchema, agentUpdateSchema } from "@platypus/schemas";
import { eq, and, or, inArray } from "drizzle-orm";
import { dedupeArray } from "../utils.ts";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { validateSubAgentAssignment } from "../services/sub-agent-validation.ts";
import { findNonSharedReferences } from "../services/agent-scope-validation.ts";
import { getStorage } from "../storage/index.ts";
import sharp from "sharp";
import { avatarKeyToUrl } from "../utils/avatar-url.ts";
import { getOrigin } from "../utils/get-origin.ts";

const ALLOWED_AVATAR_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];
const MAX_AVATAR_SIZE = 5 * 1024 * 1024;
const MIN_AVATAR_DIMENSION = 64;
const AVATAR_SIZE = 512;

type AgentRow = typeof agentTable.$inferSelect;
type AgentScope = "organization" | "workspace";

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

/**
 * Resolves an Agent visible inside this Workspace: a Workspace-scoped Agent in
 * the Workspace, or an Organization-scoped (Shared) Agent attached to it
 * (ADR-0007). Returns the row plus its scope, or null when not visible here.
 */
const findVisibleAgent = async (
  agentId: string,
  orgId: string,
  workspaceId: string,
): Promise<{ row: AgentRow; scope: AgentScope } | null> => {
  const rows = await db
    .select()
    .from(agentTable)
    .where(
      and(
        eq(agentTable.id, agentId),
        or(
          eq(agentTable.workspaceId, workspaceId),
          eq(agentTable.organizationId, orgId),
        ),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const isOrgScoped = !!row.organizationId && !row.workspaceId;
  if (!isOrgScoped) {
    return { row, scope: "workspace" };
  }

  // An org-scoped (Shared) Agent is only visible here where attached.
  const [attached] = await db
    .select({ id: attachmentTable.id })
    .from(attachmentTable)
    .where(
      and(
        eq(attachmentTable.workspaceId, workspaceId),
        eq(attachmentTable.resourceType, "agent"),
        eq(attachmentTable.resourceId, agentId),
      ),
    )
    .limit(1);
  if (!attached) return null;
  return { row, scope: "organization" };
};

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

    const workspaceAgents = await db
      .select()
      .from(agentTable)
      .where(eq(agentTable.workspaceId, workspaceId));

    // Org-scoped (Shared) Agents appear in a Workspace only where attached
    // (ADR-0007) — gate by an inner join on the Attachment table.
    const attachedOrgRows = await db
      .select()
      .from(agentTable)
      .innerJoin(
        attachmentTable,
        and(
          eq(attachmentTable.resourceId, agentTable.id),
          eq(attachmentTable.resourceType, "agent"),
          eq(attachmentTable.workspaceId, workspaceId),
        ),
      )
      .where(eq(agentTable.organizationId, orgId));
    const orgAgents = attachedOrgRows.map((r) => r.agent);

    const results = [
      ...orgAgents.map((a) => ({
        ...agentWithAvatarUrl(a, baseUrl),
        scope: "organization" as const,
      })),
      ...workspaceAgents.map((a) => ({
        ...agentWithAvatarUrl(a, baseUrl),
        scope: "workspace" as const,
      })),
    ];
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

    const found = await findVisibleAgent(agentId, orgId, workspaceId);
    if (!found) {
      return c.json({ error: "Agent not found" }, 404);
    }
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

    const found = await findVisibleAgent(agentId, orgId, workspaceId);
    if (!found) {
      return c.json({ error: "Agent not found" }, 404);
    }

    const baseUrl = getOrigin(c);

    // A Shared Agent is a single source of truth edited only on the Organization
    // surface (ADR-0007); it is locked in every Workspace, even to Org Admins.
    if (found.scope === "organization") {
      return c.json(
        { error: "This agent is managed at the organization level" },
        403,
      );
    }

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

    const found = await findVisibleAgent(agentId, orgId, workspaceId);
    if (!found) {
      return c.json({ error: "Agent not found" }, 404);
    }
    // Shared agents are managed only on the Organization surface (ADR-0007).
    if (found.scope === "organization") {
      return c.json(
        { error: "This agent is managed at the organization level" },
        403,
      );
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

    if (metadata.width && metadata.height) {
      if (
        metadata.width < MIN_AVATAR_DIMENSION ||
        metadata.height < MIN_AVATAR_DIMENSION
      ) {
        return c.json(
          {
            error: `Image must be at least ${MIN_AVATAR_DIMENSION}x${MIN_AVATAR_DIMENSION} pixels`,
          },
          400,
        );
      }
    }

    const processedBuffer = await sharp(buffer)
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover" })
      .webp()
      .toBuffer();

    // Avatars are keyed by the Agent's (globally unique) id, independent of
    // scope — so the path never goes stale when a workspace Agent is Promoted
    // to the Organization (ADR-0007). The exact key is stored on the row, so
    // deletion never needs to reconstruct it.
    const key = `agents/${agentId}/avatar-${nanoid()}.webp`;

    if (found.row.avatarKey) {
      try {
        const storage = getStorage();
        await storage.delete(found.row.avatarKey);
      } catch {
        // Ignore deletion errors
      }
    }

    const storage = getStorage();
    await storage.put(key, processedBuffer, "image/webp");

    const record = await db
      .update(agentTable)
      .set({ avatarKey: key, updatedAt: new Date() })
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

    const found = await findVisibleAgent(agentId, orgId, workspaceId);
    if (!found) {
      return c.json({ error: "Agent not found" }, 404);
    }
    // Shared agents are managed only on the Organization surface (ADR-0007).
    if (found.scope === "organization") {
      return c.json(
        { error: "This agent is managed at the organization level" },
        403,
      );
    }

    if (found.row.avatarKey) {
      try {
        const storage = getStorage();
        await storage.delete(found.row.avatarKey);
      } catch {
        // Ignore deletion errors
      }
    }

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
    const workspaceId = c.req.param("workspaceId")!;

    const existing = await db
      .select({
        avatarKey: agentTable.avatarKey,
      })
      .from(agentTable)
      .where(
        and(
          eq(agentTable.id, agentId),
          eq(agentTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    // A Shared Agent attached here has no workspace row to match; it must be
    // detached or deleted from the Organization surface (ADR-0007).
    if (existing.length === 0) {
      return c.json({ error: "Agent not found" }, 404);
    }

    if (existing[0]?.avatarKey) {
      try {
        const storage = getStorage();
        await storage.delete(existing[0].avatarKey);
      } catch {
        // Ignore deletion errors
      }
    }

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
      return c.json({ error: "Agent not found" }, 404);
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
        return c.json({ error: "Agent not found" }, 404);
      }
      if (isUniqueViolation(error)) {
        return c.json(
          {
            error:
              "An agent with this name already exists in this organization",
          },
          409,
        );
      }
      throw error;
    }
  },
);

export { agent };
