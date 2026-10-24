import { posix } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validate } from "../validate.ts";
import { z } from "zod";
import { SANDBOX_TRANSFER_MAX_BYTES } from "@platypuschat/plugin-sdk";
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
import { requireOwned } from "../services/workspace-resource.ts";
import {
  createSandbox,
  deleteSandbox,
  updateSandbox,
} from "../services/sandbox-write.ts";
import type { Variables } from "../server.ts";
import { createSandboxBackend, openSandboxRow } from "../sandbox/open-row.ts";
import { relativePathSchema } from "../sandbox/types.ts";
import { findEntry, TRANSFER_BOUND } from "../sandbox/find-entry.ts";
import { NotFoundError, UnsupportedError } from "../errors.ts";
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
  validate("json", sandboxCreateSchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    // The body's workspaceId is overridden by the route's.
    const record = await createSandbox(workspaceId, c.req.valid("json"));
    // POST is admin-only (requireSandboxAdmin), so always full response.
    return c.json(sanitizeSandboxResponse(record, true), 201);
  },
);

// Update the workspace's sandbox. Field-level authorization (ADR-0006) lives in
// updateSandbox. Changing `backend` (admin only) destroys the previous
// adapter's resources first (ADR-0001); pass ?force=true to skip that and
// switch anyway.
sandbox.put(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  validate("json", sandboxUpdateSchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const isAdmin = c.get("orgMembership")?.role === "admin";
    const record = await updateSandbox(workspaceId, c.req.valid("json"), {
      isAdmin,
      force: c.req.query("force") === "true",
    });
    // A non-admin owner gets adminEnv values redacted.
    return c.json(sanitizeSandboxResponse(record, isAdmin));
  },
);

// Delete the workspace's sandbox. Sync, fail-loud per ADR-0001: the adapter's
// destroy() runs inline and the row is only removed on success. Pass
// `?force=true` to skip destroy() and remove the row anyway.
sandbox.delete(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireSandboxAdmin,
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    await deleteSandbox(workspaceId, {
      force: c.req.query("force") === "true",
    });
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
  validate("query", z.object({ path: relativePathSchema })),
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
  validate(
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
