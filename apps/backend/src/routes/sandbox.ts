import { posix } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import { SANDBOX_TRANSFER_MAX_BYTES } from "@platypuschat/plugin-sdk";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { sandbox as sandboxTable } from "../db/schema.ts";
import { sandboxCreateSchema, sandboxUpdateSchema } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import {
  deleteOwned,
  requireOwned,
  resolveOwned,
  updateOwned,
} from "../services/workspace-resource.ts";
import type { Variables } from "../server.ts";
import { destroySandboxRow } from "../sandbox/teardown.ts";
import { createSandboxBackend, openSandboxRow } from "../sandbox/open-row.ts";
import { relativePathSchema } from "../sandbox/types.ts";
import { findEntry, TRANSFER_BOUND } from "../sandbox/find-entry.ts";
import { NotFoundError, UnsupportedError } from "../errors.ts";
import { getSandboxBackendPlugin } from "../plugins/registry.ts";
import { logger } from "../logger.ts";
import {
  envCollisions,
  sandboxCreateError,
  validateSandboxConfig,
  validateSandboxCredentials,
} from "../sandbox/validate.ts";

type SandboxRecord = typeof sandboxTable.$inferSelect;

// Sandboxes are admin-only and never delegatable to the workspace owner
// (ADR-0006). Reused on create/delete; PUT applies field-level gating inline.
const requireSandboxAdmin = requireWorkspaceConfigAccess();

const sandbox = new Hono<{ Variables: Variables }>();

// Credentials are server-side only, to admins too. Stripping here is a quiet
// improvement over the Provider/MCP routes which still return their secret
// fields; revisit when those routes adopt a similar redaction pattern. In their
// place `hasCredentials` says whether any are stored, so the settings form can
// show a stored key instead of a blank field that looks lost. `transfer` says
// which file-transfer directions the backend offers (ADR-0027), so the UI
// needn't attempt one to find out.
//
// adminEnv holds admin-managed secrets. A non-admin owner may see the *keys*
// (so the UI can show "managed by admin" and the orientation block stays
// coherent) but never the values (ADR-0006). Admins get the values so the
// settings form can edit them.
const sanitizeSandboxResponse = (record: SandboxRecord, isAdmin: boolean) => {
  const { credentials, adminEnv, ...rest } = record;
  const safeAdminEnv = isAdmin
    ? adminEnv
    : Object.fromEntries(Object.keys(adminEnv ?? {}).map((k) => [k, ""]));
  return {
    ...rest,
    adminEnv: safeAdminEnv,
    hasCredentials: Object.keys(credentials ?? {}).length > 0,
    transfer: transferSupport(record),
  };
};

// A backend that can't be built — unregistered, or its stored config no longer
// validates — can't transfer anything either.
const transferSupport = (record: SandboxRecord) => {
  try {
    const backend = createSandboxBackend(record, "transfer files");
    return { upload: !!backend.fsWriteBytes, download: !!backend.fsReadBytes };
  } catch {
    return { upload: false, download: false };
  }
};

const TRANSFER_UNSUPPORTED =
  "This Sandbox backend doesn't support file transfer";
const TRANSFER_TOO_LARGE = `File is larger than the ${TRANSFER_BOUND} transfer limit`;

// Filenames go out RFC 5987-encoded only, so no quote, backslash or non-ASCII
// character in a Sandbox-authored name can break the header.
const attachmentDisposition = (path: string) =>
  `attachment; filename*=UTF-8''${encodeURIComponent(posix.basename(path)).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`;

/** Get the workspace's sandbox (404 if none configured) */
sandbox.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const record = await requireOwned(db, "sandbox", { workspaceId });
    const isAdmin = c.get("orgMembership")?.role === "admin";
    return c.json(sanitizeSandboxResponse(record, isAdmin));
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
    const { workspaceId } = workspaceScopeOf(c);
    const data = c.req.valid("json");

    const createError = sandboxCreateError(data);
    if (createError) return c.json({ error: createError }, 400);

    const existing = await resolveOwned(db, "sandbox", { workspaceId });
    if (existing) {
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
    const { workspaceId } = workspaceScopeOf(c);
    const data = c.req.valid("json");
    const force = c.req.query("force") === "true";
    const isAdmin = c.get("orgMembership")?.role === "admin";

    const current = await requireOwned(db, "sandbox", { workspaceId });

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
      const record = await updateOwned(
        db,
        "sandbox",
        { workspaceId },
        {
          name: data.name,
          ...(data.userEnv !== undefined ? { userEnv: data.userEnv } : {}),
          updatedAt: new Date(),
        },
      );
      // Non-admin owner — redact adminEnv values in the response.
      return c.json(sanitizeSandboxResponse(record!, false));
    }

    // Admin: full update.
    const configError = validateSandboxConfig(data.backend, data.config);
    if (configError) {
      return c.json({ error: `Invalid sandbox config: ${configError}` }, 400);
    }
    // Validate credentials only when present — GET strips them, so an edit that
    // leaves the field untouched preserves the stored value (Drizzle skips
    // undefined columns) and must not be rejected for being absent.
    if (data.credentials !== undefined) {
      const credentialsError = validateSandboxCredentials(
        data.backend,
        data.credentials,
      );
      if (credentialsError) {
        return c.json(
          { error: `Invalid sandbox credentials: ${credentialsError}` },
          400,
        );
      }
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
          {
            workspaceId,
            sandboxId: current.id,
            backend: current.backend,
            plugin: getSandboxBackendPlugin(current.backend) ?? null,
            err,
          },
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
          // `backend`/`plugin` co-refer on every line here, and on this one they
          // name the adapter that was skipped — the one whose external resources
          // may now be leaked, and so the one an Operator filtering by plugin is
          // looking for. The incoming backend has leaked nothing, which is why it
          // is `replacedBy` rather than the `newBackend` half of an old/new pair:
          // a symmetric pair invites `plugin` to be read as spanning both.
          backend: current.backend,
          plugin: getSandboxBackendPlugin(current.backend) ?? null,
          replacedBy: data.backend,
        },
        "Sandbox backend force-changed; previous adapter's destroy() was skipped — external resources may leak",
      );
    }

    const record = await updateOwned(
      db,
      "sandbox",
      { workspaceId },
      {
        ...data,
        updatedAt: new Date(),
      },
    );
    // Reached only on the admin branch above.
    return c.json(sanitizeSandboxResponse(record!, true));
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
    const { workspaceId } = workspaceScopeOf(c);
    const force = c.req.query("force") === "true";

    const existing = await requireOwned(db, "sandbox", { workspaceId });

    if (!force) {
      try {
        await destroySandboxRow(existing);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          {
            workspaceId,
            sandboxId: existing.id,
            backend: existing.backend,
            plugin: getSandboxBackendPlugin(existing.backend) ?? null,
            err,
          },
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
          sandboxId: existing.id,
          backend: existing.backend,
          plugin: getSandboxBackendPlugin(existing.backend) ?? null,
        },
        "Sandbox row force-deleted; adapter destroy() was skipped — external resources may leak",
      );
    }

    await deleteOwned(db, "sandbox", { workspaceId });
    return c.json({ message: "Sandbox deleted" });
  },
);

// File transfer (ADR-0027): bytes move between the User and the Sandbox without
// the model, up to SANDBOX_TRANSFER_MAX_BYTES, held in memory only. Paths use
// the tool path schema and `..` is deliberately not rejected — anyone past
// requireWorkspaceAccess can already run arbitrary shell in the Sandbox.
const openTransfer = async (workspaceId: string) => {
  const record = await requireOwned(db, "sandbox", { workspaceId });
  return openSandboxRow(record, "transfer files");
};

/** Download a file from the workspace's sandbox. Always an attachment. */
sandbox.get(
  "/file",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("query", z.object({ path: relativePathSchema })),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const { path } = c.req.valid("query");
    const signal = c.req.raw.signal;
    const { backend, ctx } = await openTransfer(workspaceId);
    if (!backend.fsReadBytes) throw new UnsupportedError(TRANSFER_UNSUPPORTED);

    // fsReadBytes' rejections are untyped, so the probe is what tells a missing
    // file from an oversized one from a failure.
    const entry = await findEntry(backend, ctx, path, signal);
    if (entry?.type !== "file") throw new NotFoundError("File not found");
    if ((entry.size ?? 0) > SANDBOX_TRANSFER_MAX_BYTES) {
      return c.json({ error: TRANSFER_TOO_LARGE }, 413);
    }

    const bytes = await backend.fsReadBytes(
      ctx,
      { path, maxBytes: SANDBOX_TRANSFER_MAX_BYTES },
      { signal },
    );
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": attachmentDisposition(path),
      "X-Content-Type-Options": "nosniff",
    });
  },
);

/**
 * Upload a raw request body to `path` in the workspace's sandbox. 409 if the
 * path is taken, unless `overwrite=true`.
 */
sandbox.put(
  "/file",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator(
    "query",
    z.object({
      path: relativePathSchema,
      overwrite: z.enum(["true", "false"]).optional(),
    }),
  ),
  // Rejects early on Content-Length and enforces the bound while reading.
  bodyLimit({
    maxSize: SANDBOX_TRANSFER_MAX_BYTES,
    onError: (c) => c.json({ error: TRANSFER_TOO_LARGE }, 413),
  }),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const { path, overwrite } = c.req.valid("query");
    const signal = c.req.raw.signal;
    const { backend, ctx } = await openTransfer(workspaceId);
    if (!backend.fsWriteBytes) throw new UnsupportedError(TRANSFER_UNSUPPORTED);

    // ponytail: check-then-write race — a file created between the probe and
    // the write is overwritten. Fine for a single-user Workspace; a
    // create-only adapter member if it ever isn't.
    if (overwrite !== "true" && (await findEntry(backend, ctx, path, signal))) {
      return c.json({ error: `Path already exists: ${path}` }, 409);
    }

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    await backend.fsWriteBytes(ctx, { path, bytes }, { signal });
    return c.json({ message: "File uploaded" });
  },
);

export { sandbox };
