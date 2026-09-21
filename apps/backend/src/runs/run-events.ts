import { randomUUID } from "node:crypto";
import type { InferUIMessageChunk, Tool } from "ai";
import {
  RUN_EVENT_ERROR_MAX_BYTES,
  type RunEvent,
  type RunEventError,
  type RunEventStatus,
  type RunEventType,
} from "@platypus/schemas";
import type { PlatypusUIMessage } from "../types.ts";
import type { RunStatus } from "./types.ts";
import { DELEGATE_TOOL_NAME } from "../tools/turn-tool-names.ts";

/**
 * A **Run timeline**'s in-memory half: the ordered **Run events** of one
 * headless run, recorded as they happen and drained by the sink in batches
 * (`CONTEXT.md`; ADR-0023).
 *
 * Everything about an event's shape is decided here — what is captured, which
 * clock each field reads, how an error is capped, when the ceiling cuts the
 * timeline short — so the drive that observes the stream and the sink that
 * writes the rows both stay thin. Three things are deliberately absent: tool
 * inputs, tool outputs, and message or reasoning content. A Run event says
 * what kind of thing happened, when, for how long, and how it ended; the error
 * string on a failed event is the one exception, and it is capped.
 */

/** The most events one run records. A runaway guard, not a performance bound. */
const RUN_EVENT_CEILING = 10_000;

/**
 * Where a drive's events go: the recorder of the root run, and the event they
 * hang beneath — `null` for the root run's own events, the `delegate` event's
 * id for a Sub-Agent's. Nesting is carried by this pointer alone; a delegate
 * gets no run record of its own.
 */
export type RunEventScope = {
  recorder: RunEventRecorder;
  parentEventId: string | null;
};

/**
 * The two clocks an event reads, kept apart on purpose. `now` is the wall
 * clock (epoch ms) a start is stamped with, so it lines up with backend and
 * upstream logs. `monotonic` is what a duration is measured on: subtracting
 * two wall-clock reads across an NTP adjustment yields a negative duration and
 * a bar that renders backwards.
 */
export type RunEventClocks = {
  now: () => number;
  monotonic: () => number;
};

/** What a later flush writes back onto an already-inserted event. */
export type RunEventPatch = Pick<
  RunEvent,
  "id" | "status" | "durationMs" | "error" | "childrenTruncated"
>;

type OpenSpec = { type: RunEventType; toolName?: string };
type CloseSpec = { status: Exclude<RunEventStatus, "running">; error?: string };

/**
 * Caps an error string at {@link RUN_EVENT_ERROR_MAX_BYTES}, cutting on a
 * character boundary so a multi-byte codepoint is never split — a lone
 * surrogate breaks serialization. A cut is explicit: the preview is marked
 * truncated and the original byte length kept, so a reader can tell a short
 * error from a clipped one.
 */
export const capRunEventError = (message: string): RunEventError => {
  const originalBytes = Buffer.byteLength(message, "utf8");
  if (originalBytes <= RUN_EVENT_ERROR_MAX_BYTES) {
    return { message, truncated: false, originalBytes };
  }
  let bytes = 0;
  let preview = "";
  // Iterating the string yields whole codepoints, so the cut can only land
  // between characters.
  for (const char of message) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > RUN_EVENT_ERROR_MAX_BYTES) break;
    bytes += size;
    preview += char;
  }
  return { message: preview, truncated: true, originalBytes };
};

/** An event plus the monotonic instant it opened at, which never leaves here. */
type Recorded = { event: RunEvent; monoStart: number };

export class RunEventRecorder {
  readonly runId: string;
  private readonly ceiling: number;
  private readonly clocks: RunEventClocks;
  private readonly generateId: () => string;
  private readonly records: Recorded[] = [];
  private readonly byId = new Map<string, Recorded>();
  private readonly byKey = new Map<string, string>();
  /** Ids not yet handed to a flush. */
  private pendingInsert = new Set<string>();
  /** Ids already inserted whose state changed since. */
  private pendingUpdate = new Set<string>();
  private truncated = false;
  private listener?: () => void;

  constructor(params: {
    runId: string;
    ceiling?: number;
    clocks?: Partial<RunEventClocks>;
    generateId?: () => string;
  }) {
    this.runId = params.runId;
    this.ceiling = params.ceiling ?? RUN_EVENT_CEILING;
    this.clocks = {
      now: params.clocks?.now ?? Date.now,
      monotonic: params.clocks?.monotonic ?? (() => performance.now()),
    };
    this.generateId = params.generateId ?? (() => `rev_${randomUUID()}`);
  }

  /** Every event recorded so far, in sequence order. Read-only snapshot. */
  get events(): readonly RunEvent[] {
    return this.records.map((r) => r.event);
  }

  /** The run hit its event ceiling, so this timeline is incomplete. */
  get eventsTruncated(): boolean {
    return this.truncated;
  }

  /** The one observer — a sink that bumps its flush on every change. */
  subscribe(listener: () => void): void {
    this.listener = listener;
  }

  /**
   * Opens an event under `parentEventId`. Returns its id, or `null` once the
   * ceiling is reached — in which case the run is marked truncated and so is
   * the open parent, so a delegate whose children were dropped does not read
   * as a delegate that did nothing.
   */
  open(parentEventId: string | null, spec: OpenSpec): string | null {
    if (this.records.length >= this.ceiling) {
      this.truncated = true;
      if (parentEventId) {
        const parent = this.byId.get(parentEventId);
        if (parent && !parent.event.childrenTruncated) {
          parent.event.childrenTruncated = true;
          this.markChanged(parentEventId);
        }
      }
      return null;
    }
    const id = this.generateId();
    const event: RunEvent = {
      id,
      runId: this.runId,
      parentEventId,
      seq: this.records.length,
      type: spec.type,
      toolName: spec.toolName ?? null,
      startedAt: this.clocks.now(),
      durationMs: null,
      status: "running",
      error: null,
      childrenTruncated: false,
    };
    const recorded = { event, monoStart: this.clocks.monotonic() };
    this.records.push(recorded);
    this.byId.set(id, recorded);
    this.pendingInsert.add(id);
    this.listener?.();
    return id;
  }

  /** Closes an open event. A second close, or a close of an unknown id, is a no-op. */
  close(id: string, spec: CloseSpec): void {
    const recorded = this.byId.get(id);
    if (!recorded || recorded.event.status !== "running") return;
    this.settle(recorded, spec);
    this.listener?.();
  }

  /**
   * {@link open}, idempotent on `key`: two observers of one tool call — the
   * stream's chunks and the tool's own wrapper — each ask, and the first to
   * arrive opens the event while the second gets its id.
   */
  openKeyed(
    key: string,
    parentEventId: string | null,
    spec: OpenSpec,
  ): string | null {
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    const id = this.open(parentEventId, spec);
    if (id) this.byKey.set(key, id);
    return id;
  }

  /** {@link close} by key. Unknown keys, and keys already closed, are ignored. */
  closeKeyed(key: string, spec: CloseSpec): void {
    const id = this.byKey.get(key);
    if (id) this.close(id, spec);
  }

  /**
   * Closes every still-running event — or, given a parent, only that parent's
   * direct children — with `status`. Called on a run's every terminal path so
   * no terminal run leaves an open event; a delegate's drive calls it scoped
   * to its own event for the same reason one level down.
   */
  closeOpen(
    status: Exclude<RunEventStatus, "running">,
    parentEventId?: string | null,
  ): void {
    let changed = false;
    for (const recorded of this.records) {
      if (recorded.event.status !== "running") continue;
      if (
        parentEventId !== undefined &&
        recorded.event.parentEventId !== parentEventId
      ) {
        continue;
      }
      this.settle(recorded, { status });
      changed = true;
    }
    if (changed) this.listener?.();
  }

  /**
   * Hands the sink what changed since the last drain: events never written
   * (inserted in their *current* state, so one opened and closed inside a
   * flush window is never inserted running and then patched) and the patches
   * for events that were.
   */
  drain(): { inserts: RunEvent[]; updates: RunEventPatch[] } {
    const inserts: RunEvent[] = [];
    for (const id of this.pendingInsert) {
      const recorded = this.byId.get(id);
      if (recorded) inserts.push({ ...recorded.event });
    }
    const updates: RunEventPatch[] = [];
    for (const id of this.pendingUpdate) {
      // An event that is still waiting to be inserted carries its change in
      // the insert itself.
      if (this.pendingInsert.has(id)) continue;
      const recorded = this.byId.get(id);
      if (!recorded) continue;
      const { status, durationMs, error, childrenTruncated } = recorded.event;
      updates.push({ id, status, durationMs, error, childrenTruncated });
    }
    this.pendingInsert = new Set();
    this.pendingUpdate = new Set();
    return { inserts, updates };
  }

  private settle(recorded: Recorded, spec: CloseSpec): void {
    recorded.event.status = spec.status;
    recorded.event.durationMs = Math.max(
      0,
      Math.round(this.clocks.monotonic() - recorded.monoStart),
    );
    recorded.event.error =
      spec.error === undefined ? null : capRunEventError(spec.error);
    this.markChanged(recorded.event.id);
  }

  private markChanged(id: string): void {
    if (!this.pendingInsert.has(id)) this.pendingUpdate.add(id);
  }
}

/**
 * The key one tool call's two observers share. Scoped to the parent so a
 * delegate's tool-call ids can never collide with its parent's.
 */
const toolKey = (scope: RunEventScope, toolCallId: string): string =>
  `${scope.parentEventId ?? "root"}:tool:${toolCallId}`;

const stretchKey = (
  scope: RunEventScope,
  kind: "text" | "reasoning",
  id: string,
): string => `${scope.parentEventId ?? "root"}:${kind}:${id}`;

/**
 * What a tool call is recorded as. The one delegation tool is a `delegate`
 * event named for its target — the Sub-Agent's name is the identity of what
 * was called, exactly as a tool name is, and is the only thing read off the
 * input. Every other tool is a `tool-call` under its own name.
 */
const toolSpec = (toolName: string, input: unknown): OpenSpec => {
  if (toolName !== DELEGATE_TOOL_NAME) return { type: "tool-call", toolName };
  const target =
    typeof input === "object" && input !== null
      ? (input as { subAgent?: unknown }).subAgent
      : undefined;
  return {
    type: "delegate",
    toolName: typeof target === "string" && target.trim() ? target : undefined,
  };
};

/**
 * Projects one UI message stream chunk onto the recorder.
 *
 * The UI stream is the instrumentation surface all three drives already fold,
 * so one switch serves the headless drive and a delegate's alike. A text or
 * reasoning stretch opens at its start chunk and closes at its end; a tool
 * call opens once its input is complete — not at input start, which would
 * count the model's own argument streaming as tool time — and closes on its
 * output or error. Deltas, inputs and outputs are read for their ids and
 * nothing else.
 */
export const recordUiChunk = (
  scope: RunEventScope,
  chunk: InferUIMessageChunk<PlatypusUIMessage>,
): void => {
  const { recorder, parentEventId } = scope;
  switch (chunk.type) {
    case "text-start":
      recorder.openKeyed(stretchKey(scope, "text", chunk.id), parentEventId, {
        type: "text",
      });
      return;
    case "text-end":
      recorder.closeKeyed(stretchKey(scope, "text", chunk.id), {
        status: "completed",
      });
      return;
    case "reasoning-start":
      recorder.openKeyed(
        stretchKey(scope, "reasoning", chunk.id),
        parentEventId,
        { type: "reasoning" },
      );
      return;
    case "reasoning-end":
      recorder.closeKeyed(stretchKey(scope, "reasoning", chunk.id), {
        status: "completed",
      });
      return;
    case "tool-input-available":
      recorder.openKeyed(
        toolKey(scope, chunk.toolCallId),
        parentEventId,
        toolSpec(chunk.toolName, chunk.input),
      );
      return;
    case "tool-input-error":
      // The model produced an input the tool could not take: the call never
      // ran, and that is the failure the event records.
      recorder.openKeyed(
        toolKey(scope, chunk.toolCallId),
        parentEventId,
        toolSpec(chunk.toolName, chunk.input),
      );
      recorder.closeKeyed(toolKey(scope, chunk.toolCallId), {
        status: "error",
        error: chunk.errorText,
      });
      return;
    case "tool-output-available":
      // A preliminary output is an in-progress yield (the delegate tool's
      // activity log); the call is still running.
      if (chunk.preliminary) return;
      recorder.closeKeyed(toolKey(scope, chunk.toolCallId), {
        status: "completed",
      });
      return;
    case "tool-output-error":
      recorder.closeKeyed(toolKey(scope, chunk.toolCallId), {
        status: "error",
        error: chunk.errorText,
      });
      return;
    case "tool-output-denied":
      recorder.closeKeyed(toolKey(scope, chunk.toolCallId), {
        status: "cancelled",
      });
      return;
    default:
      return;
  }
};

/**
 * A pass-through transform that records every chunk it sees. Piped onto a
 * drive's UI stream before that stream is split or consumed, so recording
 * costs the consumer nothing and misses nothing.
 */
export const recordRunEvents = (
  scope: RunEventScope,
): TransformStream<
  InferUIMessageChunk<PlatypusUIMessage>,
  InferUIMessageChunk<PlatypusUIMessage>
> =>
  new TransformStream({
    transform(chunk, controller) {
      recordUiChunk(scope, chunk);
      controller.enqueue(chunk);
    },
  });

/**
 * How a tool learns which event it is running under. Carried on the execute
 * options the wrapper below hands the tool, under a symbol so it can never
 * collide with — or be mistaken for — anything the SDK puts there. The
 * delegation tool reads it to nest its Sub-Agent's events; every other tool
 * ignores it.
 */
const RUN_EVENT_SCOPE: unique symbol = Symbol("platypus.runEventScope");

type ScopedOptions = { [RUN_EVENT_SCOPE]?: RunEventScope };

/** A tool's execute options as a plain record, or nothing if they are not one. */
const optionsRecord = (
  options: unknown,
): (Record<string, unknown> & ScopedOptions) | undefined =>
  typeof options === "object" && options !== null
    ? (options as Record<string, unknown> & ScopedOptions)
    : undefined;

/** The scope a wrapper attached to a tool's execute options, if any. */
export const runEventScopeOf = (options: unknown): RunEventScope | undefined =>
  optionsRecord(options)?.[RUN_EVENT_SCOPE];

/**
 * Wraps each locally-executed tool so its event is open before it runs and its
 * own scope — the recorder plus that event — travels with it. Opening here as
 * well as from the stream's `tool-input-available` chunk is deliberate: the
 * two race, and `openKeyed` lets whichever arrives first win while the other
 * reads the same id. Closing is left to the stream, which sees the output.
 *
 * Provider-executed tools have no `execute` and are left as they are; their
 * events come from the stream alone.
 */
export const wrapToolsWithRunEvents = (
  tools: Record<string, Tool>,
  scope: RunEventScope,
): Record<string, Tool> => {
  const wrapped: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = (tool as { execute?: unknown }).execute;
    if (typeof execute !== "function") {
      wrapped[name] = tool;
      continue;
    }
    const runExecute = execute as (args: unknown, options: unknown) => unknown;
    wrapped[name] = {
      ...tool,
      execute: (args: unknown, options: unknown) => {
        const given = optionsRecord(options);
        const toolCallId = given?.toolCallId;
        const eventId =
          typeof toolCallId === "string"
            ? scope.recorder.openKeyed(
                toolKey(scope, toolCallId),
                scope.parentEventId,
                toolSpec(name, args),
              )
            : null;
        const scoped: ScopedOptions & Record<string, unknown> = {
          ...given,
          // With no event of its own (the ceiling was hit), a tool's children
          // hang off whatever this scope hangs off — still recorded, still
          // marked truncated on the run.
          [RUN_EVENT_SCOPE]: {
            recorder: scope.recorder,
            parentEventId: eventId ?? scope.parentEventId,
          },
        };
        return runExecute.call(tool, args, scoped);
      },
    };
  }
  return wrapped;
};

/** The run's terminal status, as its still-open events are closed with it. */
export const eventStatusForRun = (
  status: RunStatus,
): Exclude<RunEventStatus, "running"> => {
  switch (status) {
    case "succeeded":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "error";
  }
};
