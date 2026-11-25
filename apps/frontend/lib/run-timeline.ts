import type { RunEvent, TriggerRunStatus } from "@platypus/schemas";

export type TimelineRow = {
  event: RunEvent;
  depth: number;
  offsetMs: number;
  end:
    | { kind: "known"; durationMs: number }
    | { kind: "running"; durationMs: number }
    | { kind: "unknown" };
};

export type TimelineLayout = {
  rows: TimelineRow[];
  originMs: number;
  totalMs: number;
};

function byStart(a: RunEvent, b: RunEvent) {
  return a.startedAt - b.startedAt || a.seq - b.seq;
}

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

export const MIN_BAR_FRACTION = 0.005;

export function barGeometry(
  row: TimelineRow,
  totalMs: number,
): { left: number; width: number } {
  const left = Math.min(1, row.offsetMs / totalMs);
  if (row.end.kind === "unknown") return { left, width: MIN_BAR_FRACTION };
  const width = Math.max(MIN_BAR_FRACTION, row.end.durationMs / totalMs);
  return { left, width: Math.min(width, 1 - left) };
}

export function mergeRunEvents(
  existing: RunEvent[],
  incoming: RunEvent[],
): RunEvent[] {
  if (incoming.length === 0) return existing;
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

export function nextSinceSeq(events: RunEvent[]): number | undefined {
  if (events.length === 0) return undefined;
  const running = events.filter((e) => e.status === "running");
  if (running.length > 0) {
    const oldest = Math.min(...running.map((e) => e.seq));
    return oldest === 0 ? undefined : oldest - 1;
  }
  return Math.max(...events.map((e) => e.seq));
}
