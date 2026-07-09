import { and, eq } from "drizzle-orm";
import { db } from "../../index.ts";
import { chat as chatTable } from "../../db/schema.ts";
import { logger } from "../../logger.ts";
import { extractFiles } from "../../storage/utils.ts";
import type { PlatypusUIMessage } from "../../types.ts";
import { FlushScheduler } from "../flush-scheduler.ts";
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
  /** Override the FlushScheduler interval. Defaults to 5 seconds. */
  flushIntervalMs?: number;
};

/** Default cadence for periodic ChatSink flushes during a running run. */
export const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

/**
 * Persists a chat row at run lifecycle boundaries.
 *
 * - `onStart`: upsert the row with `status: "running"` so disconnected
 *   clients can read the in-progress state.
 * - `onProgress`: drive a FlushScheduler that periodically writes the
 *   latest messages while keeping `status: "running"`.
 * - `onFinish`: write the terminal status (`succeeded`, `failed`,
 *   `cancelled`) and the final messages.
 *
 * The sink intentionally only persists what `prepareChatTurn` resolved
 * (agent vs direct provider/model nulling already done) — it does not
 * inspect the agent table itself.
 */
export class ChatSink implements RunSink {
  private plan?: ResolvedRunPlan;
  private latestMessages: PlatypusUIMessage[] = [];
  private flusher?: FlushScheduler;
  private runId = "";
  private readonly params: ChatSinkParams;

  constructor(params: ChatSinkParams) {
    this.params = params;
  }

  async onStart(ctx: {
    runId: RunId;
    messages: PlatypusUIMessage[];
  }): Promise<void> {
    this.runId = ctx.runId;
    this.latestMessages = ctx.messages;
    const { workspaceId } = this.params;
    // Upsert with the input messages so a reconnecting client can see
    // the user's question immediately, before the model produces its
    // first step. Existing rows (follow-up turns) get their messages
    // overwritten with the fuller history the client just sent.
    try {
      const updated = await db
        .update(chatTable)
        .set({
          status: "running",
          messages: ctx.messages,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatTable.id, ctx.runId),
            eq(chatTable.workspaceId, workspaceId),
          ),
        )
        .returning();

      if (updated.length === 0) {
        await db.insert(chatTable).values({
          id: ctx.runId,
          workspaceId,
          title: "Untitled",
          status: "running",
          messages: ctx.messages,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    } catch (error) {
      logger.error(
        { error, chatId: ctx.runId, workspaceId },
        "Error upserting chat row in onStart",
      );
    }
  }

  // Synchronous work; returns a resolved promise to satisfy the async RunSink contract.
  onResolved(ctx: { runId: RunId; plan: ResolvedRunPlan }): Promise<void> {
    this.plan = ctx.plan;

    // Lazily create the FlushScheduler now that we have a plan to write.
    const intervalMs = this.params.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.flusher = new FlushScheduler(intervalMs, async () => {
      await this.writeRow({
        status: "running",
        messages: this.latestMessages,
      });
    });
    return Promise.resolve();
  }

  // Synchronous work; returns a resolved promise to satisfy the async RunSink contract.
  onProgress(ctx: {
    runId: RunId;
    messages: PlatypusUIMessage[];
    stats: RunStats;
  }): Promise<void> {
    this.latestMessages = ctx.messages;
    this.flusher?.bump();
    return Promise.resolve();
  }

  async onFinish(ctx: {
    runId: RunId;
    status: RunStatus;
    messages: PlatypusUIMessage[];
    stats: RunStats;
    error?: Error;
  }): Promise<void> {
    await this.flusher?.dispose();
    this.flusher = undefined;

    if (!this.plan) {
      // Resolution failed before we had any plan to persist; just update
      // the status on the row that onStart inserted.
      try {
        await db
          .update(chatTable)
          .set({ status: ctx.status, updatedAt: new Date() })
          .where(
            and(
              eq(chatTable.id, ctx.runId),
              eq(chatTable.workspaceId, this.params.workspaceId),
            ),
          );
      } catch (error) {
        logger.error(
          { error, chatId: ctx.runId },
          "Error writing terminal status without plan",
        );
      }
      return;
    }

    this.latestMessages = ctx.messages;
    await this.writeRow({ status: ctx.status, messages: ctx.messages });
  }

  /**
   * Writes the chat row with the resolved plan, the supplied status, and
   * the supplied messages (after running them through `extractFiles`).
   * Falls back to insert when update affects zero rows.
   */
  private async writeRow(args: {
    status: RunStatus;
    messages: PlatypusUIMessage[];
  }): Promise<void> {
    if (!this.plan) return;

    const { resolved } = this.plan;
    const { orgId, workspaceId } = this.params;

    let processedMessages: PlatypusUIMessage[];
    try {
      processedMessages = await extractFiles(args.messages, {
        orgId,
        workspaceId,
        chatId: this.runId,
      });
    } catch (error) {
      logger.error({ error, chatId: this.runId }, "Error extracting files");
      return;
    }

    const dbValues = {
      messages: processedMessages,
      status: args.status,
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
            eq(chatTable.id, this.runId),
            eq(chatTable.workspaceId, workspaceId),
          ),
        )
        .returning();

      if (updateResult.length === 0) {
        await db.insert(chatTable).values({
          id: this.runId,
          workspaceId,
          title: "Untitled",
          createdAt: new Date(),
          ...dbValues,
        });
      }
    } catch (error) {
      logger.error(
        { error, chatId: this.runId, workspaceId },
        "Error upserting chat record",
      );
    }
  }
}
