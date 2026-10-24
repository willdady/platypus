import type { z } from "zod";
import { nanoid } from "nanoid";
import { db, type Executor } from "../index.ts";
import { sandbox as sandboxTable } from "../db/schema.ts";
import type {
  sandboxCreateSchema,
  sandboxUpdateSchema,
} from "@platypus/schemas";
import {
  ConflictError,
  isUniqueViolation,
  NotFoundError,
  UpstreamError,
  ValidationError,
} from "../errors.ts";
import { logger } from "../logger.ts";
import { getSandboxBackendPlugin } from "../plugins/registry.ts";
import { destroySandboxRow } from "../sandbox/teardown.ts";
import {
  envCollisionError,
  sandboxCreateError,
  sandboxSchemaError,
} from "../sandbox/validate.ts";
import { errorMessage } from "../utils/error-message.ts";
import {
  deleteOwned,
  requireOwned,
  updateOwned,
} from "./workspace-resource.ts";

/**
 * The Sandbox write model: create, update and delete for the one Sandbox a
 * Workspace may have. The Sandbox routes and Workspace creation adapt over it,
 * as the Provider and MCP routes do over `provider-write.ts`/`mcp-write.ts`.
 *
 * Deleting a Sandbox, or changing its `backend`, is fail-loud (ADR-0001): the
 * adapter's `destroy()` runs first and the row is left as it was when that
 * fails (`UpstreamError` → 502). `force` skips the destroy and logs that
 * external resources may leak. The Workspace cascade's best-effort teardown is
 * `sandbox/teardown.ts`, not this module.
 */

export type SandboxRow = typeof sandboxTable.$inferSelect;

/** The fields a create carries — every field but the id and its Workspace. */
export type SandboxCreateFields = Omit<
  z.infer<typeof sandboxCreateSchema>,
  "workspaceId"
>;

export type SandboxUpdateFields = z.infer<typeof sandboxUpdateSchema>;

const throwIfInvalid = (error: string | null) => {
  if (error) throw new ValidationError(error);
};

/**
 * Creates the Workspace's Sandbox. Throws `ValidationError` when the config,
 * credentials or env fail their checks, and `ConflictError` when the Workspace
 * already has one — decided by the unique index, so two concurrent creates
 * cannot both succeed.
 */
export async function createSandbox(
  workspaceId: string,
  fields: SandboxCreateFields,
  // A transaction handle, when the create is one step of a larger write.
  exec: Executor = db,
): Promise<SandboxRow> {
  throwIfInvalid(sandboxCreateError(fields));
  try {
    const [row] = await exec
      .insert(sandboxTable)
      .values({ id: nanoid(), ...fields, workspaceId })
      .returning();
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("Sandbox already configured for this workspace");
    }
    throw error;
  }
}

/**
 * Runs the adapter's `destroy()` for `row` unless `force` is set, throwing
 * `UpstreamError` when it fails. `action` finishes the `?force=true` hint.
 */
const destroyFirst = async (
  row: SandboxRow,
  force: boolean,
  failure: { prefix: string; action: string; log: string },
  forced: { log: string; replacedBy?: string },
) => {
  const fields = {
    workspaceId: row.workspaceId,
    sandboxId: row.id,
    backend: row.backend,
    plugin: getSandboxBackendPlugin(row.backend) ?? null,
  };
  if (force) {
    // `backend`/`plugin` name the adapter that was skipped — the one whose
    // external resources may now be leaked, and so the one an Operator
    // filtering by plugin is looking for. An incoming backend has leaked
    // nothing, which is why it is `replacedBy` rather than the `newBackend`
    // half of an old/new pair.
    logger.warn(
      {
        ...fields,
        ...(forced.replacedBy !== undefined && {
          replacedBy: forced.replacedBy,
        }),
      },
      forced.log,
    );
    return;
  }
  try {
    await destroySandboxRow(row);
  } catch (err) {
    logger.warn({ ...fields, err }, failure.log);
    throw new UpstreamError(
      `${failure.prefix}: ${errorMessage(err)}. Pass ?force=true to ${failure.action} anyway (external resources may leak).`,
    );
  }
};

/**
 * Updates the Workspace's Sandbox. Field-level authorization (ADR-0006):
 *
 *   - An Org admin may change every field. `name`/`backend` are always
 *     overwritten; `config`/`credentials`/`adminEnv`/`userEnv` are kept when
 *     omitted (Drizzle skips undefined columns), since GET strips credentials
 *     and the form cannot re-send them.
 *   - A non-admin Workspace Owner may change only `name` and `userEnv`. Every
 *     reach/execution/credential field is ignored, even if present — the
 *     Owner's client does not show them, and ignoring an echoed-but-unchanged
 *     value avoids a false rejection.
 *
 * `userEnv` may never override an admin-managed key. Changing `backend`
 * destroys the old adapter's resources first (see {@link destroyFirst}).
 */
export async function updateSandbox(
  workspaceId: string,
  fields: SandboxUpdateFields,
  options: { isAdmin: boolean; force: boolean },
): Promise<SandboxRow> {
  const current = await requireOwned(db, "sandbox", { workspaceId });

  if (!options.isAdmin) {
    throwIfInvalid(envCollisionError(current.adminEnv, fields.userEnv));
    return written(
      await updateOwned(
        db,
        "sandbox",
        { workspaceId },
        {
          name: fields.name,
          ...(fields.userEnv !== undefined && { userEnv: fields.userEnv }),
          updatedAt: new Date(),
        },
      ),
    );
  }

  throwIfInvalid(sandboxSchemaError(fields.backend, "config", fields.config));
  if (fields.credentials !== undefined) {
    throwIfInvalid(
      sandboxSchemaError(fields.backend, "credentials", fields.credentials),
    );
  }
  throwIfInvalid(
    envCollisionError(
      fields.adminEnv ?? current.adminEnv,
      fields.userEnv ?? current.userEnv,
    ),
  );

  if (current.backend !== fields.backend) {
    await destroyFirst(
      current,
      options.force,
      {
        prefix: "Failed to destroy previous sandbox",
        action: "switch backend",
        log: "Sandbox backend change blocked: previous adapter's destroy() failed",
      },
      {
        log: "Sandbox backend force-changed; previous adapter's destroy() was skipped — external resources may leak",
        replacedBy: fields.backend,
      },
    );
  }

  return written(
    await updateOwned(
      db,
      "sandbox",
      { workspaceId },
      { ...fields, updatedAt: new Date() },
    ),
  );
}

// A concurrent delete can land between the read and the UPDATE.
const written = (row: SandboxRow | null): SandboxRow => {
  if (!row) throw new NotFoundError("Sandbox not found");
  return row;
};

/**
 * Deletes the Workspace's Sandbox, destroying its external resources first;
 * the row is kept when that fails, so the user can retry or force.
 */
export async function deleteSandbox(
  workspaceId: string,
  options: { force: boolean },
): Promise<void> {
  const existing = await requireOwned(db, "sandbox", { workspaceId });
  await destroyFirst(
    existing,
    options.force,
    {
      prefix: "Failed to destroy sandbox",
      action: "delete the row",
      log: "Sandbox destroy() failed; row preserved so the user can retry",
    },
    {
      log: "Sandbox row force-deleted; adapter destroy() was skipped — external resources may leak",
    },
  );
  await deleteOwned(db, "sandbox", { workspaceId });
}
