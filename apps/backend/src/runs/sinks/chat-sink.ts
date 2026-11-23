import { and, eq, ne, or } from "drizzle-orm";
import { db, type Tx } from "../../index.ts";
import {
  chat as chatTable,
  chatMessage,
  workspace as workspaceTable,
} from "../../db/schema.ts";
import { ConflictError, isUniqueViolation } from "../../errors.ts";
import { logger } from "../../logger.ts";
import {
  generateChatMetadata,
  startEarlyChatTitle,
} from "../../services/chat-metadata.ts";
import { stillAwaits } from "../../services/chat-messages.ts";
import { afterTurn } from "../../services/chat-summary.ts";
import { extractFiles } from "../../storage/utils.ts";
import { storable } from "../../utils/storable.ts";
import type { PlatypusUIMessage } from "../../types.ts";
import { FlushScheduler } from "../flush-scheduler.ts";
import {
  chatRunStale,
  RUN_HEARTBEAT_INTERVAL_MS,
  runHeartbeatCutoff,
} from "../chat-run-heartbeat.ts";
import type {
  ResolvedRunPlan,
  RunId,
  RunSink,
  RunStats,
  RunStatus,
} from "../types.ts";

export const CHAT_BUSY_MESSAGE = "A reply is still being written in this Chat";

export type ChatSinkParams = {
  orgId: string;
  workspaceId: string;
  ownerId: string;
  message?: PlatypusUIMessage;
  parentId: string | null;
  answered?: PlatypusUIMessage[];
  newChat?:
    | {
        agentId: string;
        a2aTokenId: string;
        a2aClientName: string;
        a2aEndpointId: string;
      }
    | {
        agentId: string;
        triggerRunId: string;
        title: string;
      };
  onEnded?: (status: RunStatus) => void;
  onEnding?: (tx: Tx, status: RunStatus) => Promise<unknown>;
  onClaimed?: (tx: Tx) => Promise<void>;
  flushIntervalMs?: number;
};

export class ChatSink implements RunSink {
  private plan?: ResolvedRunPlan;
  private latestMessages: PlatypusUIMessage[] = [];
  private flusher?: FlushScheduler;
  private runId = "";
  private readonly params: ChatSinkParams;
  private readonly answeredId: string | null;
  private leafBefore?: string | null;
  private replyWritten = false;
  private claimed = false;
  private earlyTitle?: Promise<void>;
  private heartbeat?: ReturnType<typeof setInterval>;

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

    await db.transaction(async (tx) => {
      // why: a Workspace transfer waits on this lock, so a turn is cancelled by it or sees the new Owner
      const [owned] = await tx
        .select({ id: workspaceTable.id })
        .from(workspaceTable)
        .where(
          and(
            eq(workspaceTable.id, workspaceId),
            eq(workspaceTable.ownerId, this.params.ownerId),
          ),
        )
        .for("share");
      if (!owned) {
        throw new ConflictError("This Workspace has been transferred");
      }
      const now = new Date();
      const running = {
        status: "running" as const,
        memorySnapshot: ctx.memorySnapshot ?? null,
        lastTurnAt: now,
        runHeartbeatAt: now,
        updatedAt: now,
      };
      const updated = await tx
        .update(chatTable)
        .set(running)
        .where(
          and(
            eq(chatTable.id, ctx.runId),
            eq(chatTable.workspaceId, workspaceId),
            or(
              ne(chatTable.status, "running"),
              chatRunStale(runHeartbeatCutoff(now.getTime())),
            ),
          ),
        )
        .returning({
          id: chatTable.id,
          activeLeafId: chatTable.activeLeafId,
        });
      if (!message) this.leafBefore = updated[0]?.activeLeafId;

      if (updated.length === 0) {
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
          parts: storable(message.parts),
        });
      }

      for (const answered of this.params.answered ?? []) {
        const [stored] = await tx
          .select({ parts: chatMessage.parts })
          .from(chatMessage)
          .where(
            and(
              eq(chatMessage.chatId, ctx.runId),
              eq(chatMessage.id, answered.id),
            ),
          );
        if (!stored || !stillAwaits(stored.parts, answered)) {
          if (answered.id === this.answeredId) {
            throw new ConflictError(
              "This reply's approvals have already been answered",
            );
          }
          continue;
        }
        await tx
          .update(chatMessage)
          .set({ parts: storable(answered.parts) })
          .where(
            and(
              eq(chatMessage.chatId, ctx.runId),
              eq(chatMessage.id, answered.id),
            ),
          );
      }

      await tx
        .update(chatTable)
        .set({ activeLeafId: this.answeredId })
        .where(eq(chatTable.id, ctx.runId));

      await this.params.onClaimed?.(tx);
    });
    this.claimed = true;
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(
      () => void this.beat(),
      RUN_HEARTBEAT_INTERVAL_MS,
    );
    this.heartbeat.unref();
  }

  private async beat(): Promise<void> {
    try {
      await db
        .update(chatTable)
        .set({ runHeartbeatAt: new Date() })
        .where(
          and(
            eq(chatTable.id, this.runId),
            eq(chatTable.workspaceId, this.params.workspaceId),
            eq(chatTable.status, "running"),
          ),
        );
    } catch (error) {
      logger.error(
        { error, chatId: this.runId },
        "Error writing the run heartbeat",
      );
    }
  }

  onResolved(ctx: { runId: RunId; plan: ResolvedRunPlan }): Promise<void> {
    this.plan = ctx.plan;

    this.flusher = new FlushScheduler(async () => {
      await this.writeRow({
        status: "running",
        messages: this.latestMessages,
      });
    }, this.params.flushIntervalMs);

    this.earlyTitle = this.startEarlyTitle();
    return Promise.resolve();
  }

  onProgress(ctx: {
    runId: RunId;
    messages: PlatypusUIMessage[];
    stats: RunStats;
  }): Promise<void> {
    this.latestMessages = ctx.messages;
    this.flusher?.bump();
    return Promise.resolve();
  }

  async onOutput(ctx: {
    runId: RunId;
    messages: PlatypusUIMessage[];
  }): Promise<void> {
    this.latestMessages = ctx.messages;
    await this.flusher?.flush();
  }

  async onFinish(ctx: {
    runId: RunId;
    status: RunStatus;
    messages: PlatypusUIMessage[];
    stats: RunStats;
    error?: Error;
  }): Promise<void> {
    if (!this.claimed) return;
    clearInterval(this.heartbeat);
    await this.flusher?.dispose();
    this.flusher = undefined;

    let status = ctx.status;
    let written = false;
    if (this.plan) {
      this.latestMessages = ctx.messages;
      written = await this.writeRow({
        status: ctx.status,
        messages: ctx.messages,
        ending: true,
      });
      if (!written) status = "failed";

      if (!this.keepsTriggerRun) {
        this.generateMetadata();

        if (written) this.scheduleTranscriptSummary();
      }
    }
    if (!written) await this.writeStatus(status);

    this.params.onEnded?.(status);
  }

  private get keepsTriggerRun(): boolean {
    return !!this.params.newChat && "triggerRunId" in this.params.newChat;
  }

  private async writeStatus(status: RunStatus): Promise<void> {
    const write = async (tx: Tx, recordEnd: boolean) => {
      await tx
        .update(chatTable)
        .set({ status, ...this.restoredLeaf(), updatedAt: new Date() })
        .where(
          and(
            eq(chatTable.id, this.runId),
            eq(chatTable.workspaceId, this.params.workspaceId),
          ),
        );
      if (recordEnd) await this.params.onEnding?.(tx, status);
    };
    try {
      await db.transaction((tx) => write(tx, true));
      return;
    } catch (error) {
      logger.error(
        { error, chatId: this.runId },
        "Error writing terminal status",
      );
    }
    if (!this.params.onEnding) return;
    try {
      await db.transaction((tx) => write(tx, false));
    } catch (error) {
      logger.error(
        { error, chatId: this.runId },
        "Error writing terminal status",
      );
    }
  }

  private restoredLeaf(): { activeLeafId?: string } {
    return this.replyWritten || !this.leafBefore
      ? {}
      : { activeLeafId: this.leafBefore };
  }

  private generateMetadata(): void {
    const providerId = this.plan?.resolved.providerId;
    if (!providerId) return;

    const { orgId, workspaceId } = this.params;
    void (async () => {
      await this.earlyTitle;
      await generateChatMetadata({
        chatId: this.runId,
        workspaceId,
        orgId,
        providerId,
      });
    })().catch((error) => {
      logger.error(
        { error, chatId: this.runId, workspaceId },
        "Error generating chat metadata",
      );
    });
  }

  private startEarlyTitle(): Promise<void> | undefined {
    if (this.keepsTriggerRun) return undefined;
    const plan = this.plan;
    if (!plan) return undefined;

    const { orgId, workspaceId } = this.params;
    return startEarlyChatTitle({
      chatId: this.runId,
      workspaceId,
      orgId,
      providerId: plan.resolved.providerId,
      modelId: plan.resolvedModelId,
    }).catch((error) => {
      logger.error(
        { error, chatId: this.runId, workspaceId },
        "Error starting early chat title",
      );
    });
  }

  private scheduleTranscriptSummary(): void {
    const plan = this.plan;
    if (!plan) return;
    const { resolved } = plan;
    afterTurn({
      chatId: this.runId,
      orgId: this.params.orgId,
      workspaceId: this.params.workspaceId,
      path: this.latestMessages,
      contextWindow: plan.contextWindow,
      source:
        resolved.agentId !== undefined
          ? { agentId: resolved.agentId }
          : { providerId: resolved.providerId, modelId: resolved.modelId },
      readOnlyToolNames: plan.readOnlyToolNames,
    });
  }

  private async storeFiles(
    message: PlatypusUIMessage,
  ): Promise<PlatypusUIMessage> {
    const { orgId, workspaceId } = this.params;
    const [stored] = await extractFiles([message], {
      orgId,
      workspaceId,
      chatId: this.runId,
    });
    if (!stored) throw new Error("extractFiles returned no message");
    return stored;
  }

  private async writeRow(args: {
    status: RunStatus;
    messages: PlatypusUIMessage[];
    ending?: boolean;
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
      reasoningThinking: resolved.reasoningThinking ?? null,
      reasoningEffort: resolved.reasoningEffort ?? null,
      thinkingBudget: resolved.thinkingBudget ?? null,
      maxSteps: resolved.maxSteps ?? null,
      ...(reply
        ? { activeLeafId: reply.id }
        : args.ending
          ? this.restoredLeaf()
          : {}),
      updatedAt: new Date(),
    };

    try {
      await db.transaction(async (tx) => {
        if (reply) {
          const content = storable({
            parts: reply.parts,
            metadata: reply.metadata ?? null,
          });
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

        if (args.ending) await this.params.onEnding?.(tx, args.status);
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
