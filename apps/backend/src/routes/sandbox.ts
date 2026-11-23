import { posix } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validate } from "../validate.ts";
import { z } from "zod";
import { SANDBOX_TRANSFER_MAX_BYTES } from "@platypuschat/plugin-sdk";
import { db } from "../index.ts";
import type { sandbox as sandboxTable } from "../db/schema.ts";
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

const requireSandboxAdmin = requireWorkspaceConfigAccess(null);

const sandbox = new Hono<{ Variables: Variables }>();

const forceQuerySchema = z.strictObject({
  force: z.enum(["true", "false"]).optional(),
});

const sanitizeSandboxResponse = (record: SandboxRecord, isAdmin: boolean) => {
  const { credentials, adminEnv, ...rest } = record;
  const safeAdminEnv = isAdmin
    ? adminEnv
    : Object.fromEntries(Object.keys(adminEnv).map((k) => [k, ""]));
  return {
    ...rest,
    adminEnv: safeAdminEnv,
    hasCredentials: Object.keys(credentials).length > 0,
    transfer: transferSupport(record),
  };
};

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

const attachmentDisposition = (path: string) =>
  `attachment; filename*=UTF-8''${encodeURIComponent(posix.basename(path)).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`;

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

sandbox.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireSandboxAdmin,
  validate("json", sandboxCreateSchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const record = await createSandbox(workspaceId, c.req.valid("json"));
    return c.json(sanitizeSandboxResponse(record, true), 201);
  },
);

sandbox.put(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  validate("query", forceQuerySchema),
  validate("json", sandboxUpdateSchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const isAdmin = c.get("orgMembership")?.role === "admin";
    const { force } = c.req.valid("query");
    const record = await updateSandbox(workspaceId, c.req.valid("json"), {
      isAdmin,
      force: force === "true",
    });
    return c.json(sanitizeSandboxResponse(record, isAdmin));
  },
);

sandbox.delete(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireSandboxAdmin,
  validate("query", forceQuerySchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const { force } = c.req.valid("query");
    await deleteSandbox(workspaceId, {
      force: force === "true",
    });
    return c.json({ message: "Sandbox deleted" });
  },
);

const openTransfer = async (workspaceId: string) => {
  const record = await requireOwned(db, "sandbox", { workspaceId });
  return openSandboxRow(record, "transfer files");
};

sandbox.get(
  "/file",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  validate("query", z.strictObject({ path: relativePathSchema })),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const { path } = c.req.valid("query");
    const signal = c.req.raw.signal;
    const { backend, ctx } = await openTransfer(workspaceId);
    if (!backend.fsReadBytes) throw new UnsupportedError(TRANSFER_UNSUPPORTED);

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

sandbox.put(
  "/file",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  validate(
    "query",
    z.strictObject({
      path: relativePathSchema,
      overwrite: z.enum(["true", "false"]).optional(),
    }),
  ),
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

    // why: check-then-write race; fine while a Workspace has one user
    if (overwrite !== "true" && (await findEntry(backend, ctx, path, signal))) {
      return c.json({ error: `Path already exists: ${path}` }, 409);
    }

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    await backend.fsWriteBytes(ctx, { path, bytes }, { signal });
    return c.json({ message: "File uploaded" });
  },
);

export { sandbox };
