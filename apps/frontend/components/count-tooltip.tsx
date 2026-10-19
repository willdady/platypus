import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * A card's one-line count — "3 tool sets", "1 input" — with a tooltip listing
 * each name. With no names it reads "0 …" and has no tooltip.
 */
export function CountTooltip({
  icon,
  noun,
  names,
}: {
  /** A `size-3` icon leading the count. */
  icon: ReactNode;
  /** The singular noun: "tool set". */
  noun: string;
  names: readonly string[];
}) {
  const label = (
    <span className="flex shrink-0 items-center gap-1 cursor-default whitespace-nowrap">
      {icon}
      {names.length} {noun}
      {names.length !== 1 && "s"}
    </span>
  );
  if (!names.length) return label;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent>
        <ul className="text-left">
          {names.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
