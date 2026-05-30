import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import { sandbox as sandboxTable } from "../db/schema.ts";
import { sandboxCreateSchema, sandboxUpdateSchema } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { destroySandboxRow } from "../sandbox/teardown.ts";
import { getSandboxBackend, getSandboxBackends } from "../sandbox/index.ts";
import { readAllowedDockerNetworks } from "../sandbox/backends/docker.ts";
import { logger } from "../logger.ts";

type SandboxRecord = typeof sandboxTable.$inferSelect;

// Sandboxes are admin-only and never delegatable to the workspace owner
// (ADR-0006). Reused on create/delete; PUT applies field-level gating inline.
const requireSandboxAdmin = requireWorkspaceConfigAccess();

const sandbox = new Hono<{ Variables: Variables }>();

// Validate adapter-specific config at write time when the backend is
// registered, so errors (e.g. a network outside the operator allowlist, a
// malformed extraHosts entry) surface as an immediate 400 instead of silently
// degrading to "no sandbox tools" at chat-turn time. Returns an error message
// string, or null when valid / backend not registered.
const validateSandboxConfig = (
  backend: string,
  config: Record<string, unknown> | undefined,
): string | null => {
  const registration = getSandboxBackend(backend);
  if (!registration) return null;
  const result = registration.configSchema.safeParse(config ?? {});
  if (result.success) return null;
  return result.error.issues.map((i) => i.message).join("; ");
};

// The owner may never override an admin-set env key (ADR-0004 amendment).
// Returns the colliding keys, or [] when there is no overlap.
const envCollisions = (
  adminEnv: Record<string, string> | undefined,
  userEnv: Record<string, string> | undefined,
): string[] => {
  if (!adminEnv || !userEnv) return [];
  const adminKeys = new Set(Object.keys(adminEnv));
  return Object.keys(userEnv).filter((k) => adminKeys.has(k));
};

// Credentials are server-side only. Stripping here is a quiet improvement over
// the Provider/MCP routes which still return their secret fields; revisit when
// those routes adopt a similar redaction pattern.
//
// adminEnv holds admin-managed secrets. A non-admin owner may see the *keys*
// (so the UI can show "managed by admin" and the orientation block stays
// coherent) but never the values (ADR-0006). Admins get the values so the
// settings form can edit them.
const sanitizeSandboxResponse = (record: SandboxRecord, isAdmin: boolean) => {
  const { credentials: _credentials, adminEnv, ...rest } = record;
  const safeAdminEnv = isAdmin
    ? adminEnv
    : Object.fromEntries(Object.keys(adminEnv ?? {}).map((k) => [k, ""]));
  return { ...rest, adminEnv: safeAdminEnv };
};

// List the Sandbox backends registered in this process. Returns metadata only
// (no Zod schemas); the frontend renders forms per known backend type for v1.
// Declared before "/" so the literal "/backends" path takes precedence.
sandbox.get(
  "/backends",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const results = getSandboxBackends().map((r) => ({
      backend: r.backend,
      name: r.name,
    }));
    return c.json({ results });
  },
);

// Operator-declared Docker network allowlist (ADR-0005) for the admin
// multi-select. Admin-only — a non-admin owner has no business enumerating the
// host's network topology. Declared before "/" so the literal path wins.
sandbox.get(
  "/networks",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireSandboxAdmin,
  async (c) => {
    return c.json({ results: readAllowedDockerNetworks() });
  },
);

/** Get the workspace's sandbox (404 if none configured) */
sandbox.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const record = await db
      .select()
      .from(sandboxTable)
      .where(eq(sandboxTable.workspaceId, workspaceId))
      .limit(1);
    if (record.length === 0) {
      return c.json({ error: "Sandbox not configured" }, 404);
    }
    const isAdmin = c.get("orgMembership")?.role === "admin";
    return c.json(sanitizeSandboxResponse(record[0], isAdmin));
  },
);

/** Create the workspace's sandbox. Admin-only (ADR-0006). 409 if one exists. */
sandbox.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireSandboxAdmin,
  sValidator("json", sandboxCreateSchema),
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const data = c.req.valid("json");

    const configError = validateSandboxConfig(data.backend, data.config);
    if (configError) {
      return c.json({ error: `Invalid sandbox config: ${configError}` }, 400);
    }

    const collisions = envCollisions(data.adminEnv, data.userEnv);
    if (collisions.length > 0) {
      return c.json(
        {
          error: `userEnv may not override admin-managed keys: ${collisions.join(", ")}`,
        },
        400,
      );
    }

    const existing = await db
      .select()
      .from(sandboxTable)
      .where(eq(sandboxTable.workspaceId, workspaceId))
      .limit(1);
    if (existing.length > 0) {
      return c.json(
        { error: "Sandbox already configured for this workspace" },
        409,
      );
    }

    const record = await db
      .insert(sandboxTable)
      .values({
        id: nanoid(),
        ...data,
        workspaceId,
      })
      .returning();
    // POST is admin-only (requireSandboxAdmin), so always full response.
    return c.json(sanitizeSandboxResponse(record[0], true), 201);
  },
);

// Update the workspace's sandbox. Field-level authorization (ADR-0006):
//
//   - Org admins may change every field. `name`/`backend` are required and
//     always overwritten; `config`/`credentials`/`adminEnv`/`userEnv` are
//     optional and preserved when omitted (Drizzle treats undefined as "skip
//     column"), which is necessary because GET strips credentials so the
//     frontend can't re-send them.
//   - A non-admin Workspace Owner may change only `name` and `userEnv`. Every
//     reach/execution/credential field (`backend`, `config`, `credentials`,
//     `adminEnv`) is ignored, even if present in the body — the owner's client
//     does not surface them, and silently ignoring avoids false rejections
//     from echoed-but-unchanged values.
//
// `userEnv` may never override an admin-managed key (checked against the
// authoritative stored `adminEnv`).
//
// Changing `backend` (admin only) is treated as destroy-then-update per
// ADR-0001: the previous adapter's destroy() fires inline against the old row
// before the new backend is written. Pass ?force=true to skip the destroy and
// switch anyway (external resources may leak; logged as a warning).
sandbox.put(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", sandboxUpdateSchema),
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const data = c.req.valid("json");
    const force = c.req.query("force") === "true";
    const isAdmin = c.get("orgMembership")?.role === "admin";

    const existing = await db
      .select()
      .from(sandboxTable)
      .where(eq(sandboxTable.workspaceId, workspaceId))
      .limit(1);
    if (existing.length === 0) {
      return c.json({ error: "Sandbox not configured" }, 404);
    }
    const current = existing[0];

    // Non-admin owner: restrict to name + userEnv, no backend/config changes.
    if (!isAdmin) {
      const collisions = envCollisions(current.adminEnv, data.userEnv);
      if (collisions.length > 0) {
        return c.json(
          {
            error: `userEnv may not override admin-managed keys: ${collisions.join(", ")}`,
          },
          400,
        );
      }
      const record = await db
        .update(sandboxTable)
        .set({
          name: data.name,
          ...(data.userEnv !== undefined ? { userEnv: data.userEnv } : {}),
          updatedAt: new Date(),
        })
        .where(eq(sandboxTable.workspaceId, workspaceId))
        .returning();
      // Non-admin owner — redact adminEnv values in the response.
      return c.json(sanitizeSandboxResponse(record[0], false));
    }

    // Admin: full update.
    const configError = validateSandboxConfig(data.backend, data.config);
    if (configError) {
      return c.json({ error: `Invalid sandbox config: ${configError}` }, 400);
    }
    const collisions = envCollisions(
      data.adminEnv ?? current.adminEnv,
      data.userEnv ?? current.userEnv,
    );
    if (collisions.length > 0) {
      return c.json(
        {
          error: `userEnv may not override admin-managed keys: ${collisions.join(", ")}`,
        },
        400,
      );
    }

    const backendChanging = current.backend !== data.backend;
    if (backendChanging && !force) {
      try {
        await destroySandboxRow(current);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          { workspaceId, sandboxId: current.id, err },
          "Sandbox backend change blocked: previous adapter's destroy() failed",
        );
        return c.json(
          {
            error: `Failed to destroy previous sandbox: ${message}. Pass ?force=true to switch backend anyway (external resources may leak).`,
          },
          500,
        );
      }
    } else if (backendChanging && force) {
      logger.warn(
        {
          workspaceId,
          sandboxId: current.id,
          oldBackend: current.backend,
          newBackend: data.backend,
        },
        "Sandbox backend force-changed; previous adapter's destroy() was skipped — external resources may leak",
      );
    }

    const record = await db
      .update(sandboxTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(sandboxTable.workspaceId, workspaceId))
      .returning();
    // Reached only on the admin branch above.
    return c.json(sanitizeSandboxResponse(record[0], true));
  },
);

// Delete the workspace's sandbox. Sync, fail-loud per ADR-0001: the adapter's
// destroy() runs inline and the row is only removed on success. Pass
// `?force=true` to skip destroy() and remove the row anyway — external
// resources may leak; logged as a warning.
sandbox.delete(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireSandboxAdmin,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const force = c.req.query("force") === "true";

    const existing = await db
      .select()
      .from(sandboxTable)
      .where(eq(sandboxTable.workspaceId, workspaceId))
      .limit(1);
    if (existing.length === 0) {
      return c.json({ error: "Sandbox not configured" }, 404);
    }

    if (!force) {
      try {
        await destroySandboxRow(existing[0]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          { workspaceId, sandboxId: existing[0].id, err },
          "Sandbox destroy() failed; row preserved so the user can retry",
        );
        return c.json(
          {
            error: `Failed to destroy sandbox: ${message}. Pass ?force=true to delete the row anyway (external resources may leak).`,
          },
          500,
        );
      }
    } else {
      logger.warn(
        {
          workspaceId,
          sandboxId: existing[0].id,
          backend: existing[0].backend,
        },
        "Sandbox row force-deleted; adapter destroy() was skipped — external resources may leak",
      );
    }

    await db
      .delete(sandboxTable)
      .where(eq(sandboxTable.workspaceId, workspaceId));
    return c.json({ message: "Sandbox deleted" });
  },
);

export { sandbox };
