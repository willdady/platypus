import type { ChatSubmitData } from "@platypus/schemas";
import { db } from "../index.ts";
import { chat as chatTable } from "../db/schema.ts";
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
import { endA2aTurn } from "./a2a-push.ts";

/**
 * Starts one Chat turn and returns its streaming response — the one path every
 * caller that runs a turn in a Chat goes through (ADR-0032), whoever the
 * `scope`'s Principal is.
 *
 * `includeMemories` off skips the Memories pin and its retrieval altogether,
 * as a Trigger does (#645), rather than retrieving a block and throwing it
 * away. The Chat then carries no pin, so a later turn with Memories re-takes.
 */
export const startChatTurn = async (params: {
  scope: WorkspaceScope;
  request: ChatSubmitData;
  includeMemories: boolean;
  origin: string;
  /** Columns a Chat this turn creates starts with (see `ChatSinkParams`). */
  newChat?: ChatSinkParams["newChat"];
}): Promise<Response> => {
  const { scope, request, includeMemories, origin, newChat } = params;

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
  };

  const sink = new ChatSink({
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    message: turn.message,
    parentId: turn.parentId,
    newChat,
    // Any turn in a Chat may be an A2A Task's, the Owner's own included: one
    // a client was refused for as busy and is following (ADR-0032).
    onEnded: (status) =>
      void endA2aTurn({
        chatId: request.id,
        messageId: turn.message?.id ?? turn.parentId,
        status,
      }),
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
