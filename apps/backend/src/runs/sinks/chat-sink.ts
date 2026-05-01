import { and, eq } from "drizzle-orm";
import { db } from "../../index.ts";
import { chat as chatTable } from "../../db/schema.ts";
import { logger } from "../../logger.ts";
import { extractFiles } from "../../storage/utils.ts";
import type { PlatypusUIMessage } from "../../types.ts";
import type {
  ResolvedRunPlan,
  RunId,
  RunSink,
  RunStats,
  RunStatus,
} from "../types.ts";

export type ChatSinkParams = {
  orgId: string;
  workspaceId: string;
};

/**
 * Persists a chat row at run lifecycle boundaries.
 *
 * `prepareChatTurn` already handles the "agent vs direct" nulling on
 * `resolved`, so this sink just maps `resolved` fields to chat-table
 * columns. PR #3 will introduce per-step writes via `onProgress`; today
 * the row is upserted only at finish.
 */
export class ChatSink implements RunSink {
  private plan?: ResolvedRunPlan;

  constructor(private readonly params: ChatSinkParams) {}

  async onStart(_: { runId: RunId }): Promise<void> {
    // No-op: chat row is upserted on finish.
  }

  async onResolved(ctx: {
    runId: RunId;
    plan: ResolvedRunPlan;
  }): Promise<void> {
    this.plan = ctx.plan;
  }

  async onProgress(_: {
    runId: RunId;
    messages: PlatypusUIMessage[];
    stats: RunStats;
  }): Promise<void> {
    // No-op for now. Periodic flushes land in PR #3.
  }

  async onFinish(ctx: {
    runId: RunId;
    status: RunStatus;
    messages: PlatypusUIMessage[];
    stats: RunStats;
    error?: Error;
  }): Promise<void> {
    if (!this.plan) {
      logger.error(
        { runId: ctx.runId },
        "ChatSink.onFinish called without a plan; skipping upsert",
      );
      return;
    }

    const { resolved } = this.plan;
    const { orgId, workspaceId } = this.params;

    let processedMessages: PlatypusUIMessage[];
    try {
      processedMessages = await extractFiles(ctx.messages, {
        orgId,
        workspaceId,
        chatId: ctx.runId,
      });
    } catch (error) {
      logger.error({ error, chatId: ctx.runId }, "Error extracting files");
      return;
    }

    const dbValues = {
      messages: processedMessages,
      agentId: resolved.agentId ?? null,
      providerId: resolved.agentId ? null : resolved.providerId,
      modelId: resolved.agentId ? null : resolved.modelId,
      systemPrompt: resolved.systemPrompt ?? null,
      temperature: resolved.temperature ?? null,
      topP: resolved.topP ?? null,
      topK: resolved.topK ?? null,
      seed: resolved.seed ?? null,
      presencePenalty: resolved.presencePenalty ?? null,
      frequencyPenalty: resolved.frequencyPenalty ?? null,
      updatedAt: new Date(),
    };

    try {
      const updateResult = await db
        .update(chatTable)
        .set(dbValues)
        .where(
          and(
            eq(chatTable.id, ctx.runId),
            eq(chatTable.workspaceId, workspaceId),
          ),
        )
        .returning();

      if (updateResult.length === 0) {
        await db.insert(chatTable).values({
          id: ctx.runId,
          workspaceId,
          title: "Untitled",
          createdAt: new Date(),
          ...dbValues,
        });
      }

      logger.info(
        `Successfully upserted chat '${ctx.runId}' in workspace '${workspaceId}'`,
      );
    } catch (error) {
      logger.error(
        { error, chatId: ctx.runId, workspaceId },
        "Error upserting chat record",
      );
    }
  }
}
