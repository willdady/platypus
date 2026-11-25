import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Chat as ChatType, PlatypusUIMessage } from "@platypus/schemas";
import type { ChatStatus as TurnStatus } from "ai";
import { toast } from "sonner";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useRevalidateOnRestore } from "@/hooks/use-revalidate-on-restore";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { optionalFetcher } from "@/lib/utils";
import { writeAt, type Scope, type WriteOutcome } from "@/lib/api-write";
import {
  alternativePositions,
  type AlternativePosition,
} from "@/lib/chat-alternatives";
import {
  chatPollIntervalMs,
  classifyChatError,
  composerTurnStatus,
  isRunHeldElsewhere,
  isTurnInFlight,
  snapshotMayLand,
  snapshotMessages,
  type RunBelief,
} from "@/lib/chat-recovery";

export type UseChatTranscriptInput = {
  scope: Scope;
  chatId: string;
  chatUrl: string;
  messages: PlatypusUIMessage[];
  setMessages: (
    update:
      | PlatypusUIMessage[]
      | ((held: PlatypusUIMessage[]) => PlatypusUIMessage[]),
  ) => void;
  status: TurnStatus;
  error: Error | undefined;
};

type SwitchRun = { before: PlatypusUIMessage[]; next?: string };

export function useChatTranscript({
  scope,
  chatId,
  chatUrl,
  messages,
  setMessages,
  status,
  error,
}: UseChatTranscriptInput) {
  const [turnEstablished, setTurnEstablished] = useState(false);
  useResetOnChange(status, () => {
    if (status === "submitted") setTurnEstablished(false);
    else if (status === "streaming") setTurnEstablished(true);
  });

  const {
    data: chatData,
    isLoading: isChatLoading,
    mutate: mutateChat,
  } = useScopedSWR<ChatType | null>(`chat/${chatId}`, scope, {
    fetcher: optionalFetcher,
    refreshInterval: (data) =>
      chatPollIntervalMs({
        runStatus: data?.status,
        turnStatus: status,
        turnEstablished,
      }),
  });

  const refreshChat = useCallback(() => {
    void mutateChat().catch(() => {});
  }, [mutateChat]);

  const turnWasInFlight = useRef(false);
  useEffect(() => {
    if (isTurnInFlight(status)) {
      turnWasInFlight.current = true;
    } else if (turnWasInFlight.current) {
      turnWasInFlight.current = false;
      refreshChat();
    }
  }, [status, refreshChat]);

  useRevalidateOnRestore(refreshChat);

  const runBelief: RunBelief = {
    runStatus: chatData?.status,
    turnStatus: status,
    turnEstablished,
  };
  const errorTreatment = classifyChatError({ error, ...runBelief });
  const runHeldElsewhere = isRunHeldElsewhere(runBelief);
  const effectiveStatus = composerTurnStatus(runBelief, errorTreatment);

  // why: written in an effect, so hydrate reads the status the last commit rendered
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const switchRef = useRef<SwitchRun | null>(null);
  const seenRef = useRef(new Map<string, PlatypusUIMessage>());

  useEffect(() => {
    const snapshot = snapshotMessages(chatData);
    if (!snapshot || isTurnInFlight(statusRef.current) || switchRef.current) {
      return;
    }
    setMessages((held) =>
      snapshotMayLand(snapshot, held, chatData?.status) ? snapshot : held,
    );
  }, [chatData, setMessages]);

  const [hydratedChatId, setHydratedChatId] = useState<string | null>(null);
  if (messages.length > 0 && hydratedChatId !== chatId) {
    setHydratedChatId(chatId);
  }

  const deleteMessage = useCallback(
    (messageId: string) => {
      void writeAt(`${chatUrl}/messages/${messageId}`, {
        method: "DELETE",
      }).then((outcome) => {
        if (outcome.outcome === "success") refreshChat();
        else toast.error(outcome.message);
      });
    },
    [chatUrl, refreshChat],
  );

  const switchAlternative = useCallback(
    async (fromId: string, toId: string) => {
      let before: PlatypusUIMessage[] = [];
      setMessages((held) => {
        before = held;
        for (const message of held) seenRef.current.set(message.id, message);
        const at = held.findIndex((message) => message.id === fromId);
        const target = seenRef.current.get(toId) ?? {
          id: toId,
          role: held[at].role,
          parts: [],
        };
        return [...held.slice(0, at), target];
      });

      if (switchRef.current) {
        switchRef.current.next = toId;
        return;
      }
      const run: SwitchRun = { before };
      switchRef.current = run;
      const put = (messageId: string) =>
        writeAt<Required<Pick<ChatType, "messages" | "tree">>>(
          `${chatUrl}/active-leaf`,
          {
            method: "PUT",
            data: { messageId },
          },
        );
      let outcome = await put(toId);
      while (run.next) {
        const messageId = run.next;
        run.next = undefined;
        outcome = await put(messageId);
      }
      switchRef.current = null;
      if (isTurnInFlight(statusRef.current)) return;

      if (outcome.outcome === "success") {
        const { messages: landed, tree } = outcome.data;
        setMessages(landed);
        void mutateChat(
          (current) => current && { ...current, messages: landed, tree },
          { revalidate: false },
        );
      } else {
        setMessages(run.before);
        toast.error(outcome.message);
      }
    },
    [chatUrl, mutateChat, setMessages],
  );

  const compact = useCallback(
    (instruction?: string): Promise<WriteOutcome<unknown>> =>
      writeAt(`${chatUrl}/compact`, {
        method: "POST",
        data: instruction ? { instruction } : {},
      }),
    [chatUrl],
  );

  const tree = chatData?.tree;
  const parentOf = useMemo(
    () => new Map(tree?.map((node) => [node.id, node.parentId])),
    [tree],
  );

  const pathKey = messages.map((message) => message.id).join("\n");
  const positions = useMemo<Map<string, AlternativePosition>>(
    () => alternativePositions(tree, pathKey.split("\n")),
    [tree, pathKey],
  );

  const isRegenerable = (index: number) => {
    const above = messages[index - 1];
    const parentId = parentOf.get(messages[index].id);
    return (
      messages[index].role === "assistant" &&
      above?.role === "user" &&
      (parentId === undefined || parentId === above.id)
    );
  };

  const isTranscriptPending =
    (isChatLoading && chatData === undefined) ||
    (hydratedChatId !== chatId && !!snapshotMessages(chatData)?.length);

  return {
    chatData,
    isChatLoading,
    mutateChat,
    refreshChat,
    runBelief,
    errorTreatment,
    runHeldElsewhere,
    effectiveStatus,
    parentOf,
    positions,
    isRegenerable,
    switchAlternative,
    deleteMessage,
    compact,
    isTranscriptPending,
  };
}
