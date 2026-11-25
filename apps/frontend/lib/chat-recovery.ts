import type {
  Chat,
  ChatStatus as RunStatus,
  PlatypusUIMessage,
} from "@platypus/schemas";
import type { ChatStatus as TurnStatus } from "ai";
import type { Serialized } from "./api-write";

export const CHAT_POLL_INTERVAL_MS = 3_000;

function isRunOver(status: RunStatus | undefined): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled"
  );
}

export function isTurnInFlight(status: TurnStatus): boolean {
  return status === "submitted" || status === "streaming";
}

export type RunBelief = {
  runStatus: RunStatus | undefined;
  turnStatus: TurnStatus;
  turnEstablished: boolean;
};

export function runMayBeLive({
  runStatus,
  turnStatus,
  turnEstablished,
}: RunBelief): boolean {
  if (runStatus === "running") return true;
  if (isTurnInFlight(turnStatus)) return true;
  return turnStatus === "error" && turnEstablished && !isRunOver(runStatus);
}

export function isRunHeldElsewhere(belief: RunBelief): boolean {
  return runMayBeLive(belief) && !isTurnInFlight(belief.turnStatus);
}

export function chatPollIntervalMs(belief: RunBelief): number {
  return isRunHeldElsewhere(belief) ? CHAT_POLL_INTERVAL_MS : 0;
}

export type ChatErrorTreatment = "none" | "recovering" | "failure";

export function classifyChatError({
  error,
  ...belief
}: RunBelief & { error: Error | undefined }): ChatErrorTreatment {
  if (!error) return "none";
  if (!belief.turnEstablished) return "failure";
  if (belief.runStatus === "failed") return "failure";
  return runMayBeLive(belief) ? "recovering" : "none";
}

export function composerTurnStatus(
  belief: RunBelief,
  treatment: ChatErrorTreatment,
): TurnStatus {
  if (isRunHeldElsewhere(belief)) return "streaming";
  if (belief.turnStatus === "error" && treatment !== "failure") return "ready";
  return belief.turnStatus;
}

export type TranscriptExtent = {
  messages: number;
  parts: number;
  textLength: number;
};

export function transcriptExtent(
  messages: readonly PlatypusUIMessage[] | undefined,
): TranscriptExtent {
  const extent: TranscriptExtent = { messages: 0, parts: 0, textLength: 0 };
  if (!messages) return extent;
  extent.messages = messages.length;
  for (const message of messages) {
    const parts = message.parts ?? [];
    extent.parts += parts.length;
    for (const part of parts) {
      const text: unknown = (part as { text?: unknown }).text;
      if (typeof text === "string") extent.textLength += text.length;
    }
  }
  return extent;
}

export function snapshotMayLand(
  snapshot: readonly PlatypusUIMessage[],
  held: readonly PlatypusUIMessage[],
  runStatus: RunStatus | undefined,
): boolean {
  if (isRunOver(runStatus)) return true;
  const leaf = snapshot.at(-1);
  const heldLeaf = held.at(-1);
  if (leaf && heldLeaf && leaf.id === heldLeaf.id) {
    const next = transcriptExtent([leaf]);
    const current = transcriptExtent([heldLeaf]);
    return next.parts >= current.parts && next.textLength >= current.textLength;
  }
  return !held.some((message) => message.id === leaf?.id);
}

export function snapshotMessages(
  chat: Serialized<Chat> | null | undefined,
): PlatypusUIMessage[] | undefined {
  return chat?.messages;
}
