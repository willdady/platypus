"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDownIcon, LayersIcon } from "lucide-react";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  Tool,
  ToolContent,
  ToolStatus,
  toolRowClassName,
  toolRowIconSlotClassName,
} from "./ai-elements/tool";
import { Shimmer } from "./ai-elements/shimmer";

export type IndexedPart<P> = { part: P; index: number };

export type PartSegment<P, G extends P> =
  | ({ kind: "part" } & IndexedPart<P>)
  | { kind: "group"; entries: IndexedPart<G>[] };

export function partitionParts<P extends { type: string }, G extends P>(
  parts: readonly P[],
  isGroupable: (part: P) => part is G,
  isHidden: (part: P) => boolean,
): PartSegment<P, G>[] {
  const segments: PartSegment<P, G>[] = [];
  let group: IndexedPart<G>[] | null = null;
  parts.forEach((part, index) => {
    if (isHidden(part)) return;
    if (isGroupable(part)) {
      if (!group) {
        group = [];
        segments.push({ kind: "group", entries: group });
      }
      group.push({ part, index });
    } else if (!(group && part.type === "step-start")) {
      group = null;
      segments.push({ kind: "part", part, index });
    }
  });
  return segments;
}

export const TOOL_CALL_VERBS = [
  "Hullabalooing",
  "Fossicking",
  "Kerfuffling",
  "Discombobulating",
  "Skedaddling",
  "Shenaniganing",
  "Bludging",
  "Yabbering",
  "Squizzing",
  "Wombling",
  "Spruiking",
  "Ratbagging",
  "Billabonging",
  "Burrowing",
  "Platypussing",
  "Dabbling",
  "Boomeranging",
  "Bushwalking",
  "Wombatting",
  "Kookaburring",
  "Didgeridooing",
  "Jackarooing",
  "Mustering",
  "Droving",
  "Walkabouting",
  "Barbecuing",
  "Tinnying",
  "Surfing",
  "Gallivanting",
  "Dobbing",
  "Snorkelling",
  "Bilbying",
  "Possuming",
  "Kangarooing",
  "Emuing",
] as const;

const VERB_HOLD_MS = 2000;

type VerbState = { verb: string; count: number; changedAt: number };

function pickVerb(previous: string | undefined, random: () => number) {
  const choices = TOOL_CALL_VERBS.filter((verb) => verb !== previous);
  return choices[Math.floor(random() * choices.length)];
}

export function advanceVerb(
  state: VerbState,
  count: number,
  now: number,
  random: () => number = Math.random,
): VerbState {
  if (count === state.count) return state;
  if (now - state.changedAt < VERB_HOLD_MS) return { ...state, count };
  return { verb: pickVerb(state.verb, random), count, changedAt: now };
}

function ActiveLabel({ count }: { count: number }) {
  const [state, setState] = useState<VerbState>(() => ({
    verb: pickVerb(undefined, Math.random),
    count,
    changedAt: Date.now(),
  }));
  useEffect(() => {
    // why: the hold needs the wall clock, and render must not read it
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((current) => advanceVerb(current, count, Date.now()));
  }, [count]);
  return <Shimmer as="span">{`${state.verb}…`}</Shimmer>;
}

const SHOWN_NAMES = 2;

export function ToolCallGroup({
  names,
  errored,
  active,
  children,
}: {
  names: string[];
  errored: boolean;
  active: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [settled, setSettled] = useState(!active);
  if (!active && !settled) setSettled(true);

  const distinct = [...new Set(names)];
  const more = distinct.length - SHOWN_NAMES;
  const label = `${names.length} tool ${names.length === 1 ? "call" : "calls"}: ${distinct.join(", ")}${settled && errored ? " (with errors)" : ""}`;

  // why: kept mounted while closed, so each call keeps its open state
  return (
    <Tool open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        aria-label={label}
        className={cn(
          toolRowClassName,
          "transition-colors hover:text-foreground",
        )}
      >
        <span className={toolRowIconSlotClassName}>
          <LayersIcon className="size-4" />
        </span>
        {settled ? (
          <>
            <span className="min-w-0 truncate">
              {distinct.slice(0, SHOWN_NAMES).join(", ")}
            </span>
            {more > 0 && <span className="shrink-0">+{more} more</span>}
            {errored && <ToolStatus state="output-error" />}
          </>
        ) : (
          <ActiveLabel count={names.length} />
        )}
        <ChevronDownIcon
          className={cn(
            "size-4 shrink-0 transition-transform",
            open ? "rotate-180" : "rotate-0",
          )}
        />
      </CollapsibleTrigger>
      <ToolContent forceMount hidden={!open} className="gap-3">
        {children}
      </ToolContent>
    </Tool>
  );
}
