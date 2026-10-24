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

/** One part of a message, kept with its index in `message.parts`. */
export type IndexedPart<P> = { part: P; index: number };

/**
 * What a message's parts render as, in order: a part on its own, or a Tool
 * call group of one or more adjacent groupable calls.
 */
export type PartSegment<P, G extends P> =
  | ({ kind: "part" } & IndexedPart<P>)
  | { kind: "group"; entries: IndexedPart<G>[] };

/**
 * Splits a message's parts into segments. A run of groupable parts becomes
 * one group, a run of one included, so a row never changes shape when a
 * second call streams in. Any other part ends the run — except a step
 * boundary, which draws nothing, so the calls either side of it still sit
 * together on screen. A hidden part renders elsewhere, so it is dropped
 * without ending the run.
 */
export function partitionParts<P extends { type: string }, G extends P>(
  parts: readonly P[],
  isGroupable: (part: P) => part is G,
  isHidden: (part: P) => boolean = () => false,
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

/** Decorative only: the header's accessible name never carries one. */
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

/** How long a verb stays up before a joining call may replace it. */
const VERB_HOLD_MS = 2000;

type VerbState = { verb: string; count: number; changedAt: number };

function pickVerb(previous: string | undefined, random: () => number) {
  const choices = TOOL_CALL_VERBS.filter((verb) => verb !== previous);
  return choices[Math.floor(random() * choices.length)];
}

/**
 * The active header's verb after the group holds `count` calls at `now`. A
 * call joining re-picks the verb, unless the current one has been up for
 * less than the hold — then the join is absorbed, not deferred.
 */
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
    // Reacts to a call joining; the hold needs the wall clock, which render
    // must not read.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((current) => advanceVerb(current, count, Date.now()));
  }, [count]);
  return <Shimmer as="span">{`${state.verb}…`}</Shimmer>;
}

/** How many names the settled header spells out before "+N more". */
const SHOWN_NAMES = 2;

/**
 * A Tool call group (see GLOSSARY): one collapsible row holding adjacent tool
 * calls, each still its own disclosure inside. Collapsed until the reader
 * opens it, and never opened or closed for them.
 *
 * Active while the group is the last thing in a reply still being written;
 * settled once anything follows it or the turn ends, and never active again.
 */
export function ToolCallGroup({
  names,
  errored,
  active,
  children,
}: {
  /** Each call's display name, in order — one per child. */
  names: string[];
  /** Whether any call in the group failed. */
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
      {/* Kept mounted while closed so each call keeps its own open state;
      a forced-mount Radix content never hides itself. `hidden` beats the
      `flex` class through Tailwind preflight's `[hidden]` rule. */}
      <ToolContent forceMount hidden={!open} className="gap-3">
        {children}
      </ToolContent>
    </Tool>
  );
}
