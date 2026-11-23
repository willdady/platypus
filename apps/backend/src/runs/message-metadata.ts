import type { TextStreamPart, ToolSet } from "ai";
import type { ModelUsage } from "@platypus/schemas";
import {
  isTruncatedByTokenLimit,
  stoppedAtStepCeiling,
} from "./stream-error.ts";
import { pickCachedInput, sumUsage } from "./run-stats.ts";
import { isContextOverflowError } from "../services/context-overflow.ts";
import type { ChatMessageMetadata } from "../types.ts";
import type { TurnFacts } from "./types.ts";

export type MessageMetadataFacts = TurnFacts & {
  toolDurations?: ReadonlyMap<string, number>;
  summaryId?: string;
  stepCeiling: number;
  driveStartMs?: number;
  now?: () => number;
  isClearableTool?: (toolName: string) => boolean;
  delegatedUsage?: () => readonly ModelUsage[];
  continued?: ChatMessageMetadata;
};

export const createMessageMetadata = ({
  agentId,
  toolDurations = new Map(),
  searchUnavailable = false,
  stepCeiling,
  prepDurationMs,
  driveStartMs,
  now = Date.now,
  isClearableTool,
  delegatedUsage,
  continued,
  summaryId,
}: MessageMetadataFacts) => {
  const priorUsage = continued?.tokenUsage ? [continued.tokenUsage] : [];
  const priorModelMs = continued?.modelDurationMs ?? 0;
  let occupancyReported = false;
  let steps = 0;
  let ownUsage = sumUsage([]);
  const calledClearableToolNames = new Set<string>();

  return ({
    part,
  }: {
    part: TextStreamPart<ToolSet>;
  }): ChatMessageMetadata | undefined => {
    if (part.type === "start") {
      const meta: ChatMessageMetadata = {};
      if (agentId) meta.agentId = agentId;
      if (searchUnavailable) meta.searchUnavailable = true;
      if (typeof prepDurationMs === "number") {
        meta.prepDurationMs = Math.round(
          prepDurationMs + (continued?.prepDurationMs ?? 0),
        );
      }
      return Object.keys(meta).length > 0 ? meta : undefined;
    }
    if (part.type === "finish-step") {
      steps += 1;
      const meta: ChatMessageMetadata = {};
      const { inputTokens, outputTokens } = part.usage;

      if (summaryId !== undefined) meta.summaryId = summaryId;

      if (typeof inputTokens !== "number") {
        if (occupancyReported) meta.contextOccupancy = null;
      } else {
        occupancyReported = true;
        meta.contextOccupancy = {
          inputTokens,
          outputTokens: typeof outputTokens === "number" ? outputTokens : null,
        };
      }

      if (typeof inputTokens === "number" || typeof outputTokens === "number") {
        ownUsage = sumUsage([
          ownUsage,
          {
            inputTokens: inputTokens ?? 0,
            outputTokens: outputTokens ?? 0,
            ...pickCachedInput(part.usage.inputTokenDetails),
          },
        ]);
        meta.tokenUsage = sumUsage([
          ...priorUsage,
          ownUsage,
          ...(delegatedUsage?.() ?? []),
        ]);
      }

      if (typeof driveStartMs === "number") {
        meta.modelDurationMs = Math.round(priorModelMs + now() - driveStartMs);
      }

      return Object.keys(meta).length > 0 ? meta : undefined;
    }
    if (part.type === "tool-result" || part.type === "tool-error") {
      const meta: ChatMessageMetadata = {};
      const durationMs = toolDurations.get(part.toolCallId);
      if (durationMs !== undefined) {
        meta.toolDurations = { [part.toolCallId]: Math.round(durationMs) };
      }
      if (isClearableTool?.(part.toolName)) {
        calledClearableToolNames.add(part.toolName);
        meta.readOnlyToolNames = [...calledClearableToolNames];
      }
      return Object.keys(meta).length > 0 ? meta : undefined;
    }
    if (part.type === "error" && isContextOverflowError(part.error)) {
      return {
        contextOverflow: true,
        ...(summaryId !== undefined ? { summaryId } : {}),
      };
    }
    // why: terminal finish only; a mid-loop step can hit the token ceiling and the run still recover
    if (part.type === "finish") {
      if (isTruncatedByTokenLimit(part.finishReason)) {
        return { truncatedByTokenLimit: true };
      }
      if (
        stoppedAtStepCeiling({
          finishReason: part.finishReason,
          steps,
          stepCeiling,
        })
      ) {
        return { stoppedAtStepLimit: true };
      }
    }
    return undefined;
  };
};
