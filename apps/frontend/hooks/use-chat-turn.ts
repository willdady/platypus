import { useCallback, useMemo } from "react";
import type { FileUIPart, UIMessage } from "ai";
import type { SandboxUpload } from "@platypus/schemas";
import { toast } from "sonner";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import type { ChatSettings } from "@/hooks/use-chat-settings";
import type { ModelSelection } from "@/hooks/use-model-selection";
import { writeAt, scopedPath, type Scope } from "@/lib/api-write";
import { turnRequest } from "@/lib/chat-turn";
import { ATTACHMENTS_ONLY_TEXT } from "@/lib/message-parts";
import { joinUrl } from "@/lib/utils";

type TurnOptions = { body: Record<string, unknown> };

/** A message to send: its Sandbox uploads have already landed. */
export type TurnMessage = PromptInputMessage & {
  sandboxUploads?: SandboxUpload[];
};

/** What the chat hook's `sendMessage` takes. */
type Outgoing =
  | { text: string; files: FileUIPart[] }
  | {
      parts: (
        | FileUIPart
        | { type: "data-sandbox-upload"; data: SandboxUpload }
        | { type: "text"; text: string }
      )[];
    };

/**
 * An attachment-only message is a real turn: the question was the file. A
 * message with Sandbox uploads goes as parts, in the order the SDK gives a
 * text-and-files one: files, then the text.
 */
const outgoing = ({ text, files, sandboxUploads }: TurnMessage): Outgoing => {
  const words = text || ATTACHMENTS_ONLY_TEXT;
  if (!sandboxUploads?.length) return { text: words, files };
  return {
    parts: [
      ...files,
      ...sandboxUploads.map((data) => ({
        type: "data-sandbox-upload" as const,
        data,
      })),
      { type: "text", text: words },
    ],
  };
};

export interface UseChatTurnInput<T extends UIMessage> {
  selection: ModelSelection;
  settings: ChatSettings;
  search: boolean;
  /** Another tab's run is live: the same condition that disables the composer. */
  runHeldElsewhere: boolean;
  /** The chat hook's own calls. */
  chat: {
    sendMessage: (message: Outgoing, options: TurnOptions) => unknown;
    regenerate: (options: TurnOptions & { messageId: string }) => unknown;
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
    (message: TurnMessage) =>
      start((options) => sendMessage(outgoing(message), options)),
    [sendMessage, start],
  );

  /**
   * Regenerates the reply `messageId`, named explicitly: the SDK's default
   * names no message, and the server needs one to know what to run from.
   */
  const regenerate = useCallback(
    (messageId: string) =>
      start((options) => regenerateTurn({ ...options, messageId })),
    [regenerateTurn, start],
  );

  /**
   * Drops the message at `truncateAt` and everything after it from the screen,
   * then sends the edit as a new message under `parentId`, the edited one's
   * parent — or under the message above it where that is not known yet. The
   * stored rows stay (ADR-0026). Never `sendMessage({ messageId })`: it
   * replaces the message in place under the same id, which is a row the server
   * already holds.
   */
  const resendEdited = useCallback(
    (truncateAt: number, message: TurnMessage, parentId?: string | null) =>
      start((options) => {
        setMessages((held) => held.slice(0, truncateAt));
        sendMessage(
          outgoing(message),
          parentId === undefined
            ? options
            : { body: { ...options.body, parentId } },
        );
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
