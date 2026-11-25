import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function CountTooltip({
  icon,
  noun,
  names,
}: {
  icon: ReactNode;
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
