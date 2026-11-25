import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// why: each block mirrors its atom's box, so the swap never shifts the page

function LabelSkeleton({ className }: { className?: string }) {
  return (
    <div className="flex h-5 items-center">
      <Skeleton className={cn("h-3.5 w-24", className)} />
    </div>
  );
}

function DescriptionSkeleton({ lines = 1 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="flex h-5 items-center">
          <Skeleton
            className={cn("h-3.5", i === lines - 1 ? "w-2/3" : "w-full")}
          />
        </div>
      ))}
    </div>
  );
}

export function FormSkeletonSet({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("mb-6 flex flex-col gap-6", className)}>{children}</div>
  );
}

export function FormSkeletonGroup({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex w-full flex-col gap-7", className)}>
      {children}
    </div>
  );
}

export function FieldSkeleton({
  className,
  labelClassName,
  description = 0,
  counter = false,
}: {
  className?: string;
  labelClassName?: string;
  description?: number;
  counter?: boolean;
}) {
  return (
    <div className={cn("flex w-full flex-col gap-3", className)}>
      <LabelSkeleton className={labelClassName} />
      <Skeleton className="h-9 w-full" />
      {description > 0 && <DescriptionSkeleton lines={description} />}
      {counter && <CounterSkeleton />}
    </div>
  );
}

function CounterSkeleton() {
  return (
    <div className="mt-1 flex h-4 items-center justify-end">
      <Skeleton className="h-3 w-12" />
    </div>
  );
}

export function TextareaSkeleton({
  className,
  heightClassName = "h-16",
  counter = false,
  description = 0,
}: {
  className?: string;
  heightClassName?: string;
  counter?: boolean;
  description?: number;
}) {
  return (
    // why: ExpandableTextarea's label sits in its own mb-2 row, not the gap
    <div className={cn("flex w-full flex-col gap-3", className)}>
      <div className="flex flex-col">
        <div className="mb-2 flex h-6 items-center">
          <Skeleton className="h-3.5 w-24" />
        </div>
        <Skeleton className={cn("w-full", heightClassName)} />
        {counter && <CounterSkeleton />}
      </div>
      {description > 0 && <DescriptionSkeleton lines={description} />}
    </div>
  );
}

export function SwitchToggleSkeleton() {
  return <Skeleton className="h-[1.15rem] w-8 shrink-0 rounded-full" />;
}

export function SwitchRowSkeleton({
  className,
  description = true,
  align = "start",
}: {
  className?: string;
  description?: boolean;
  align?: "start" | "end";
}) {
  const toggle = <SwitchToggleSkeleton />;
  return (
    <div className={cn("flex w-full items-center gap-3", className)}>
      {align === "start" && toggle}
      <div className="flex flex-1 flex-col gap-1">
        <div className="flex h-5 items-center">
          <Skeleton className="h-3.5 w-28" />
        </div>
        {description && (
          <div className="flex h-5 items-center">
            <Skeleton className="h-3.5 w-3/4" />
          </div>
        )}
      </div>
      {align === "end" && toggle}
    </div>
  );
}

export function SwitchCardSkeleton({
  className,
  rows = 4,
  description = false,
}: {
  className?: string;
  rows?: number;
  description?: boolean;
}) {
  return (
    <div
      className={cn(
        "bg-card flex flex-col gap-6 rounded-xl border py-6 shadow-sm",
        className,
      )}
    >
      <div className="px-6">
        <Skeleton className="h-4 w-24" />
      </div>
      <div className="px-6">
        {description && (
          <div className="mb-4">
            <DescriptionSkeleton lines={1} />
          </div>
        )}
        <SwitchGridSkeleton rows={rows} />
      </div>
    </div>
  );
}

export function SwitchGridSkeleton({
  className,
  rows = 4,
}: {
  className?: string;
  rows?: number;
}) {
  return (
    <div className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <SwitchRowSkeleton key={i} />
      ))}
    </div>
  );
}

export function CollapsibleSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex h-8 items-center justify-between", className)}>
      <Skeleton className="h-3.5 w-32" />
      <Skeleton className="size-8" />
    </div>
  );
}

export function FooterSkeleton({
  className,
  buttons = 1,
}: {
  className?: string;
  buttons?: number;
}) {
  return (
    <div className={cn("flex gap-2", className)}>
      {Array.from({ length: buttons }, (_, i) => (
        <Skeleton key={i} className={cn("h-9", i === 0 ? "w-20" : "w-24")} />
      ))}
    </div>
  );
}

export function AvatarSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col items-center", className)}>
      <Skeleton className="size-20 rounded-2xl" />
      <div className="h-7" />
    </div>
  );
}

export function DefaultFormSkeleton() {
  return (
    <>
      <FormSkeletonSet>
        <FormSkeletonGroup>
          <FieldSkeleton />
          <TextareaSkeleton />
        </FormSkeletonGroup>
      </FormSkeletonSet>
      <FooterSkeleton />
    </>
  );
}
