import { RefreshCw } from "lucide-react";

/** The sentence a reader sees; also what the documentation quotes. */
export const CHAT_RECONNECTING_MESSAGE =
  "Connection interrupted. The reply is still being written and will keep filling in here.";

/**
 * The line shown while a Chat has lost its stream to a run that is still going.
 *
 * A dropped connection is not a failed turn — the run outlives the request and
 * the answer keeps arriving from the poll — so it gets a line in the flow of the
 * page rather than the modal a real failure gets (issue #648). Announced
 * politely so a screen reader picks it up without interrupting the reply being
 * read.
 */
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
