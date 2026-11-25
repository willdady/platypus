import { formatToolDuration } from "@/lib/tool-duration";

export type ToolDurationProps = {
  durationMs?: number;
};

// why: only the server's figure — a browser-measured gap includes other streaming
export function ToolDuration({ durationMs }: ToolDurationProps) {
  if (durationMs === undefined) return null;

  // why: a sibling of the name, so truncation drops the duration last
  return (
    <span className="shrink-0 text-muted-foreground text-xs">
      &mdash; {formatToolDuration(durationMs)}
    </span>
  );
}
