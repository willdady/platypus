import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  trigger as triggerTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { logger } from "../logger.ts";
import { errorMessage } from "../utils/error-message.ts";
import { chatStorageKeyPrefix } from "../storage/keys.ts";
import { deleteStoredPrefix } from "../storage/utils.ts";

export type TriggerRunScope = { orgId: string; workspaceId: string };

export const deleteTriggerRunFiles = async (
  scope: TriggerRunScope,
  runIds: readonly string[],
): Promise<void> => {
  await Promise.all(
    runIds.map((chatId) =>
      deleteStoredPrefix(
        chatStorageKeyPrefix({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          chatId,
        }),
      ),
    ),
  );
};

export const deleteTriggerRunFilesForTrigger = async (
  triggerId: string,
  runIds: readonly string[],
): Promise<void> => {
  if (runIds.length === 0) return;

  try {
    const [scope] = await db
      .select({
        orgId: workspaceTable.organizationId,
        workspaceId: triggerTable.workspaceId,
      })
      .from(triggerTable)
      .innerJoin(
        workspaceTable,
        eq(workspaceTable.id, triggerTable.workspaceId),
      )
      .where(eq(triggerTable.id, triggerId))
      .limit(1);

    if (scope) await deleteTriggerRunFiles(scope, runIds);
  } catch (error) {
    logger.error(
      { triggerId, error: errorMessage(error) },
      "Failed to resolve a Trigger's scope for run file deletion",
    );
  }
};
