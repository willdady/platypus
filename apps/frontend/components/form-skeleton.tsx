import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Loading placeholders shaped like the ui/field + ui/card atoms a form is
// built from, so a form's skeleton can mirror its loaded layout block for
// block and the swap to the real form doesn't shift the page. Each block
// reproduces its atom's box: a FieldLabel line is ~20px (text-sm,
// leading-snug), an Input/SelectTrigger/Button h-9, a Field's gap-3, a
// FieldGroup's gap-7, a FieldSet's gap-6.

/** A FieldLabel's line. */
const LabelSkeleton = ({ className }: { className?: string }) => (
  <div className="flex h-5 items-center">
    <Skeleton className={cn("h-3.5 w-24", className)} />
  </div>
);

/** A FieldDescription's line or lines. */
const DescriptionSkeleton = ({ lines = 1 }: { lines?: number }) => (
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

/** The FieldSet a form's fields sit in (`gap-6`, `mb-6` above the footer). */
export const FormSkeletonSet = ({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) => (
  <div className={cn("mb-6 flex flex-col gap-6", className)}>{children}</div>
);

/** A FieldGroup (`gap-7` between fields). */
export const FormSkeletonGroup = ({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) => (
  <div className={cn("flex w-full flex-col gap-7", className)}>{children}</div>
);

/**
 * A label over an Input or SelectTrigger, with optional description lines —
 * FormTextField's shape, and a Select field's.
 */
export const FieldSkeleton = ({
  className,
  labelClassName,
  description = 0,
  counter = false,
}: {
  className?: string;
  labelClassName?: string;
  /** How many FieldDescription lines follow the control. */
  description?: number;
  /** Whether a `0/100` counter row follows (FormTextField `trailing`). */
  counter?: boolean;
}) => (
  <div className={cn("flex w-full flex-col gap-3", className)}>
    <LabelSkeleton className={labelClassName} />
    <Skeleton className="h-9 w-full" />
    {description > 0 && <DescriptionSkeleton lines={description} />}
    {counter && <CounterSkeleton />}
  </div>
);

/** The `0/500` character counter row under a field. */
const CounterSkeleton = () => (
  <div className="mt-1 flex h-4 items-center justify-end">
    <Skeleton className="h-3 w-12" />
  </div>
);

/** A label over a Textarea, optionally with the character counter row. */
export const TextareaSkeleton = ({
  className,
  heightClassName = "h-16",
  counter = false,
  description = 0,
}: {
  className?: string;
  /** The loaded textarea's height, e.g. `h-16` (its min) or `h-40`. */
  heightClassName?: string;
  /** Whether a `0/500` counter row follows (ExpandableTextarea `maxLength`). */
  counter?: boolean;
  description?: number;
}) => (
  <div className={cn("flex w-full flex-col gap-3", className)}>
    {/* ExpandableTextarea puts its label in a mb-2 row, not the Field gap. */}
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

/** A horizontal Switch + label row, optionally with a description line. */
export const SwitchRowSkeleton = ({
  className,
  description = true,
}: {
  className?: string;
  description?: boolean;
}) => (
  <div className={cn("flex w-full items-center gap-3", className)}>
    <Skeleton className="h-[1.15rem] w-8 shrink-0 rounded-full" />
    <div className="flex flex-1 flex-col gap-1">
      <Skeleton className="h-3.5 w-28" />
      {description && <Skeleton className="h-3 w-3/4" />}
    </div>
  </div>
);

/**
 * A Card with a title over a two-column grid of switch rows — the Tools,
 * Skills and Sub-Agents cards, and a Blueprint's resource groups.
 */
export const SwitchCardSkeleton = ({
  className,
  rows = 4,
  description = false,
}: {
  className?: string;
  /** Switch rows in the grid. */
  rows?: number;
  /** Whether a FieldDescription sits above the grid. */
  description?: boolean;
}) => (
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

/** A two-column grid of switch rows, as a FieldGroup lays them out. */
export const SwitchGridSkeleton = ({
  className,
  rows = 4,
}: {
  className?: string;
  rows?: number;
}) => (
  <div className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2", className)}>
    {Array.from({ length: rows }, (_, i) => (
      <SwitchRowSkeleton key={i} />
    ))}
  </div>
);

/** A closed Collapsible's trigger row: a label and an icon button. */
export const CollapsibleSkeleton = ({ className }: { className?: string }) => (
  <div className={cn("flex h-8 items-center justify-between", className)}>
    <Skeleton className="h-3.5 w-32" />
    <Skeleton className="size-8" />
  </div>
);

/** FormFooterButtons: Save/Update, plus Delete on an edit form. */
export const FooterSkeleton = ({
  className,
  buttons = 1,
}: {
  className?: string;
  buttons?: number;
}) => (
  <div className={cn("flex gap-2", className)}>
    {Array.from({ length: buttons }, (_, i) => (
      <Skeleton key={i} className={cn("h-9", i === 0 ? "w-20" : "w-24")} />
    ))}
  </div>
);

/** An avatar picker: a rounded square over the h-7 Remove row. */
export const AvatarSkeleton = ({ className }: { className?: string }) => (
  <div className={cn("flex flex-col items-center", className)}>
    <Skeleton className="size-20 rounded-2xl" />
    <div className="h-7" />
  </div>
);

/** The fallback for a form without its own skeleton: a few fields and Save. */
export const DefaultFormSkeleton = () => (
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
