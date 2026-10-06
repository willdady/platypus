import type { ChatSubmitData } from "@platypus/schemas";
import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  a2aEndpoint as a2aEndpointTable,
  chat as chatTable,
} from "../db/schema.ts";
import { ownedWhere } from "./workspace-resource.ts";
import { agentRunner } from "../runs/agent-runner.ts";
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
import { resolveTurn } from "./chat-messages.ts";
import { onA2aTurnEnded } from "./a2a-push.ts";
import { currentTurnId, isA2aChat, recordTaskEndIn } from "./a2a-task-state.ts";
import { chatRunIsLive } from "../runs/chat-run-heartbeat.ts";

/**
 * Starts one Chat turn and returns its streaming response — the one path every
 * caller that runs a turn in a Chat goes through (ADR-0032), whoever the
 * `scope`'s Principal is.
 *
 * `includeMemories` off skips the Memories pin and its retrieval altogether,
 * as a Trigger does (#645), rather than retrieving a block and throwing it
 * away, and withholds the Agent's Memory tools. The Chat then carries no pin,
 * so a later turn with Memories re-takes. An A2A Chat turns it off whatever
 * the caller asked when its endpoint has (see {@link chatAllowsMemories}).
 */
export const startChatTurn = async (params: {
  scope: WorkspaceScope;
  request: ChatSubmitData;
  includeMemories: boolean;
  origin: string;
  /** Columns a Chat this turn creates starts with (see `ChatSinkParams`). */
  newChat?: ChatSinkParams["newChat"];
  /** Called once the run's terminal status is written (see `ChatSinkParams`). */
  onEnded?: () => void;
  /** Writes the turn's own rows with its claim (see `ChatSinkParams`). */
  onClaimed?: ChatSinkParams["onClaimed"];
}): Promise<Response> => {
  const {
    scope,
    request,
    includeMemories: callerIncludesMemories,
    origin,
    newChat,
    onEnded,
    onClaimed,
  } = params;

  // ADR-0020: resolve the pinned Memories block OUTSIDE composition. This
  // service owns the chat row, so it does the arithmetic — compare the gap
  // since the previous turn against the re-pin horizon and re-take or reuse —
  // and the resolved block rides down through `RunInput` into
  // `prepareChatTurn`'s input. The renderer never learns about clocks.
  //
  // Idleness is measured against `lastTurnAt` — stamped only by the run sink
  // at turn boundaries — never `updatedAt`, which the memory-extraction job
  // and auto-titling bump at their own cadence and so cannot stand in for a
  // recent turn.
  const existingChat = await db
    .select({
      memorySnapshot: chatTable.memorySnapshot,
      lastTurnAt: chatTable.lastTurnAt,
      status: chatTable.status,
      runHeartbeatAt: chatTable.runHeartbeatAt,
      updatedAt: chatTable.updatedAt,
      a2aEndpointId: chatTable.a2aEndpointId,
      a2aClientName: chatTable.a2aClientName,
    })
    .from(chatTable)
    .where(
      ownedWhere("chat", { id: request.id, workspaceId: scope.workspaceId }),
    )
    .limit(1);

  // What the turn continues, from the server's own rows (ADR-0026). Refuses a
  // turn that cannot run — an unknown parent, a duplicate id, a reply that
  // cannot regenerate — before anything is retrieved or written.
  const turn = await resolveTurn({
    chatId: request.id,
    owned: existingChat.length > 0,
    request,
  });

  if (isA2aChat(existingChat[0])) {
    await endDeadRun(request.id, existingChat[0]);
  }

  const includeMemories =
    callerIncludesMemories && (await chatAllowsMemories(existingChat[0]));

  const now = new Date();

  // Reuse carries its own block, so there is no snapshot to assert about: the
  // Chat has not idled past the horizon and the prefix stays byte-identical
  // across its turns. Otherwise re-take — a fresh Chat, a row written before
  // this feature, or a Chat that has idled past the horizon (by which point
  // the cached prefix is provably expired, so the re-take is free). The
  // retrieval window is anchored to `now`, not a render-time clock read.
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

  // A user-invoked Skill (issue #649). The token stays in the text the user
  // sent; what is appended here is a trailing assistant message carrying the
  // `loadSkill` call and its result, so the body reaches the model as tool
  // content with correct provenance and never as words the user said.
  //
  // Seeded onto the messages that go into `RunInput` — the array that reaches
  // `originalMessages`, whose trailing assistant message the reply continues
  // and the sink persists. Seeding into the converted model messages instead
  // would reach the model and persist nothing, quietly turning "persist the
  // pair" into "re-seed every turn". A regenerate ends at the same user
  // message, so it is seeded again exactly as its submit was.
  const messages = await seedUserInvokedSkill({
    messages: turn.messages,
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    agentId: request.agentId,
  });

  const input: RunInput = {
    runId: request.id,
    request,
    messages,
    memorySnapshot,
    // The same moment the pin was resolved against, so a re-take and its
    // retrieval window agree on "now" rather than reading the clock twice.
    memoriesReferenceDate: now,
    includeMemories,
    memoryTools: includeMemories,
  };

  /** The user message this turn answers, naming its A2A Task. */
  const turnId = turn.message?.id ?? turn.parentId;
  /** Only an A2A Chat's turns can have a Task to record and push. */
  const a2a = isA2aChat(existingChat[0] ?? newChat);
  const sink = new ChatSink({
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    message: turn.message,
    parentId: turn.parentId,
    newChat,
    onClaimed,
    // Any turn in a Chat may be an A2A Task's, the Owner's own included: one
    // a client was refused for as busy and is following (ADR-0032). Its end
    // is recorded with the Chat's terminal status, and pushed once that has
    // committed; one the terminal write missed is recorded then.
    onEnding: a2a
      ? async (tx, status) => {
          if (turnId) await recordTaskEndIn(tx, request.id, turnId, status);
        }
      : undefined,
    onEnded: (status) => {
      onEnded?.();
      if (a2a) {
        void onA2aTurnEnded({ chatId: request.id, messageId: turnId, status });
      }
    },
  });

  // A rejected attachment (issue #328), an unresolved Agent/Provider/model,
  // or a missing Workspace throws before the sink persists anything, so the
  // chat is never bricked — the central `onError` (ADR-0010) maps the typed
  // error to its HTTP status.
  return await agentRunner.stream({
    scope,
    input,
    sink,
    options: {
      // No request signal is taken: chat runs continue server-side
      // regardless of the client connection, and are cancelled by run id.
      origin,
      frontendUrl: process.env.FRONTEND_URL,
      timeouts: chatTimeouts(),
    },
  });
};

/**
 * Whether a Chat lets its turns read the Owner's Memories. An A2A Chat follows
 * its endpoint's Include Memories, whoever's turn it is: the Owner's reply sits
 * in the history the client reads next (ADR-0032). One whose endpoint is gone,
 * or that predates the endpoint being stored on it, is known by its client
 * label and reads as off. Any other Chat, and one not written yet, allows them.
 */
const chatAllowsMemories = async (
  chat:
    { a2aEndpointId: string | null; a2aClientName: string | null } | undefined,
): Promise<boolean> => {
  if (!chat?.a2aEndpointId && !chat?.a2aClientName) return true;
  if (!chat.a2aEndpointId) return false;
  const [endpoint] = await db
    .select({ includeMemories: a2aEndpointTable.includeMemories })
    .from(a2aEndpointTable)
    .where(eq(a2aEndpointTable.id, chat.a2aEndpointId))
    .limit(1);
  return endpoint?.includeMemories ?? false;
};

/**
 * Ends the turn a dead run left a Chat `running` on (#1297), as the recovery
 * sweep would have, had it reached the Chat first: this turn's claim is about
 * to take the Chat from it, and nothing else will record its end. Its turn is
 * read now, before the claim moves the leaf onto this turn's message; the end
 * is recorded and pushed in the background.
 */
const endDeadRun = async (
  chatId: string,
  chat: Parameters<typeof chatRunIsLive>[0] | undefined,
): Promise<void> => {
  if (chat?.status !== "running" || chatRunIsLive(chat)) return;
  const turnId = await currentTurnId(chatId);
  if (!turnId) return;
  void onA2aTurnEnded({ chatId, messageId: turnId, status: "failed" });
};
