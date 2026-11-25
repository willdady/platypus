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

export type TurnMessage = PromptInputMessage & {
  sandboxUploads?: SandboxUpload[];
};

type Outgoing =
  | { text: string; files: FileUIPart[] }
  | {
      parts: (
        | FileUIPart
        | { type: "data-sandbox-upload"; data: SandboxUpload }
        | { type: "text"; text: string }
      )[];
    };

function outgoing({ text, files, sandboxUploads }: TurnMessage): Outgoing {
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
}

export type UseChatTurnInput<T extends UIMessage> = {
  selection: ModelSelection;
  settings: ChatSettings;
  search: boolean;
  runHeldElsewhere: boolean;
  chat: {
    sendMessage: (message: Outgoing, options: TurnOptions) => unknown;
    regenerate: (options: TurnOptions & { messageId: string }) => unknown;
    addToolApprovalResponse: (response: {
      id: string;
      approved: boolean;
      options: TurnOptions;
    }) => unknown;
    stop: () => unknown;
    setMessages: (update: (held: T[]) => T[]) => void;
  };
  refreshChat: () => void;
  backendUrl: string | undefined;
  scope: Scope;
  chatId: string;
};

export function useChatTurn<T extends UIMessage>({
  selection,
  settings,
  search,
  runHeldElsewhere,
  chat: {
    sendMessage,
    regenerate: regenerateTurn,
    addToolApprovalResponse,
    stop,
    setMessages,
  },
  refreshChat,
  backendUrl,
  scope,
  chatId,
}: UseChatTurnInput<T>) {
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

  const regenerate = useCallback(
    (messageId: string) =>
      start((options) => regenerateTurn({ ...options, messageId })),
    [regenerateTurn, start],
  );

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

  const respond = useCallback(
    (approvalId: string, approved: boolean): boolean => {
      if (runHeldElsewhere) return false;
      if (!request.ok) {
        toast.error(request.reason);
        return false;
      }
      addToolApprovalResponse({
        id: approvalId,
        approved,
        options: { body: request.body },
      });
      return true;
    },
    [addToolApprovalResponse, request, runHeldElsewhere],
  );

  const cancel = useCallback(() => {
    // why: stop() doesn't cancel the server run; the POST does, and a failure is toasted
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

  return { send, regenerate, resendEdited, respond, cancel };
}
