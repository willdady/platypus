import { Skeleton } from "@/components/ui/skeleton";

export function TriggerRunRowSkeleton() {
  return (
    <div className="p-4">
      <div className="flex items-center gap-4 justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex h-6 items-center">
            <Skeleton className="h-4 w-36" />
          </div>
          <Skeleton className="my-1 h-badge w-16 rounded-full" />
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
        <div className="flex items-center shrink-0">
          <div className="flex size-9 items-center justify-center">
            <Skeleton className="size-4" />
          </div>
        </div>
      </div>
    </div>
  );
}
