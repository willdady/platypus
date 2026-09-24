import { and, eq } from "drizzle-orm";
import { db } from "../../index.ts";
import { chat as chatTable, chatMessage } from "../../db/schema.ts";
import { logger } from "../../logger.ts";
import { generateChatMetadata } from "../../services/chat-metadata.ts";
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
  /** The user message this turn submits; absent on a regenerate. */
  message?: PlatypusUIMessage;
  /**
   * The row this turn hangs from: the submitted message's parent, or the
   * regenerated reply's parent.
   */
  parentId: string | null;
  /** Override the FlushScheduler interval. Defaults to 5 seconds. */
  flushIntervalMs?: number;
};

/**
 * Persists a Chat turn at run lifecycle boundaries, writing only the rows the
 * turn itself produced (ADR-0026) — never a row it continues from.
 *
 * - `onStart`: flip the Chat row to `status: "running"` (creating it for a new
 *   Chat), insert the submitted user message and point the leaf at the message
 *   being answered, so a disconnected client can read the in-progress state.
 * - `onProgress`: drive a FlushScheduler that periodically upserts the reply
 *   while keeping `status: "running"`.
 * - `onFinish`: write the terminal status (`succeeded`, `failed`,
 *   `cancelled`) and the final reply.
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
    memorySnapshot?: string;
  }): Promise<void> {
    this.runId = ctx.runId;
    this.latestMessages = ctx.messages;
    const { workspaceId, parentId } = this.params;
    const [message] = this.params.message
      ? await this.storeFiles([this.params.message])
      : [];

    // Not caught: a turn whose message cannot be stored must not run. The
    // runner fails the run and the request with it. The pinned Memories block
    // (ADR-0020) is written so a re-take on this turn survives for the next.
    await db.transaction(async (tx) => {
      const running = {
        status: "running",
        memorySnapshot: ctx.memorySnapshot ?? null,
        lastTurnAt: new Date(),
        updatedAt: new Date(),
      };
      const updated = await tx
        .update(chatTable)
        .set(running)
        .where(
          and(
            eq(chatTable.id, ctx.runId),
            eq(chatTable.workspaceId, workspaceId),
          ),
        )
        .returning({ id: chatTable.id });

      if (updated.length === 0) {
        // Fails on a Chat id another Workspace holds, before any message is
        // written into that Chat.
        await tx.insert(chatTable).values({
          id: ctx.runId,
          workspaceId,
          title: "Untitled",
          createdAt: new Date(),
          ...running,
        });
      }

      if (message) {
        await tx.insert(chatMessage).values({
          chatId: ctx.runId,
          id: message.id,
          parentId,
          role: "user",
          parts: message.parts,
        });
      }

      // The message being answered: the new one on a submit, the regenerated
      // reply's own on a regenerate. A reader arriving before the reply's first
      // write sees that message, not the reply being replaced, and the
      // hydration guard keeps a partial reply on screen over it.
      await tx
        .update(chatTable)
        .set({ activeLeafId: message?.id ?? parentId })
        .where(eq(chatTable.id, ctx.runId));
    });
  }

  // Synchronous work; returns a resolved promise to satisfy the async RunSink contract.
  onResolved(ctx: { runId: RunId; plan: ResolvedRunPlan }): Promise<void> {
    this.plan = ctx.plan;

    // Lazily create the FlushScheduler now that we have a plan to write.
    this.flusher = new FlushScheduler(async () => {
      await this.writeRow({
        status: "running",
        messages: this.latestMessages,
      });
    }, this.params.flushIntervalMs);
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

    // Fire-and-forget authoritative titling. Runs for every terminal status
    // (succeeded / failed / cancelled) so a chat is titled even when the first
    // run errored, was cancelled, or the client tab closed before the old
    // client-side path could fire. Deliberately not awaited: it must never
    // block or delay run completion, and any failure is caught and logged.
    this.generateMetadata();
  }

  /**
   * Kicks off title/tag generation for the just-finished run without awaiting
   * it. Resolves the titling provider from the run plan — for agent runs the
   * chat row's provider column is null, so the resolved plan's `providerId`
   * (the agent's own provider) is the authoritative source. Skips silently
   * when no plan resolved (nothing to title with).
   */
  private generateMetadata(): void {
    const providerId = this.plan?.resolved.providerId;
    if (!providerId) return;

    const { orgId, workspaceId } = this.params;
    void generateChatMetadata({
      chatId: this.runId,
      workspaceId,
      orgId,
      providerId,
    }).catch((error) => {
      logger.error(
        { error, chatId: this.runId, workspaceId },
        "Error generating chat metadata",
      );
    });
  }

  /** Stores inline file bytes and swaps them for storage references. */
  private storeFiles(
    messages: PlatypusUIMessage[],
  ): Promise<PlatypusUIMessage[]> {
    const { orgId, workspaceId } = this.params;
    return extractFiles(messages, { orgId, workspaceId, chatId: this.runId });
  }

  /**
   * Writes the Chat row with the resolved plan and the supplied status, and
   * upserts the turn's reply (after running it through `extractFiles`).
   *
   * The reply is the trailing message when it is an assistant's. What the
   * server loaded for the turn always ends in a user message — the one submitted, or the
   * regenerated reply's parent — so a trailing assistant message is this
   * turn's own: the streamed reply, or the seeded `loadSkill` message the SDK
   * continues under the same id. Before the first step that is all there is.
   */
  private async writeRow(args: {
    status: RunStatus;
    messages: PlatypusUIMessage[];
  }): Promise<void> {
    if (!this.plan) return;

    const { resolved } = this.plan;
    const { workspaceId } = this.params;
    const last = args.messages.at(-1);

    let reply: PlatypusUIMessage | undefined;
    try {
      [reply] = last?.role === "assistant" ? await this.storeFiles([last]) : [];
    } catch (error) {
      logger.error({ error, chatId: this.runId }, "Error extracting files");
      return;
    }

    const dbValues = {
      status: args.status,
      agentId: resolved.agentId ?? null,
      providerId: resolved.agentId ? null : resolved.providerId,
      modelId: resolved.agentId ? null : resolved.modelId,
      instructions: resolved.instructions ?? null,
      temperature: resolved.temperature ?? null,
      topP: resolved.topP ?? null,
      topK: resolved.topK ?? null,
      seed: resolved.seed ?? null,
      presencePenalty: resolved.presencePenalty ?? null,
      frequencyPenalty: resolved.frequencyPenalty ?? null,
      maxSteps: resolved.maxSteps ?? null,
      // Every write points the leaf at the reply, so the first one moves it
      // there. Nothing else moves it mid-run: a delete is refused while the
      // run is in flight.
      ...(reply ? { activeLeafId: reply.id } : {}),
      updatedAt: new Date(),
    };

    try {
      await db.transaction(async (tx) => {
        if (reply) {
          // Only the content: a reply deleted since the last write stays
          // deleted.
          const content = {
            parts: reply.parts,
            metadata: reply.metadata ?? null,
          };
          const updated = await tx
            .update(chatMessage)
            .set(content)
            .where(
              and(
                eq(chatMessage.chatId, this.runId),
                eq(chatMessage.id, reply.id),
              ),
            )
            .returning({ id: chatMessage.id });
          if (updated.length === 0) {
            await tx.insert(chatMessage).values({
              chatId: this.runId,
              id: reply.id,
              parentId: this.params.message?.id ?? this.params.parentId,
              role: "assistant",
              ...content,
            });
          }
        }

        await tx
          .update(chatTable)
          .set(dbValues)
          .where(
            and(
              eq(chatTable.id, this.runId),
              eq(chatTable.workspaceId, workspaceId),
            ),
          );
      });
    } catch (error) {
      logger.error(
        { error, chatId: this.runId, workspaceId },
        "Error upserting chat record",
      );
    }
  }
}
