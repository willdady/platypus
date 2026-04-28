import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import { isSuperAdmin } from "../middleware/authorization.ts";
import {
  organizationMember,
  workspace as workspaceTable,
} from "../db/schema.ts";
import type { Variables } from "../server.ts";
import { getStorage } from "../storage/index.ts";

const files = new Hono<{ Variables: Variables }>();

/**
 * Parse a storage key to extract org and workspace IDs.
 * Key format: {orgId}/{workspaceId}/{chatId}/{messageId}/{partIndex}-{hash8}.{ext}
 */
function parseStorageKey(
  key: string,
): { orgId: string; workspaceId: string } | null {
  const parts = key.split("/");
  if (parts.length < 2) {
    return null;
  }
  return {
    orgId: parts[0],
    workspaceId: parts[1],
  };
}

/**
 * GET /files/* - Serve files from storage.
 *
 * This endpoint proxies files from the storage backend to the client.
 * It verifies that the user has access to the organization and workspace
 * before serving the file.
 *
 * When STORAGE_PUBLIC_URL is set, this endpoint is typically bypassed
 * as the browser fetches files directly from the storage URL.
 */
files.get("/*", requireAuth, async (c) => {
  const user = c.get("user")!;
  const db = c.get("db");

  // Extract the storage key from the wildcard path
  const key = c.req.path.slice("/files/".length);

  if (!key) {
    return c.json({ error: "File key required" }, 400);
  }

  // Parse org and workspace from the key
  const keyParts = parseStorageKey(key);
  if (!keyParts) {
    return c.json({ error: "Invalid file key format" }, 400);
  }

  const { orgId, workspaceId } = keyParts;

  // Authorization check
  // Super admins bypass all checks
  if (user.role && isSuperAdmin(user as { role: string })) {
    // Continue to serve file
  } else {
    // Check org membership
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

    // For non-admin members, check workspace ownership
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

  // Fetch file from storage
  const storage = getStorage();
  const result = await storage.get(key);

  if (!result) {
    return c.json({ error: "File not found" }, 404);
  }

  const { data, contentType } = result;

  // Set response headers
  c.header("Content-Type", contentType);
  c.header("Cache-Control", "private, max-age=31536000, immutable");
  c.header("Content-Length", data.length.toString());

  return c.body(new Uint8Array(data));
});

export { files };
