import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Line widths for each placeholder assistant reply, and the width of the user
// message before it. Fixed rather than random so every load draws the same
// shapes and the pulse reads as one surface, not as flicker.
const TURNS = [
  { user: "w-2/5", reply: ["w-full", "w-11/12", "w-3/5"] },
  { user: "w-1/3", reply: ["w-full", "w-4/5"] },
  { user: "w-1/2", reply: ["w-full", "w-full", "w-2/3"] },
];

/**
 * What `Chat` shows until it can render for real: providers still loading, or
 * an existing Chat whose transcript has not landed yet.
 *
 * Mirrors `Chat`'s own containers — the same column widths, the composer's
 * resting height and where it sits — so the swap to the loaded page does not
 * move anything. `transcript` picks between the two resting layouts: a docked
 * composer under placeholder messages (an existing Chat), or the composer
 * centred on its own (a new one, which has nothing to wait for).
 */
export const ChatSkeleton = ({
  transcript,
  readOnly,
}: {
  transcript: boolean;
  /** The Viewer's read-only notice stands where the composer would. */
  readOnly: boolean;
}) => (
  <div
    role="status"
    aria-label="Loading chat"
    className={cn(
      "relative size-full flex flex-col overflow-hidden h-full",
      !transcript && "justify-center",
    )}
  >
    {transcript && (
      <div className="flex-1 overflow-hidden p-4">
        <div className="flex justify-center">
          <div className="w-full flex flex-col gap-4 xl:w-4/5 max-w-4xl">
            {TURNS.map((turn, index) => (
              <div key={index} className="flex flex-col gap-4">
                <div className="ml-auto flex w-full max-w-[85%] justify-end sm:max-w-[80%]">
                  <Skeleton className={cn("h-11 rounded-lg", turn.user)} />
                </div>
                <div className="flex w-full max-w-[85%] gap-2 sm:max-w-[80%]">
                  <Skeleton className="mt-0.5 size-6 shrink-0 rounded-full" />
                  <div className="flex flex-1 flex-col gap-2 pt-1">
                    {turn.reply.map((width, line) => (
                      <Skeleton key={line} className={cn("h-4", width)} />
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )}
    <div className="grid shrink-0 gap-4 p-4">
      <div className="flex justify-center min-w-0">
        <div className="relative w-full xl:w-4/5 max-w-4xl min-w-0">
          {readOnly ? (
            // The read-only notice's box: one line of `text-sm` in `py-4`.
            <div className="flex items-center justify-center py-4 px-6 border rounded-lg bg-muted/50">
              <Skeleton className="h-5 w-72 max-w-full" />
            </div>
          ) : (
            // The composer's box: the textarea at its resting height (taller
            // while the Chat is empty, as `Chat` makes it), then the footer
            // row of tool buttons, model picker and Send.
            <div className="border-input dark:bg-input/30 w-full rounded-md border shadow-xs">
              <div className={cn("px-3 py-3", transcript ? "h-16" : "h-24")}>
                <Skeleton className="h-4 w-48 max-w-full" />
              </div>
              <div className="flex items-center justify-between gap-1 px-3 pt-1.5 pb-3">
                <div className="flex items-center gap-1">
                  <Skeleton className="size-8" />
                  <Skeleton className="size-8" />
                  <Skeleton className="h-8 w-32" />
                  <Skeleton className="size-8" />
                </div>
                <Skeleton className="size-8" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  </div>
);
