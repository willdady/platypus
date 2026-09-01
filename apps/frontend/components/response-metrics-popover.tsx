"use client";

import { InfoIcon } from "lucide-react";
import type { ChatMessageMetadata } from "@platypus/backend/src/types";
import { MessageAction } from "./ai-elements/message";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { cachedTokenBreakdown } from "@/lib/cached-tokens";
import { formatToolDuration } from "@/lib/tool-duration";
import { responseMetrics, type ResponseMetrics } from "@/lib/response-metrics";
import { cn } from "@/lib/utils";

const formatTokenCount = (n: number) => n.toLocaleString();

const MetricRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between gap-4">
    <span className="text-muted-foreground">{label}</span>
    <span className="tabular-nums">{value}</span>
  </div>
);

/**
 * The panel's body. A leaf that reads only the metrics it is handed, so
 * opening the popover never re-renders the message or the message list it
 * lives inside (issue #354).
 *
 * No Total wall-clock figure and no derived `Model − tools` remainder:
 * Preparation and Model are each their own reading, and tool calls inside a
 * step run concurrently, so summed tool time can legitimately exceed the
 * Model phase it is measured inside of.
 */
const ResponseMetricsContent = ({ metrics }: { metrics: ResponseMetrics }) => {
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
  // Nested under Model normally. A message with tool time but no Model
  // reading — an older message carrying only #353's `toolDurations` — has
  // nothing to nest it under, so it renders as its own line instead.
  const toolLineIsNested = modelDurationMs !== undefined;

  return (
    <div className="space-y-3 text-sm">
      {tokenUsage && (
        <div className="space-y-1">
          <MetricRow
            label="Input"
            value={formatTokenCount(tokenUsage.inputTokens)}
          />
          {/* Cached input is a breakdown of the Input figure above, which
            already includes it — shown under Input, never subtracted from it
            (issue #734). Absent means the Provider reported no cached reads,
            which is never read as zero. */}
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
        <div className="space-y-1">
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
};

export type ResponseMetricsPopoverProps = {
  /** The assistant message's metadata. Absent fields simply omit that row —
   *  see `responseMetrics`. */
  metadata: ChatMessageMetadata | undefined;
};

/**
 * The `(i)` control on the assistant action bar (issue #354): a click/tap
 * popover, not hover — hover is inaccessible on touch — listing whichever of
 * Token usage, Preparation and Model are available for this response.
 *
 * Renders nothing when no metric at all is available, which is also true of
 * every message persisted before this change.
 */
export const ResponseMetricsPopover = ({
  metadata,
}: ResponseMetricsPopoverProps) => {
  const metrics = responseMetrics(metadata);
  if (!metrics) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <MessageAction
          className="cursor-pointer text-muted-foreground"
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
};
