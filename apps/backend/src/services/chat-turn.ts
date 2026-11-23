import type { ChatSubmitData } from "@platypus/schemas";
import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  a2aEndpoint as a2aEndpointTable,
  chat as chatTable,
} from "../db/schema.ts";
import { ownedWhere } from "./workspace-resource.ts";
import { agentRunner } from "../runs/agent-runner.ts";
import { frontendBaseUrl } from "../base-urls.ts";
import { ChatSink, type ChatSinkParams } from "../runs/sinks/chat-sink.ts";
import type { RunInput } from "../runs/types.ts";
import { chatTimeouts } from "../runs/chat-timeouts.ts";
import { actorUserId, type WorkspaceScope } from "../scope.ts";
import {
  formatSummariesForSystemPrompt,
  resolveMemoryPin,
  retrieveRecentSummaries,
} from "./memory-retrieval.ts";
import { seedUserInvokedSkill } from "./slash-command.ts";
import { loadChatSummaries } from "./chat-summary.ts";
import { resolveTurn } from "./chat-messages.ts";
import { currentTurnId, isA2aChat } from "./a2a-task-state.ts";
import { endTurnIn, turnEnded } from "./a2a-task-lifecycle.ts";
import { chatRunIsLive } from "../runs/chat-run-heartbeat.ts";
import { withRunSource } from "../event-causation.ts";
import { refuseTriggerRunChat } from "./chat-write-guard.ts";

export const startChatTurn = async (params: {
  scope: WorkspaceScope;
  chatId: string;
  request: ChatSubmitData;
  includeMemories: boolean;
  origin: string;
  newChat?: Extract<ChatSinkParams["newChat"], { a2aEndpointId: string }>;
  onEnded?: () => void;
  onClaimed?: ChatSinkParams["onClaimed"];
}): Promise<Response> => {
  const {
    scope,
    chatId,
    request,
    includeMemories: callerIncludesMemories,
    origin,
    newChat,
    onEnded,
    onClaimed,
  } = params;

  // why: idleness is lastTurnAt; extraction and auto-titling bump updatedAt off-turn
  const existingChat = await db
    .select({
      memorySnapshot: chatTable.memorySnapshot,
      lastTurnAt: chatTable.lastTurnAt,
      status: chatTable.status,
      runHeartbeatAt: chatTable.runHeartbeatAt,
      updatedAt: chatTable.updatedAt,
      a2aEndpointId: chatTable.a2aEndpointId,
      activeLeafId: chatTable.activeLeafId,
      triggerRunId: chatTable.triggerRunId,
    })
    .from(chatTable)
    .where(ownedWhere("chat", { id: chatId, workspaceId: scope.workspaceId }))
    .limit(1);

  refuseTriggerRunChat(existingChat[0]);

  const turn = await resolveTurn({
    chatId,
    owned: existingChat.length > 0,
    activeLeafId: existingChat[0]?.activeLeafId,
    request,
  });

  if (isA2aChat(existingChat[0])) {
    await endDeadRun(chatId, existingChat[0]);
  }

  const includeMemories =
    callerIncludesMemories && (await chatAllowsMemories(existingChat[0]));

  const now = new Date();

  const resolveMemorySnapshot = async () => {
    const pin = resolveMemoryPin({
      existingSnapshot: existingChat[0]?.memorySnapshot,
      previousTurnAt: existingChat[0]?.lastTurnAt,
      now,
    });
    return pin.reuse
      ? pin.block
      : formatSummariesForSystemPrompt(
          await retrieveRecentSummaries(
            actorUserId(scope.principal),
            scope.workspaceId,
            now,
          ),
        );
  };
  const memorySnapshot = includeMemories
    ? await resolveMemorySnapshot()
    : undefined;

  // why: seeded into RunInput so the pair persists; model messages would re-seed every turn
  const messages = await seedUserInvokedSkill({
    messages: turn.messages,
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    agentId: request.agentId,
  });

  const chatSummaries = await loadChatSummaries(chatId);

  const turnId = turn.message?.id ?? turn.parentId ?? undefined;
  const input: RunInput = {
    runId: chatId,
    turnId,
    request,
    messages,
    chatSummaries,
    memorySnapshot,
    memoriesReferenceDate: now,
    includeMemories,
    memoryTools: includeMemories,
  };

  const a2a = isA2aChat(existingChat[0] ?? newChat);
  const sink = new ChatSink({
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    ownerId: actorUserId(scope.principal),
    message: turn.message,
    parentId: turn.parentId,
    answered: turn.answered,
    newChat,
    onClaimed,
    onEnding: a2a
      ? async (tx, status) => {
          if (turnId) await endTurnIn(tx, chatId, turnId, status);
        }
      : undefined,
    onEnded: (status) => {
      onEnded?.();
      if (a2a) {
        void turnEnded({ chatId, turnId, status });
      }
    },
  });

  return await withRunSource({ kind: "chat", chatId }, () =>
    agentRunner.stream({
      scope,
      input,
      sink,
      options: {
        origin,
        frontendUrl: frontendBaseUrl(),
        timeouts: chatTimeouts(),
      },
    }),
  );
};

const chatAllowsMemories = async (
  chat: { a2aEndpointId: string | null } | undefined,
): Promise<boolean> => {
  if (!chat?.a2aEndpointId) return true;
  const [endpoint] = await db
    .select({ includeMemories: a2aEndpointTable.includeMemories })
    .from(a2aEndpointTable)
    .where(eq(a2aEndpointTable.id, chat.a2aEndpointId))
    .limit(1);
  return endpoint?.includeMemories ?? false;
};

const endDeadRun = async (
  chatId: string,
  chat: Parameters<typeof chatRunIsLive>[0] | undefined,
): Promise<void> => {
  if (chat?.status !== "running" || chatRunIsLive(chat)) return;
  const turnId = await currentTurnId(chatId);
  if (!turnId) return;
  void turnEnded({ chatId, turnId, status: "failed" });
};
