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

/** The Organization and Workspace a Trigger's run Chats are stored under. */
export type TriggerRunScope = { orgId: string; workspaceId: string };

/**
 * Deletes the stored files under the Chat prefix of every Trigger run that has
 * just been deleted — by retention pruning or by deleting the Trigger, whose
 * runs cascade.
 *
 * A run's Chat is written under the run's own id (`runs/sinks/chat-sink.ts`),
 * so the deleted `trigger_run` rows name the prefixes. Rows first, then the
 * prefix, as {@link deleteStoredPrefix} requires: a failure leaves an
 * unreachable object rather than a row pointing at a missing file, and is
 * logged without failing the delete.
 */
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

/**
 * {@link deleteTriggerRunFiles} for a caller that knows only the Trigger's id.
 * Resolves the Trigger's Workspace scope first.
 *
 * The lookup is best-effort like the delete itself: retention has already
 * removed its rows, so a failed or empty lookup is logged and leaves the
 * objects behind rather than failing the retention pass that triggered it.
 */
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
