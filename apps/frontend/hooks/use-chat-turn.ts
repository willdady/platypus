import { useCallback, useMemo } from "react";
import type { UIMessage } from "ai";
import { toast } from "sonner";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import type { ChatSettings } from "@/hooks/use-chat-settings";
import type { ModelSelection } from "@/hooks/use-model-selection";
import { writeAt, scopedPath, type Scope } from "@/lib/api-write";
import { turnRequest } from "@/lib/chat-turn";
import { ATTACHMENTS_ONLY_TEXT } from "@/lib/message-parts";
import { joinUrl } from "@/lib/utils";

type TurnOptions = { body: Record<string, unknown> };

/** An attachment-only message is a real turn: the question was the file. */
const outgoing = (message: PromptInputMessage): PromptInputMessage => ({
  text: message.text || ATTACHMENTS_ONLY_TEXT,
  files: message.files,
});

export interface UseChatTurnInput<T extends UIMessage> {
  selection: ModelSelection;
  settings: ChatSettings;
  search: boolean;
  /** Another tab's run is live: the same condition that disables the composer. */
  runHeldElsewhere: boolean;
  /** The chat hook's own calls. */
  chat: {
    sendMessage: (message: PromptInputMessage, options: TurnOptions) => unknown;
    regenerate: (options: TurnOptions) => unknown;
    stop: () => unknown;
    setMessages: (update: (held: T[]) => T[]) => void;
  };
  refreshChat: () => void;
  backendUrl: string | undefined;
  scope: Scope;
  chatId: string;
}

/**
 * Starting a Chat turn, whichever entry point asks: the composer, Regenerate,
 * or a resent edit (issue #971). The module decides whether a turn may start
 * and what goes on the wire, so a rule added here cannot be forgotten at a
 * second call site the way #539 and #648 were.
 *
 * Each start returns whether the turn started. A refused one touches nothing —
 * the checks run before the transcript is cut, because the SDK's `regenerate`
 * and an edit's truncation both drop messages the user would lose for a
 * request that could never succeed.
 *
 * The starts are stable while their inputs are: `ChatMessage` is memoised on
 * its callbacks, and a streamed token changes none of them (#869).
 */
export const useChatTurn = <T extends UIMessage>({
  selection,
  settings,
  search,
  runHeldElsewhere,
  chat: { sendMessage, regenerate: regenerateTurn, stop, setMessages },
  refreshChat,
  backendUrl,
  scope,
  chatId,
}: UseChatTurnInput<T>) => {
  const request = useMemo(
    () => turnRequest({ selection, settings, search }),
    [selection, settings, search],
  );

  const start = useCallback(
    (dispatch: (options: TurnOptions) => void): boolean => {
      if (runHeldElsewhere) return false;
      if (!request.ok) {
        toast.error(request.reason);
        return false;
      }
      dispatch({ body: request.body });
      // Tell the chat read a run has started rather than leaving it to infer
      // one. The run's start hook writes `status: "running"`, and until this
      // read learns that, nothing here can tell a live run from last turn's
      // finished one (issue #648).
      refreshChat();
      return true;
    },
    [refreshChat, request, runHeldElsewhere],
  );

  const send = useCallback(
    (message: PromptInputMessage) =>
      start((options) => sendMessage(outgoing(message), options)),
    [sendMessage, start],
  );

  const regenerate = useCallback(
    () => start((options) => regenerateTurn(options)),
    [regenerateTurn, start],
  );

  /** Drops the message at `truncateAt` and everything after it, then sends. */
  const resendEdited = useCallback(
    (truncateAt: number, message: PromptInputMessage) =>
      start((options) => {
        setMessages((held) => held.slice(0, truncateAt));
        sendMessage(outgoing(message), options);
      }),
    [sendMessage, setMessages, start],
  );

  const cancel = useCallback(() => {
    // The server-side run is decoupled from the request lifecycle, so
    // aborting the local fetch (what `stop()` does) no longer cancels
    // the run. Send an explicit cancel POST so the server stops billing
    // tokens and persists the partial result with status="cancelled".
    // Fire-and-forget (not awaited) so `stop()` below isn't held up by
    // the round trip, but a failure still surfaces — the user can retry
    // by pressing stop again, and the server treats repeated cancels as
    // idempotent no-ops, but silently swallowing a real failure (e.g. a
    // network error) would leave them thinking the run was cancelled
    // when it wasn't.
    void writeAt(
      joinUrl(
        backendUrl || "",
        `${scopedPath("chat", scope)}/${chatId}/cancel`,
      ),
      { method: "POST" },
    ).then((outcome) => {
      if (outcome.outcome !== "success") {
        toast.error(outcome.message);
      }
    });
    stop();
  }, [backendUrl, chatId, scope, stop]);

  return { send, regenerate, resendEdited, cancel };
};
