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

/** The chat hook's state the Transcript read is kept in step with. */
export type UseChatTranscriptInput = {
  scope: Scope;
  chatId: string;
  /** This Chat's detail URL, for the transcript's own writes. */
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

/** A run of switches between Alternatives: the path to go back to if it fails,
 * the one on screen before its first click, and the Alternative a click made
 * while a request was in flight asks for next. */
type SwitchRun = { before: PlatypusUIMessage[]; next?: string };

/**
 * The client side of ADR-0026: keeping this tab's `useChat` message list in
 * step with the server-owned Transcript.
 *
 * The pure decisions live in `lib/chat-recovery.ts` and `lib/chat-alternatives.ts`.
 * What used to live loose in `chat.tsx` — and produced #648, #1018, #1020 and
 * #1590 — is the sequencing between them, and that is what this hook owns: when
 * the row is read, when a fetched snapshot may land, whether a run is held
 * elsewhere, and how a switch between Alternatives is made one request at a
 * time. The seam is HTTP (`writeAt` plus `useScopedSWR`) and the chat-hook state
 * it is handed.
 */
export function useChatTranscript({
  scope,
  chatId,
  chatUrl,
  messages,
  setMessages,
  status,
  error,
}: UseChatTranscriptInput) {
  // Whether this turn's stream had started arriving before it broke — what tells
  // a dropped connection from a request the server refused (issue #648).
  //
  // The one thing that tells the two apart: a turn that got bytes passed through
  // `streaming` on its way to `error`, and one that was refused went from
  // `submitted` straight to `error`. Without it, a rejected attachment and a
  // backgrounded tab look identical from the client — both are just an error on
  // the chat hook. Reset at each submit, so the answer is about the turn in hand
  // rather than an earlier one. Kept in state adjusted during render rather than
  // a ref written in an effect: the classification is read on the very render the
  // error appears, and a ref would still be holding the previous render's value.
  const [turnEstablished, setTurnEstablished] = useState(false);
  useResetOnChange(status, () => {
    if (status === "submitted") setTurnEstablished(false);
    else if (status === "streaming") setTurnEstablished(true);
  });

  // Fetch existing chat data, and re-read it while a run this tab is not
  // streaming may be live, so a client that lost its stream, or never had one,
  // sees the partial answer keep filling in. `chatPollIntervalMs` owns that
  // decision (issue #648). Under this tab's own stream it does not poll: the
  // read taken when the turn ends, below, is what a dropped stream resumes
  // from.
  //
  // Focus and reconnect revalidation are deliberately left on (SWR's defaults).
  // They are the "the user came back" and "the network returned" signals, and a
  // frozen mobile tab's timers do not run at all while it is away, so they are
  // the only thing that can wake a poll promptly. Safe to leave on because
  // hydration is monotonic — see the hydrate effect below.
  //
  // `optionalFetcher` because a brand-new Chat is read before its row exists
  // (the run creates it): a thrown 404 would sit in the cache as an error, and
  // SWR does not revalidate on an interval while one is there.
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

  // Re-read the row from the authority. Nothing here awaits it and a failure is
  // not worth reporting: SWR retries a failed read, and reconnect and focus
  // read again, so recovery never depends on one refresh landing.
  const refreshChat = useCallback(() => {
    void mutateChat().catch(() => {});
  }, [mutateChat]);

  // A turn's rows — its message and reply, and with them the tree that gives a
  // new Alternative its arrows — reach this tab only through this read. The
  // poll stops once nothing says a run is live, so a turn that ends inside one
  // poll interval would otherwise leave the read as it was before the turn.
  const turnWasInFlight = useRef(false);
  useEffect(() => {
    if (isTurnInFlight(status)) {
      turnWasInFlight.current = true;
    } else if (turnWasInFlight.current) {
      turnWasInFlight.current = false;
      refreshChat();
    }
  }, [status, refreshChat]);

  // A restored page's poll was frozen the whole time it was away, and a bfcache
  // restore is neither a focus nor a reconnect.
  useRevalidateOnRestore(refreshChat);

  // One reading of "is a run in flight?", shared by the composer guard and the
  // error classification below, so the two cannot disagree.
  const runBelief: RunBelief = {
    runStatus: chatData?.status,
    turnStatus: status,
    turnEstablished,
  };
  const errorTreatment = classifyChatError({ error, ...runBelief });
  const runHeldElsewhere = isRunHeldElsewhere(runBelief);
  const effectiveStatus = composerTurnStatus(runBelief, errorTreatment);

  // Hydrate chat from persisted data on load (or when chatData changes).
  // We use a ref for status so that this effect only fires when chatData
  // actually changes (e.g. initial fetch or SWR revalidation), NOT when
  // the streaming status transitions. Without this, ending a stream would
  // trigger the effect and overwrite the fresh messages with stale SWR data.
  const statusRef = useRef(status);
  // Written in an effect (not during render) so the hydrate effect below reads
  // the status committed by the previous render.
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // A run of switches between Alternatives: the path to go back to if it
  // fails, the one on screen before its first click, and the Alternative a
  // click made while a request was in flight asks for next.
  const switchRef = useRef<SwitchRun | null>(null);
  // Messages this tab has switched away from, so switching back to one shows
  // it at once.
  const seenRef = useRef(new Map<string, PlatypusUIMessage>());

  // Hydration never rewinds: mid-run, a fetched snapshot lands only where it is
  // at least as far along as what is on screen (issue #648). The chat row is
  // written on a flush interval, so a snapshot fetched mid-run lags the stream
  // by up to one flush — applying it unconditionally is what would make the
  // answer visibly shorten and then grow back. The comparison is made against
  // the live message list through the updater rather than a dependency, so the
  // effect still runs only when `chatData` changes and not on every streamed
  // chunk.
  //
  // A switch between Alternatives holds it off too, from the click until the
  // server has answered: any row read in between still names the old path,
  // and landing it would drag the view back.
  useEffect(() => {
    const snapshot = snapshotMessages(chatData);
    if (!snapshot || isTurnInFlight(statusRef.current) || switchRef.current) {
      return;
    }
    setMessages((held) =>
      snapshotMayLand(snapshot, held, chatData?.status) ? snapshot : held,
    );
  }, [chatData, setMessages]);

  // The Chat whose messages have reached the screen at least once, adjusted
  // during render so it is already set on the frame they first appear. Only
  // that first arrival counts: deleting every message later must not bring the
  // loading skeleton back over an empty Chat.
  const [hydratedChatId, setHydratedChatId] = useState<string | null>(null);
  if (messages.length > 0 && hydratedChatId !== chatId) {
    setHydratedChatId(chatId);
  }

  // Stored the moment it is clicked (ADR-0026), then the row is read back:
  // the transcript on screen is the server's, not a local cut of it. Nothing
  // here closes over `messages`, which would give this callback a new identity
  // on every message update, defeat the `ChatMessage` memo and re-render the
  // whole transcript per token (#869).
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

  // Shows the Alternative `toId` in place of `fromId` straight away, then asks
  // the server for the path under it. Not debounced, but one request at a
  // time: a click while one is in flight waits for it, replacing any click
  // already waiting. An aborted request could still be saved after a later
  // one, and a reload would then show the earlier choice; in order, the last
  // click is the one saved. The local swap has only what this tab has already
  // shown, or an empty message in its place, and nothing below it; the
  // server's answer fills the rest in.
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
      // A turn started meanwhile, from the swapped-in message, owns the screen
      // now, and its run moves the path itself.
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

  // A Transcript summary on demand (`/compact`, issue #1111): a write to the
  // Chat, not a message of its own. The write only; the caller reports the
  // outcome and reads the row back.
  const compact = useCallback(
    (instruction?: string): Promise<WriteOutcome<unknown>> =>
      writeAt(`${chatUrl}/compact`, {
        method: "POST",
        data: instruction ? { instruction } : {},
      }),
    [chatUrl],
  );

  // An edit hangs from the edited message's own parent, which the tree keeps
  // even once it is deleted. The message above it on screen is only the
  // nearest one still in the Chat, and an edit hung there would sit beside the
  // wrong message.
  const tree = chatData?.tree;
  const parentOf = useMemo(
    () => new Map(tree?.map((node) => [node.id, node.parentId])),
    [tree],
  );

  // Keyed on the ids alone, so a streamed token (new messages, same ids)
  // keeps each position's identity and the `ChatMessage` memo with it (#869).
  const pathKey = messages.map((message) => message.id).join("\n");
  const positions = useMemo<Map<string, AlternativePosition>>(
    () => alternativePositions(tree, pathKey.split("\n")),
    [tree, pathKey],
  );

  // Regenerate runs again from the reply's own message, so it is offered only
  // where that message is the one above the reply on screen. Once it has been
  // deleted there is nothing to answer, and the server refuses (409). A reply
  // the tree does not list yet is the one this tab just streamed, from the
  // message above it.
  const isRegenerable = (index: number) => {
    const above = messages[index - 1];
    const parentId = parentOf.get(messages[index].id);
    return (
      messages[index].role === "assistant" &&
      above?.role === "user" &&
      (parentId === undefined || parentId === above.id)
    );
  };

  // Whether this Chat's transcript is still on its way: the row read is in
  // flight (a new Chat's is seeded `null`, so never counts), or the row has
  // landed with messages the hydrate effect has not applied yet. Rendering the
  // empty-chat layout over either gap is what showed the composer centred and
  // then dropped it to the bottom once the messages arrived.
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
