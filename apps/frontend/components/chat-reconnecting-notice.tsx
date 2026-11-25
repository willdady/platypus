import { RefreshCw } from "lucide-react";

// why: the Chat docs quote this sentence verbatim
export const CHAT_RECONNECTING_MESSAGE =
  "Connection interrupted. The reply is still being written and will keep filling in here.";

// why: a dropped stream is not a failed turn; a line, not a modal
export function ChatReconnectingNotice() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-2 flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground"
    >
      <RefreshCw className="size-4 shrink-0 animate-spin" aria-hidden="true" />
      <span>{CHAT_RECONNECTING_MESSAGE}</span>
    </div>
  );
}
