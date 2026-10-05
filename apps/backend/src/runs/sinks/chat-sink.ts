import { and, eq, ne } from "drizzle-orm";
import { db } from "../../index.ts";
import { chat as chatTable, chatMessage } from "../../db/schema.ts";
import { ConflictError, isUniqueViolation } from "../../errors.ts";
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

/** Why a Chat refuses a turn, a delete or a leaf switch while a run holds it. */
export const CHAT_BUSY_MESSAGE = "A reply is still being written in this Chat";

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
  /**
   * Columns a Chat this turn creates starts with, beside the defaults: an A2A
   * Chat is bound to its endpoint, its Agent and its token from its first row
   * (ADR-0032). Ignored when the Chat already exists.
   */
  newChat?: {
    agentId: string;
    a2aTokenId: string;
    a2aClientName: string;
    a2aEndpointId: string;
  };
  /**
   * Called once the run's terminal status is written, with that status. Not
   * awaited by the run: it must not delay or fail it.
   */
  onEnded?: (status: RunStatus) => void;
  /** Override the FlushScheduler interval. Defaults to 5 seconds. */
  flushIntervalMs?: number;
};

/**
 * Persists a Chat turn at run lifecycle boundaries, writing only the rows the
 * turn itself produced (ADR-0026) — never a row it continues from.
 *
 * - `onStart`: claim the Chat by flipping its row to `status: "running"`
 *   (creating it for a new Chat), insert the submitted user message and point
 *   the leaf at the message being answered, so a disconnected client can read
 *   the in-progress state. The claim is the one-run-per-Chat lock across every
 *   backend instance (#1237): a Chat already `running` is a `ConflictError`.
 * - `onProgress`: drive a FlushScheduler that periodically upserts the reply
 *   while keeping `status: "running"`.
 * - `onFinish`: write the terminal status (`succeeded`, `failed`,
 *   `cancelled`) and the final reply. A regenerate that wrote no reply puts
 *   back the leaf `onStart` moved, so the reply it meant to replace is not left
 *   off the Active path.
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
  /** The message the reply answers: the submitted one, or the reply's parent. */
  private readonly answeredId: string | null;
  /** On a regenerate, the leaf before `onStart` moved it to `answeredId`. */
  private leafBefore?: string | null;
  private replyWritten = false;
  /** Whether `onStart` claimed the Chat. A sink that lost the claim writes
   *  nothing, since the row belongs to the run that holds it. */
  private claimed = false;

  constructor(params: ChatSinkParams) {
    this.params = params;
    this.answeredId = params.message?.id ?? params.parentId;
  }

  async onStart(ctx: {
    runId: RunId;
    messages: PlatypusUIMessage[];
    memorySnapshot?: string;
  }): Promise<void> {
    this.runId = ctx.runId;
    this.latestMessages = ctx.messages;
    const { workspaceId, parentId } = this.params;
    const message =
      this.params.message && (await this.storeFiles(this.params.message));

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
      // The claim. Conditional, so of two instances racing for one Chat the
      // second waits on the first's row lock and then matches nothing.
      const updated = await tx
        .update(chatTable)
        .set(running)
        .where(
          and(
            eq(chatTable.id, ctx.runId),
            eq(chatTable.workspaceId, workspaceId),
            ne(chatTable.status, "running"),
          ),
        )
        .returning({
          id: chatTable.id,
          activeLeafId: chatTable.activeLeafId,
        });
      if (!message) this.leafBefore = updated[0]?.activeLeafId;

      if (updated.length === 0) {
        // A new Chat, unless the id is taken: a Chat already running, or one
        // another Workspace holds. Either way the claim fails before any
        // message is written into it.
        try {
          await tx.insert(chatTable).values({
            id: ctx.runId,
            workspaceId,
            title: "Untitled",
            createdAt: new Date(),
            ...this.params.newChat,
            ...running,
          });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          throw new ConflictError(CHAT_BUSY_MESSAGE);
        }
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
        .set({ activeLeafId: this.answeredId })
        .where(eq(chatTable.id, ctx.runId));
    });
    this.claimed = true;
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
    if (!this.claimed) return;
    await this.flusher?.dispose();
    this.flusher = undefined;

    let status = ctx.status;
    if (!this.plan) {
      // Resolution failed before we had any plan to persist; just update
      // the status on the row that onStart inserted.
      await this.writeStatus(ctx.status);
    } else {
      this.latestMessages = ctx.messages;
      const written = await this.writeRow({
        status: ctx.status,
        messages: ctx.messages,
      });
      // A reply that could not be stored must not leave the Chat `running`.
      if (!written) {
        status = "failed";
        await this.writeStatus(status);
      }

      // Fire-and-forget authoritative titling. Runs for every terminal status
      // (succeeded / failed / cancelled) so a chat is titled even when the
      // first run errored, was cancelled, or the client tab closed before the
      // old client-side path could fire. Deliberately not awaited: it must
      // never block or delay run completion, and any failure is caught and
      // logged.
      this.generateMetadata();
    }

    await this.restoreLeaf();
    this.params.onEnded?.(status);
  }

  /** Writes only the Chat row's status. */
  private async writeStatus(status: RunStatus): Promise<void> {
    try {
      await db
        .update(chatTable)
        .set({ status, updatedAt: new Date() })
        .where(
          and(
            eq(chatTable.id, this.runId),
            eq(chatTable.workspaceId, this.params.workspaceId),
          ),
        );
    } catch (error) {
      logger.error(
        { error, chatId: this.runId },
        "Error writing terminal status",
      );
    }
  }

  /**
   * Puts back the leaf a regenerate moved in `onStart`, when the turn ended
   * without writing a reply: a resolution that failed, or a run stopped before
   * its first chunk. Left at the reply's parent, the reply it meant to replace
   * would be off the Active path with no arrows leading back to it.
   */
  private async restoreLeaf(): Promise<void> {
    if (this.replyWritten || !this.leafBefore) return;
    try {
      await db
        .update(chatTable)
        .set({ activeLeafId: this.leafBefore })
        .where(
          and(
            eq(chatTable.id, this.runId),
            eq(chatTable.workspaceId, this.params.workspaceId),
          ),
        );
    } catch (error) {
      logger.error(
        { error, chatId: this.runId },
        "Error restoring the leaf after a regenerate wrote no reply",
      );
    }
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

  /** Stores a message's inline file bytes and swaps them for storage references. */
  private async storeFiles(
    message: PlatypusUIMessage,
  ): Promise<PlatypusUIMessage> {
    const { orgId, workspaceId } = this.params;
    const [stored] = await extractFiles([message], {
      orgId,
      workspaceId,
      chatId: this.runId,
    });
    return stored;
  }

  /**
   * Writes the Chat row with the resolved plan and the supplied status, and
   * upserts the turn's reply (after running it through `extractFiles`).
   * Resolves `false`, having written nothing, when either step fails.
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
  }): Promise<boolean> {
    if (!this.plan) return false;

    const { resolved } = this.plan;
    const { workspaceId } = this.params;
    const last = args.messages.at(-1);

    let reply: PlatypusUIMessage | undefined;
    try {
      reply =
        last?.role === "assistant" ? await this.storeFiles(last) : undefined;
    } catch (error) {
      logger.error({ error, chatId: this.runId }, "Error extracting files");
      return false;
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
              parentId: this.answeredId,
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
      if (reply) this.replyWritten = true;
      return true;
    } catch (error) {
      logger.error(
        { error, chatId: this.runId, workspaceId },
        "Error upserting chat record",
      );
      return false;
    }
  }
}
