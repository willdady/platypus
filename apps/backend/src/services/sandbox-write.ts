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
  type ValidationError,
} from "../errors.ts";
import { logger } from "../logger.ts";
import { getSandboxBackendPlugin } from "../plugins/registry.ts";
import { destroySandboxRow } from "../sandbox/teardown.ts";
import {
  envCollisionFailure,
  sandboxCreateError,
  sandboxSchemaFailure,
} from "../sandbox/validate.ts";
import { errorMessage } from "../utils/error-message.ts";
import {
  deleteOwned,
  requireOwned,
  updateOwned,
} from "./workspace-resource.ts";
import { oneRow } from "../db/one-row.ts";

export type SandboxRow = typeof sandboxTable.$inferSelect;

export type SandboxCreateFields = Omit<
  z.infer<typeof sandboxCreateSchema>,
  "workspaceId"
>;

export type SandboxUpdateFields = z.infer<typeof sandboxUpdateSchema>;

const throwIfInvalid = (error: ValidationError | null) => {
  if (error) throw error;
};

export async function createSandbox(
  workspaceId: string,
  fields: SandboxCreateFields,
  exec: Executor = db,
): Promise<SandboxRow> {
  throwIfInvalid(sandboxCreateError(fields));
  try {
    const row = oneRow(
      await exec
        .insert(sandboxTable)
        .values({ id: nanoid(), ...fields, workspaceId })
        .returning(),
    );
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("Sandbox already configured for this workspace");
    }
    throw error;
  }
}

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

export async function updateSandbox(
  workspaceId: string,
  fields: SandboxUpdateFields,
  options: { isAdmin: boolean; force: boolean },
): Promise<SandboxRow> {
  const current = await requireOwned(db, "sandbox", { workspaceId });

  if (!options.isAdmin) {
    throwIfInvalid(envCollisionFailure(current.adminEnv, fields.userEnv));
    return requireWritten(
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

  throwIfInvalid(sandboxSchemaFailure(fields.backend, "config", fields.config));
  if (fields.credentials !== undefined) {
    throwIfInvalid(
      sandboxSchemaFailure(fields.backend, "credentials", fields.credentials),
    );
  }
  throwIfInvalid(
    envCollisionFailure(
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

  return requireWritten(
    await updateOwned(
      db,
      "sandbox",
      { workspaceId },
      { ...fields, updatedAt: new Date() },
    ),
  );
}

const requireWritten = (row: SandboxRow | null): SandboxRow => {
  if (!row) throw new NotFoundError("Sandbox not found");
  return row;
};

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
