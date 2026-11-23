import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import type { sandbox as sandboxTable } from "../db/schema.ts";
import { workspace as workspaceTable } from "../db/schema.ts";
import { getSandboxBackend } from "./index.ts";
import type { SandboxBackend, SandboxContext } from "./types.ts";

type SandboxRow = typeof sandboxTable.$inferSelect;

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

  const configResult = registration.configSchema.safeParse(row.config);
  if (!configResult.success) {
    throw new Error(
      `Sandbox config failed adapter validation: ${configResult.error.message}`,
    );
  }

  const credentialsResult = registration.credentialsSchema.safeParse(
    row.credentials,
  );
  if (!credentialsResult.success) {
    throw new Error(
      `Sandbox credentials failed adapter validation: ${credentialsResult.error.message}`,
    );
  }

  return registration.create(configResult.data, credentialsResult.data);
};

export const openSandboxRow = async (
  row: SandboxRow,
  action: string,
): Promise<{ backend: SandboxBackend; ctx: SandboxContext }> => {
  const backend = createSandboxBackend(row, action);
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
