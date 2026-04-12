import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { agent as agentTable } from "../db/schema.ts";
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
import { getStorage } from "../storage/index.ts";
import sharp from "sharp";
import { avatarKeyToUrl } from "../utils/avatar-url.ts";

const ALLOWED_AVATAR_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];
const MAX_AVATAR_SIZE = 5 * 1024 * 1024;
const MIN_AVATAR_DIMENSION = 64;
const AVATAR_SIZE = 512;

function agentWithAvatarUrl(
  agent: Record<string, unknown>,
  baseUrl: string,
): Record<string, unknown> {
  const key = agent.avatarKey as string | null | undefined;
  const { avatarKey: _avatarKey, ...rest } = agent;
  return { ...rest, avatarUrl: avatarKeyToUrl(key, baseUrl) ?? undefined };
}

const agent = new Hono<{ Variables: Variables }>();

/** Create a new agent (admin or editor) */
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
        return c.json({ message: validation.error }, 400);
      }
    }

    const baseUrl =
      process.env.BETTER_AUTH_URL ||
      `http://localhost:${process.env.PORT || 4000}`;
    const record = await db
      .insert(agentTable)
      .values({
        id: nanoid(),
        ...data,
      })
      .returning();
    return c.json(agentWithAvatarUrl(record[0], baseUrl), 201);
  },
);

/** List all agents */
agent.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const baseUrl =
      process.env.BETTER_AUTH_URL ||
      `http://localhost:${process.env.PORT || 4000}`;
    const results = await db
      .select()
      .from(agentTable)
      .where(eq(agentTable.workspaceId, workspaceId));
    return c.json({
      results: results.map((r) => agentWithAvatarUrl(r, baseUrl)),
    });
  },
);

/** Get an agent by ID */
agent.get(
  "/:agentId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const agentId = c.req.param("agentId");
    const workspaceId = c.req.param("workspaceId")!;
    const baseUrl =
      process.env.BETTER_AUTH_URL ||
      `http://localhost:${process.env.PORT || 4000}`;
    const record = await db
      .select()
      .from(agentTable)
      .where(
        and(
          eq(agentTable.id, agentId),
          eq(agentTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (record.length === 0) {
      return c.json({ message: "Agent not found" }, 404);
    }
    return c.json(agentWithAvatarUrl(record[0], baseUrl));
  },
);

/** Update an agent by ID (admin or editor) */
agent.put(
  "/:agentId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", agentUpdateSchema),
  async (c) => {
    const agentId = c.req.param("agentId");
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
    if (data.subAgentIds) {
      const validation = await validateSubAgentAssignment(
        workspaceId,
        agentId,
        data.subAgentIds,
      );
      if (!validation.valid) {
        return c.json({ message: validation.error }, 400);
      }
    }

    const baseUrl =
      process.env.BETTER_AUTH_URL ||
      `http://localhost:${process.env.PORT || 4000}`;
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
    const baseUrl =
      process.env.BETTER_AUTH_URL ||
      `http://localhost:${process.env.PORT || 4000}`;

    const body = await c.req.parseBody();
    const file = body["file"];
    if (!file || !(file instanceof File)) {
      return c.json({ message: "No file provided" }, 400);
    }

    if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
      return c.json({ message: "Invalid file type" }, 400);
    }

    if (file.size > MAX_AVATAR_SIZE) {
      return c.json({ message: "File too large (max 5MB)" }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(buffer).metadata();
    } catch {
      return c.json({ message: "Invalid image" }, 400);
    }

    if (metadata.width && metadata.height) {
      if (
        metadata.width < MIN_AVATAR_DIMENSION ||
        metadata.height < MIN_AVATAR_DIMENSION
      ) {
        return c.json(
          {
            message: `Image must be at least ${MIN_AVATAR_DIMENSION}x${MIN_AVATAR_DIMENSION} pixels`,
          },
          400,
        );
      }
    }

    const processedBuffer = await sharp(buffer)
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover" })
      .webp()
      .toBuffer();

    const key = `${orgId}/${workspaceId}/agents/${agentId}/avatar-${nanoid()}.webp`;

    const existing = await db
      .select({ avatarKey: agentTable.avatarKey })
      .from(agentTable)
      .where(
        and(
          eq(agentTable.id, agentId),
          eq(agentTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (existing[0]?.avatarKey) {
      try {
        const storage = getStorage();
        await storage.delete(existing[0].avatarKey);
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
    const workspaceId = c.req.param("workspaceId")!;
    const baseUrl =
      process.env.BETTER_AUTH_URL ||
      `http://localhost:${process.env.PORT || 4000}`;

    const existing = await db
      .select({ avatarKey: agentTable.avatarKey })
      .from(agentTable)
      .where(
        and(
          eq(agentTable.id, agentId),
          eq(agentTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (existing[0]?.avatarKey) {
      try {
        const storage = getStorage();
        await storage.delete(existing[0].avatarKey);
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

/** Delete an agent by ID (admin only) */
agent.delete(
  "/:agentId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const agentId = c.req.param("agentId");
    const workspaceId = c.req.param("workspaceId")!;

    const existing = await db
      .select({ avatarKey: agentTable.avatarKey })
      .from(agentTable)
      .where(
        and(
          eq(agentTable.id, agentId),
          eq(agentTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

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

export { agent };
