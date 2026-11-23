import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  sandbox as sandboxTable,
  sandboxTeardownFailure as sandboxTeardownFailureTable,
} from "../db/schema.ts";
import { logger } from "../logger.ts";
import { getSandboxBackendPlugin } from "../plugins/registry.ts";
import { openSandboxRow } from "./open-row.ts";
import { errorMessage } from "../utils/error-message.ts";

type SandboxRow = typeof sandboxTable.$inferSelect;

export const destroySandboxRow = async (row: SandboxRow): Promise<void> => {
  const { backend, ctx } = await openSandboxRow(row, "destroy");
  await backend.destroy(ctx);
};

export const destroyWorkspaceSandboxes = async (
  workspaceId: string,
): Promise<void> => (await prepareWorkspaceSandboxTeardown(workspaceId))();

export const prepareWorkspaceSandboxTeardown = async (
  workspaceId: string,
): Promise<() => Promise<void>> => {
  const rows = await db
    .select()
    .from(sandboxTable)
    .where(eq(sandboxTable.workspaceId, workspaceId));
  const opened = await Promise.all(
    rows.map((row) =>
      openSandboxRow(row, "destroy").then(
        (open) => ({ row, open }),
        (error: unknown) => ({ row, error }),
      ),
    ),
  );

  return () => destroyOpened(workspaceId, opened);
};

const destroyOpened = async (
  workspaceId: string,
  opened: (
    | { row: SandboxRow; open: Awaited<ReturnType<typeof openSandboxRow>> }
    | { row: SandboxRow; error: unknown }
  )[],
): Promise<void> => {
  await Promise.all(
    opened.map(async (entry) => {
      const { row } = entry;
      try {
        if ("error" in entry) throw entry.error;
        await entry.open.backend.destroy(entry.open.ctx);
      } catch (err) {
        const message = errorMessage(err);
        const plugin = getSandboxBackendPlugin(row.backend) ?? null;
        logger.warn(
          { workspaceId, sandboxId: row.id, backend: row.backend, plugin, err },
          "Sandbox destroy() failed during workspace cascade; recording ledger entry",
        );
        try {
          await db.insert(sandboxTeardownFailureTable).values({
            id: nanoid(),
            workspaceId,
            backend: row.backend,
            config: row.config,
            error: message,
          });
        } catch (ledgerErr) {
          logger.error(
            {
              workspaceId,
              sandboxId: row.id,
              backend: row.backend,
              plugin,
              err: ledgerErr,
            },
            "Failed to record sandbox teardown failure",
          );
        }
      }
    }),
  );
};
