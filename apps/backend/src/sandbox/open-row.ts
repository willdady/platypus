import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  sandbox as sandboxTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { getSandboxBackend } from "./index.ts";
import type { SandboxBackend, SandboxContext } from "./types.ts";

type SandboxRow = typeof sandboxTable.$inferSelect;

// Builds the adapter for a sandbox row. Throws when the backend is not
// registered or the stored config/credentials fail its validation. `action`
// names what the caller was about to do, for the error message.
export const createSandboxBackend = (
  row: SandboxRow,
  action: string,
): SandboxBackend => {
  const registration = getSandboxBackend(row.backend);
  if (!registration) {
    throw new Error(
      `Sandbox backend '${row.backend}' is not registered; cannot ${action}`,
    );
  }

  const configResult = registration.configSchema.safeParse(row.config ?? {});
  if (!configResult.success) {
    throw new Error(
      `Sandbox config failed adapter validation: ${configResult.error.message}`,
    );
  }

  const credentialsResult = registration.credentialsSchema.safeParse(
    row.credentials ?? {},
  );
  if (!credentialsResult.success) {
    throw new Error(
      `Sandbox credentials failed adapter validation: ${credentialsResult.error.message}`,
    );
  }

  return registration.create(configResult.data, credentialsResult.data);
};

// The adapter for a sandbox row plus the workspace context its calls take.
// Throws as createSandboxBackend does, or when the Workspace row is missing.
export const openSandboxRow = async (
  row: SandboxRow,
  action: string,
): Promise<{ backend: SandboxBackend; ctx: SandboxContext }> => {
  const backend = createSandboxBackend(row, action);
  // The same (orgId, workspaceId, owner) context the tool calls get, so an
  // adapter keyed on it finds the resource it provisioned.
  const [owner] = await db
    .select({
      orgId: workspaceTable.organizationId,
      userId: workspaceTable.ownerId,
    })
    .from(workspaceTable)
    .where(eq(workspaceTable.id, row.workspaceId))
    .limit(1);
  if (!owner) {
    throw new Error(
      `Workspace '${row.workspaceId}' not found; cannot ${action} its sandbox`,
    );
  }

  return { backend, ctx: { ...owner, workspaceId: row.workspaceId } };
};
