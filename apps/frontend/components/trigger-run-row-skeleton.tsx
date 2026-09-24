import { Skeleton } from "@/components/ui/skeleton";

/**
 * The loading placeholder for one `TriggerRunRow`, laid out on the same
 * frame — status badge, the Trigger name, start time (absolute and
 * relative), duration and the stats line, then the icon actions — so the
 * rows land without shifting. Each text line is a box of the line's own
 * height holding a shorter bar, which is how the loaded text reads.
 */
export const TriggerRunRowSkeleton = ({
  linkToDetail = true,
}: {
  /** Mirrors the row's own prop: off drops the **View run** action. */
  linkToDetail?: boolean;
}) => (
  <div className="p-4">
    <div className="flex items-center gap-4 justify-between">
      <div className="flex min-w-0 items-center gap-4">
        <Skeleton className="h-[22px] w-16 shrink-0 rounded-full" />
        <div className="min-w-0">
          <div className="flex h-6 items-center">
            <Skeleton className="h-4 w-36" />
          </div>
          <div className="flex h-5 items-center">
            <Skeleton className="h-3.5 w-44" />
          </div>
          <div className="flex h-5 items-center">
            <Skeleton className="h-3.5 w-24" />
          </div>
          <div className="flex h-5 items-center">
            <Skeleton className="h-3.5 w-28" />
          </div>
          <div className="mt-1 flex h-4 items-center">
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
        </div>
      </div>
      <div className="flex items-center shrink-0">
        {linkToDetail && (
          <div className="flex size-9 items-center justify-center">
            <Skeleton className="size-4" />
          </div>
        )}
        <div className="flex size-9 items-center justify-center">
          <Skeleton className="size-4" />
        </div>
      </div>
    </div>
  </div>
);
