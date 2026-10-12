import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/**
 * The dashed card a screen shows in place of content it has none of (or
 * couldn't load): an icon, a title, what the thing is for, and the buttons
 * that fix it. One frame, so the cards stop drifting apart. A one-line empty
 * state (filtered to nothing, a section within a page) is `ListState` instead.
 */
export function EmptyCard({
  icon,
  title,
  description,
  action,
  className,
}: {
  /** A bare Lucide icon; the frame sizes it. */
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** The buttons, main one first, laid out in a row. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn("border-2 border-dashed", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action && (
        <EmptyContent>
          <div className="flex flex-wrap justify-center gap-2">{action}</div>
        </EmptyContent>
      )}
    </Empty>
  );
}
