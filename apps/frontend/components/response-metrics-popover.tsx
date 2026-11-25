"use client";

import { InfoIcon } from "lucide-react";
import type { CachedInputTokens, ChatMessageMetadata } from "@platypus/schemas";
import { MessageAction } from "./ai-elements/message";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { cachedTokenBreakdown } from "@/lib/cached-tokens";
import { formatTokenCount } from "@/lib/token-count";
import { formatToolDuration } from "@/lib/tool-duration";
import { cn } from "@/lib/utils";

type ResponseMetrics = {
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
  } & CachedInputTokens;
  prepDurationMs?: number;
  modelDurationMs?: number;
  measuredToolDurationMs?: number;
};

export function responseMetrics(
  metadata: ChatMessageMetadata | undefined,
): ResponseMetrics | undefined {
  const tokenUsage = metadata?.tokenUsage;
  const prepDurationMs = metadata?.prepDurationMs;
  const modelDurationMs = metadata?.modelDurationMs;

  const toolDurations = metadata?.toolDurations;
  const toolDurationValues = toolDurations ? Object.values(toolDurations) : [];
  const measuredToolDurationMs =
    toolDurationValues.length > 0
      ? toolDurationValues.reduce((sum, ms) => sum + ms, 0)
      : undefined;

  if (
    !tokenUsage &&
    prepDurationMs === undefined &&
    modelDurationMs === undefined &&
    measuredToolDurationMs === undefined
  ) {
    return undefined;
  }

  return {
    tokenUsage,
    prepDurationMs,
    modelDurationMs,
    measuredToolDurationMs,
  };
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function ResponseMetricsContent({ metrics }: { metrics: ResponseMetrics }) {
  const {
    tokenUsage,
    prepDurationMs,
    modelDurationMs,
    measuredToolDurationMs,
  } = metrics;

  const hasTiming =
    prepDurationMs !== undefined ||
    modelDurationMs !== undefined ||
    measuredToolDurationMs !== undefined;
  const toolLineIsNested = modelDurationMs !== undefined;

  return (
    <div className="flex flex-col gap-3 text-sm">
      {tokenUsage && (
        <div className="flex flex-col gap-1">
          <MetricRow
            label="Input"
            value={formatTokenCount(tokenUsage.inputTokens)}
          />
          {cachedTokenBreakdown(tokenUsage, formatTokenCount).map((line) => (
            <p key={line} className="pl-3 text-xs text-muted-foreground">
              {line}
            </p>
          ))}
          <MetricRow
            label="Output"
            value={formatTokenCount(tokenUsage.outputTokens)}
          />
          <MetricRow
            label="Total"
            value={formatTokenCount(
              tokenUsage.inputTokens + tokenUsage.outputTokens,
            )}
          />
        </div>
      )}
      {hasTiming && (
        <div className="flex flex-col gap-1">
          {prepDurationMs !== undefined && (
            <MetricRow
              label="Preparation"
              value={formatToolDuration(prepDurationMs)}
            />
          )}
          {modelDurationMs !== undefined && (
            <MetricRow
              label="Model"
              value={formatToolDuration(modelDurationMs)}
            />
          )}
          {measuredToolDurationMs !== undefined && (
            <p
              className={cn(
                "text-xs text-muted-foreground",
                toolLineIsNested && "pl-3",
              )}
            >
              of which tools {formatToolDuration(measuredToolDurationMs)}{" "}
              measured
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export type ResponseMetricsPopoverProps = {
  metadata: ChatMessageMetadata | undefined;
};

export function ResponseMetricsPopover({
  metadata,
}: ResponseMetricsPopoverProps) {
  const metrics = responseMetrics(metadata);
  if (!metrics) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <MessageAction
          className="text-muted-foreground"
          variant="ghost"
          size="icon"
          label="Response metrics"
        >
          <InfoIcon className="size-4" />
        </MessageAction>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <ResponseMetricsContent metrics={metrics} />
      </PopoverContent>
    </Popover>
  );
}
