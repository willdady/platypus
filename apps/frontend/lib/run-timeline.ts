import type { RunEvent, TriggerRunStatus } from "@platypus/schemas";

/**
 * The arithmetic behind a **Run timeline**'s waterfall, kept out of the
 * component so it can be tested with numbers rather than pixels: how events
 * nest, where each bar starts and ends, and how the detail page's incremental
 * poll keeps a growing timeline whole.
 */

/** One row of the waterfall: an event, its depth in the tree, and its bar. */
export type TimelineRow = {
  event: RunEvent;
  depth: number;
  /** Offset from the timeline's origin, in ms. */
  offsetMs: number;
  /**
   * How the bar ends. `known` has a measured duration; `running` is still
   * open under a run that is still running, so it reaches "now"; `unknown` is
   * still open under a run that has ended — the sweep closed it, or nothing
   * did — and no bar can honestly be drawn for it.
   */
  end:
    | { kind: "known"; durationMs: number }
    | { kind: "running"; durationMs: number }
    | { kind: "unknown" };
};

export type TimelineLayout = {
  rows: TimelineRow[];
  /** The timeline's origin: the earliest start in the tree, in epoch ms. */
  originMs: number;
  /** The whole span the bars are laid out over, in ms. Never zero. */
  totalMs: number;
};

function byStart(a: RunEvent, b: RunEvent) {
  return a.startedAt - b.startedAt || a.seq - b.seq;
}

/**
 * Lays the events out as a waterfall.
 *
 * Nesting is the parent pointer; an event whose parent is not in the set
 * (dropped at the ceiling, or not yet fetched) is shown at the root rather
 * than lost. Order at every level is by start time, so tool calls issued in
 * parallel read as overlapping rather than one after another. The origin is
 * subtracted once, here — starts are absolute instants, so a delegate's events
 * need no rebasing against their own run.
 */
export function layoutTimeline(
  events: RunEvent[],
  runStatus: TriggerRunStatus,
  now: number = Date.now(),
): TimelineLayout {
  if (events.length === 0) return { rows: [], originMs: 0, totalMs: 1 };

  const ids = new Set(events.map((e) => e.id));
  const children = new Map<string | null, RunEvent[]>();
  for (const event of events) {
    const parent =
      event.parentEventId && ids.has(event.parentEventId)
        ? event.parentEventId
        : null;
    const list = children.get(parent) ?? [];
    list.push(event);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort(byStart);

  const originMs = Math.min(...events.map((e) => e.startedAt));
  const runIsLive = runStatus === "running" || runStatus === "pending";

  const rows: TimelineRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const event of children.get(parent) ?? []) {
      const offsetMs = event.startedAt - originMs;
      let end: TimelineRow["end"];
      if (event.durationMs != null) {
        end = { kind: "known", durationMs: event.durationMs };
      } else if (event.status === "running" && runIsLive) {
        end = {
          kind: "running",
          durationMs: Math.max(0, now - event.startedAt),
        };
      } else {
        end = { kind: "unknown" };
      }
      rows.push({ event, depth, offsetMs, end });
      walk(event.id, depth + 1);
    }
  };
  walk(null, 0);

  const totalMs = Math.max(
    1,
    ...rows.map((row) =>
      row.end.kind === "unknown"
        ? row.offsetMs
        : row.offsetMs + row.end.durationMs,
    ),
  );

  return { rows, originMs, totalMs };
}

/** The narrowest a bar is drawn, as a fraction of the track — or it vanishes. */
export const MIN_BAR_FRACTION = 0.005;

/** A bar's left edge and width as fractions of the track, floored so a
 *  sub-millisecond span is still visible. */
export function barGeometry(
  row: TimelineRow,
  totalMs: number,
): { left: number; width: number } {
  const left = Math.min(1, row.offsetMs / totalMs);
  if (row.end.kind === "unknown") return { left, width: MIN_BAR_FRACTION };
  const width = Math.max(MIN_BAR_FRACTION, row.end.durationMs / totalMs);
  return { left, width: Math.min(width, 1 - left) };
}

/**
 * Folds a poll's events into what the page already holds. Events arrive once
 * open and again once patched, so an incoming event replaces the one it
 * updates rather than duplicating it.
 */
export function mergeRunEvents(
  existing: RunEvent[],
  incoming: RunEvent[],
): RunEvent[] {
  if (incoming.length === 0) return existing;
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Where the next incremental poll should read from. An event is written open
 * and patched when it closes, and the endpoint filters by sequence number —
 * so the page has to ask from just below its OLDEST still-running event, not
 * from the newest event it has, or the patches never reach it. With nothing
 * running, the newest sequence number is enough. `undefined` asks for
 * everything: with nothing held, or with the very first event still open,
 * there is no sequence number to read from.
 */
export function nextSinceSeq(events: RunEvent[]): number | undefined {
  if (events.length === 0) return undefined;
  const running = events.filter((e) => e.status === "running");
  if (running.length > 0) {
    const oldest = Math.min(...running.map((e) => e.seq));
    return oldest === 0 ? undefined : oldest - 1;
  }
  return Math.max(...events.map((e) => e.seq));
}
