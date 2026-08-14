import { formatToolDuration } from "@/lib/tool-duration";

export type ToolDurationProps = {
  /** Duration recorded by the run pipeline, present once the run is persisted. */
  durationMs?: number;
};

/**
 * How long a tool call took, shown beside its name in the tool header.
 *
 * Only the server's figure is ever shown. The browser can't measure this
 * itself: the gap it sees between a tool's input and output chunks also holds
 * whatever else the model was streaming meanwhile, which for a quick tool is
 * most of the gap. A clock built on that reads seconds for a tool the server
 * timed in single milliseconds, and gets visibly corrected when the chat
 * re-hydrates — so the duration appears once, when the run is persisted, and
 * never changes afterwards.
 */
export const ToolDuration = ({ durationMs }: ToolDurationProps) => {
  if (durationMs === undefined) return null;

  // A sibling of the name rather than part of it: the name truncates, and the
  // duration is the last thing that should disappear when it does.
  return (
    <span className="shrink-0 font-normal text-sm text-muted-foreground">
      &mdash; {formatToolDuration(durationMs)}
    </span>
  );
};
