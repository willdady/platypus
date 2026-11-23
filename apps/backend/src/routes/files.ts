import { Readable } from "node:stream";
import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import { isSuperAdmin, userOf } from "../middleware/authorization.ts";
import { assertValidStorageKey, isSkillStorageKey } from "../storage/keys.ts";
import { FILES_ROUTE_PREFIX } from "../storage/file-reference.ts";
import {
  organizationMember,
  workspace as workspaceTable,
} from "../db/schema.ts";
import type { Variables } from "../server.ts";
import { db } from "../index.ts";
import { getStorage } from "../storage/index.ts";
import { servedFileHeaders } from "../storage/response-headers.ts";

const files = new Hono<{ Variables: Variables }>();

function parseStorageKey(
  key: string,
): { orgId: string; workspaceId: string } | null {
  const [orgId, workspaceId] = key.split("/");
  if (orgId === undefined || workspaceId === undefined) {
    return null;
  }
  return { orgId, workspaceId };
}

files.get("/*", requireAuth, async (c) => {
  const user = userOf(c);

  const key = c.req.path.slice(FILES_ROUTE_PREFIX.length);

  if (!key) {
    return c.json({ error: "File key required" }, 400);
  }

  assertValidStorageKey(key);

  if (isSkillStorageKey(key)) {
    return c.json({ error: "Access denied" }, 403);
  }

  const keyParts = parseStorageKey(key);
  if (!keyParts) {
    return c.json({ error: "Invalid file key format" }, 400);
  }

  const { orgId, workspaceId } = keyParts;

  if (!(user.role && isSuperAdmin(user))) {
    const [membership] = await db
      .select()
      .from(organizationMember)
      .where(
        and(
          eq(organizationMember.userId, user.id),
          eq(organizationMember.organizationId, orgId),
        ),
      )
      .limit(1);

    if (!membership) {
      return c.json({ error: "Access denied" }, 403);
    }

    if (membership.role !== "admin") {
      const [ws] = await db
        .select()
        .from(workspaceTable)
        .where(eq(workspaceTable.id, workspaceId))
        .limit(1);

      if (!ws) {
        return c.json({ error: "Workspace not found" }, 404);
      }

      if (ws.ownerId !== user.id) {
        return c.json({ error: "Access denied" }, 403);
      }
    }
  }

  const storage = getStorage();
  const result = await storage.getStream(key);

  if (!result) {
    return c.json({ error: "File not found" }, 404);
  }

  const { stream, contentType, contentLength } = result;

  c.header("Content-Type", contentType);
  c.header("X-Content-Type-Options", "nosniff");
  for (const [name, value] of Object.entries(servedFileHeaders(contentType))) {
    c.header(name, value);
  }
  c.header("Cache-Control", "private, max-age=31536000, immutable");
  c.header("Content-Length", contentLength.toString());

  return c.body(Readable.toWeb(stream) as ReadableStream<Uint8Array>);
});

export { files };
