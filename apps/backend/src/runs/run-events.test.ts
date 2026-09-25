import { describe, it, expect, vi } from "vitest";
import type { Tool } from "ai";
import {
  capRunEventError,
  recordUiChunk,
  RunEventRecorder,
  runEventScopeOf,
  wrapToolsWithRunEvents,
  type RunEventScope,
} from "./run-events.ts";
import { RUN_EVENT_ERROR_MAX_BYTES } from "@platypus/schemas";
import { DELEGATE_TOOL_NAME } from "../tools/turn-tool-names.ts";

/**
 * The recorder is the one place a Run event's shape is decided (ADR-0023):
 * what is captured, which clock each field reads, how an error is capped, and
 * when the ceiling cuts a timeline short. These tests pin those rules with
 * fake clocks; the drive and sink suites cover how events reach it and the
 * database.
 */

/** Two controllable clocks: a settable wall clock and a monotonic one. */
const clocks = () => {
  const state = { wall: 1_700_000_000_000, mono: 1000 };
  return {
    state,
    now: () => state.wall,
    monotonic: () => state.mono,
    /** Advance both clocks together, the way real time passes. */
    tick: (ms: number) => {
      state.wall += ms;
      state.mono += ms;
    },
  };
};

const recorderOf = (
  opts: { ceiling?: number } = {},
  c = clocks(),
): { recorder: RunEventRecorder; c: ReturnType<typeof clocks> } => {
  let n = 0;
  const recorder = new RunEventRecorder({
    runId: "run-1",
    ceiling: opts.ceiling,
    clocks: { now: c.now, monotonic: c.monotonic },
    generateId: () => `ev-${(n += 1)}`,
  });
  return { recorder, c };
};

describe("RunEventRecorder", () => {
  it("records a tool call's shape, start and duration — never its payload", () => {
    const { recorder, c } = recorderOf();

    const id = recorder.open(null, { type: "tool-call", toolName: "search" });
    c.tick(250);
    recorder.close(id!, { status: "completed" });

    const [event] = recorder.events;
    expect(event).toEqual({
      id: "ev-1",
      runId: "run-1",
      parentEventId: null,
      seq: 0,
      type: "tool-call",
      toolName: "search",
      startedAt: 1_700_000_000_000,
      durationMs: 250,
      status: "completed",
      error: null,
      childrenTruncated: false,
    });
  });

  // The two fields read different clocks on purpose: a start correlates with
  // logs, a duration must survive the wall clock being adjusted mid-run.
  it("measures duration on the monotonic clock, so a wall-clock step back cannot make it negative", () => {
    const { recorder, c } = recorderOf();

    const id = recorder.open(null, { type: "text" });
    c.state.mono += 40;
    c.state.wall -= 60_000; // NTP pulls the wall clock back a minute
    recorder.close(id!, { status: "completed" });

    expect(recorder.events[0].durationMs).toBe(40);
  });

  it("assigns a monotonic sequence number in insertion order", () => {
    const { recorder } = recorderOf();

    recorder.open(null, { type: "reasoning" });
    recorder.open(null, { type: "text" });
    recorder.open(null, { type: "tool-call", toolName: "a" });

    expect(recorder.events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("nests an event under the parent it was opened in", () => {
    const { recorder } = recorderOf();

    const parent = recorder.open(null, {
      type: "delegate",
      toolName: "Researcher",
    });
    recorder.open(parent, { type: "tool-call", toolName: "search" });

    expect(recorder.events[1].parentEventId).toBe("ev-1");
  });

  // Two observers see one tool call — the stream's chunks and the tool's own
  // execute wrapper — and neither knows which will get there first.
  it("opens and closes a keyed event exactly once however many times it is asked", () => {
    const { recorder, c } = recorderOf();

    const first = recorder.openKeyed("tool:tc1", null, {
      type: "tool-call",
      toolName: "search",
    });
    const second = recorder.openKeyed("tool:tc1", null, {
      type: "tool-call",
      toolName: "search",
    });
    c.tick(10);
    recorder.closeKeyed("tool:tc1", { status: "completed" });
    c.tick(10);
    recorder.closeKeyed("tool:tc1", { status: "error", error: "late" });

    expect(second).toBe(first);
    expect(recorder.events).toHaveLength(1);
    expect(recorder.events[0]).toMatchObject({
      durationMs: 10,
      status: "completed",
      error: null,
    });
  });

  it("ignores a close for a key that was never opened", () => {
    const { recorder } = recorderOf();

    expect(() =>
      recorder.closeKeyed("tool:unknown", { status: "completed" }),
    ).not.toThrow();
    expect(recorder.events).toHaveLength(0);
  });

  it("stores a failed event's error capped and explicitly marked", () => {
    const { recorder } = recorderOf();
    const long = "é".repeat(700); // 1400 bytes, 700 characters

    const id = recorder.open(null, { type: "tool-call", toolName: "t" });
    recorder.close(id!, { status: "error", error: long });

    const stored = recorder.events[0].error!;
    expect(stored.truncated).toBe(true);
    expect(stored.originalBytes).toBe(1400);
    expect(Buffer.byteLength(stored.message, "utf8")).toBeLessThanOrEqual(
      RUN_EVENT_ERROR_MAX_BYTES,
    );
    // Cut on a character boundary: the preview is whole characters, and
    // serializing it cannot produce a lone surrogate.
    expect(stored.message).toBe("é".repeat(512));
    const roundTripped = JSON.parse(
      JSON.stringify(recorder.events),
    ) as typeof recorder.events;
    expect(roundTripped[0].error?.message).toBe(stored.message);
  });

  // The ceiling is a runaway guard. What matters is that hitting it is
  // visible on the node whose children were lost, not only on the run.
  it("stops appending at the ceiling and marks the run and the open parent as truncated", () => {
    const { recorder } = recorderOf({ ceiling: 3 });

    const delegate = recorder.open(null, {
      type: "delegate",
      toolName: "Researcher",
    });
    recorder.open(delegate, { type: "tool-call", toolName: "a" });
    recorder.open(delegate, { type: "tool-call", toolName: "b" });
    const dropped = recorder.open(delegate, {
      type: "tool-call",
      toolName: "c",
    });

    expect(dropped).toBeNull();
    expect(recorder.events).toHaveLength(3);
    expect(recorder.eventsTruncated).toBe(true);
    expect(recorder.events[0].childrenTruncated).toBe(true);
  });

  it("drains an event once as an insert, then only its later changes as updates", () => {
    const { recorder, c } = recorderOf();

    const a = recorder.open(null, { type: "tool-call", toolName: "a" });
    const b = recorder.open(null, { type: "text" });
    c.tick(5);
    recorder.close(a!, { status: "completed" });

    // An event opened and closed inside one flush window is inserted in its
    // final state — never inserted running and then patched.
    const first = recorder.drain();
    expect(first.inserts.map((e) => [e.id, e.status])).toEqual([
      ["ev-1", "completed"],
      ["ev-2", "running"],
    ]);
    expect(first.updates).toEqual([]);

    expect(recorder.drain()).toEqual({ inserts: [], updates: [] });

    c.tick(7);
    recorder.close(b!, { status: "error", error: "boom" });
    const third = recorder.drain();
    expect(third.inserts).toEqual([]);
    expect(third.updates).toEqual([
      {
        id: "ev-2",
        status: "error",
        durationMs: 12,
        error: { message: "boom", truncated: false, originalBytes: 4 },
        childrenTruncated: false,
      },
    ]);
  });

  it("closes every still-open event with the given status", () => {
    const { recorder, c } = recorderOf();

    const done = recorder.open(null, { type: "reasoning" });
    recorder.close(done!, { status: "completed" });
    recorder.open(null, { type: "tool-call", toolName: "slow" });
    recorder.open(null, { type: "text" });
    c.tick(3);

    recorder.closeOpen("cancelled");

    expect(recorder.events.map((e) => e.status)).toEqual([
      "completed",
      "cancelled",
      "cancelled",
    ]);
    expect(recorder.events[1].durationMs).toBe(3);
  });

  it("closes only a delegate's own open children when scoped to it", () => {
    const { recorder } = recorderOf();

    const delegate = recorder.open(null, { type: "delegate", toolName: "R" });
    recorder.open(delegate, { type: "text" });
    recorder.open(null, { type: "text" });

    recorder.closeOpen("error", delegate);

    expect(recorder.events.map((e) => e.status)).toEqual([
      "running",
      "error",
      "running",
    ]);
  });

  it("tells its subscriber whenever something changed", () => {
    const { recorder } = recorderOf();
    const listener = vi.fn();
    recorder.subscribe(listener);

    const id = recorder.open(null, { type: "text" });
    recorder.close(id!, { status: "completed" });

    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("capRunEventError", () => {
  it("keeps a short error whole", () => {
    expect(capRunEventError("nope")).toEqual({
      message: "nope",
      truncated: false,
      originalBytes: 4,
    });
  });

  it("never splits a multi-byte character at the cap", () => {
    // 4-byte characters: 1024 is divisible by 4, so shift by one byte with an
    // ASCII prefix and the cap lands mid-character unless the cut respects it.
    const message = "x" + "𝄞".repeat(300);
    const capped = capRunEventError(message);

    expect(capped.truncated).toBe(true);
    expect(capped.originalBytes).toBe(1201);
    expect(capped.message).toBe("x" + "𝄞".repeat(255));
    expect(Buffer.byteLength(capped.message, "utf8")).toBe(1021);
  });
});

describe("recordUiChunk", () => {
  const scopeOf = (): { scope: RunEventScope; recorder: RunEventRecorder } => {
    const { recorder } = recorderOf();
    return { scope: { recorder, parentEventId: null }, recorder };
  };

  it("turns text and reasoning stretches into events opened at start and closed at end", () => {
    const { scope, recorder } = scopeOf();

    recordUiChunk(scope, { type: "reasoning-start", id: "r1" });
    recordUiChunk(scope, {
      type: "reasoning-delta",
      id: "r1",
      delta: "hmm",
    });
    recordUiChunk(scope, { type: "reasoning-end", id: "r1" });
    recordUiChunk(scope, { type: "text-start", id: "t1" });
    recordUiChunk(scope, {
      type: "text-delta",
      id: "t1",
      delta: "hi",
    });

    expect(recorder.events.map((e) => [e.type, e.status])).toEqual([
      ["reasoning", "completed"],
      ["text", "running"],
    ]);
  });

  it("opens a tool call when its input is complete and closes it on its output", () => {
    const { scope, recorder } = scopeOf();

    recordUiChunk(scope, {
      type: "tool-input-start",
      toolCallId: "tc1",
      toolName: "search",
    });
    expect(recorder.events).toHaveLength(0);

    recordUiChunk(scope, {
      type: "tool-input-available",
      toolCallId: "tc1",
      toolName: "search",
      input: { query: "secret things" },
    });
    recordUiChunk(scope, {
      type: "tool-output-available",
      toolCallId: "tc1",
      output: { huge: "x".repeat(10_000) },
    });

    expect(recorder.events).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolName: "search",
        status: "completed",
      }),
    ]);
    // Neither the input nor the output survives anywhere on the event.
    expect(JSON.stringify(recorder.events)).not.toContain("secret things");
    expect(JSON.stringify(recorder.events)).not.toContain("xxxxx");
  });

  it("records a tool error as a status with the error string", () => {
    const { scope, recorder } = scopeOf();

    recordUiChunk(scope, {
      type: "tool-input-available",
      toolCallId: "tc1",
      toolName: "search",
      input: {},
    });
    recordUiChunk(scope, {
      type: "tool-output-error",
      toolCallId: "tc1",
      errorText: "upstream 503",
    });

    expect(recorder.events[0]).toMatchObject({
      status: "error",
      error: { message: "upstream 503", truncated: false },
    });
  });

  // The model produced an input the tool could not take: the call never ran,
  // and that rejection is the failure the event records.
  it("records a tool call whose input was rejected as an error, never left running", () => {
    const { scope, recorder } = scopeOf();

    recordUiChunk(scope, {
      type: "tool-input-error",
      toolCallId: "tc1",
      toolName: "search",
      input: { query: "secret things" },
      errorText: "Invalid input for tool search",
    });

    expect(recorder.events).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolName: "search",
        status: "error",
        error: expect.objectContaining({
          message: "Invalid input for tool search",
          truncated: false,
        }) as unknown,
      }),
    ]);
    expect(JSON.stringify(recorder.events)).not.toContain("secret things");
  });

  it("keeps a tool call running through a preliminary output, and records a denied one as cancelled", () => {
    const { scope, recorder } = scopeOf();

    recordUiChunk(scope, {
      type: "tool-input-available",
      toolCallId: "tc1",
      toolName: "search",
      input: {},
    });
    recordUiChunk(scope, {
      type: "tool-output-available",
      toolCallId: "tc1",
      output: "working",
      preliminary: true,
    });
    expect(recorder.events[0].status).toBe("running");

    recordUiChunk(scope, { type: "tool-output-denied", toolCallId: "tc1" });
    expect(recorder.events[0].status).toBe("cancelled");
  });

  it("records a delegation as a delegate event named for its target", () => {
    const { scope, recorder } = scopeOf();

    recordUiChunk(scope, {
      type: "tool-input-available",
      toolCallId: "tc1",
      toolName: DELEGATE_TOOL_NAME,
      input: { subAgent: "Researcher", task: "find everything" },
    });

    expect(recorder.events[0]).toMatchObject({
      type: "delegate",
      toolName: "Researcher",
    });
    expect(JSON.stringify(recorder.events)).not.toContain("find everything");
  });
});

describe("wrapToolsWithRunEvents", () => {
  it("opens the tool's event before it runs and hands the tool its scope", async () => {
    const { recorder } = recorderOf();
    const scope: RunEventScope = { recorder, parentEventId: null };
    let seen: RunEventScope | undefined;
    const tools = {
      [DELEGATE_TOOL_NAME]: {
        inputSchema: {},
        execute: (_args: unknown, options: unknown) => {
          seen = runEventScopeOf(options);
          return Promise.resolve("ok");
        },
      },
    } as unknown as Record<string, Tool>;

    const wrapped = wrapToolsWithRunEvents(tools, scope);
    await (
      wrapped[DELEGATE_TOOL_NAME] as unknown as {
        execute: (a: unknown, o: unknown) => Promise<unknown>;
      }
    ).execute({ subAgent: "Researcher", task: "t" }, { toolCallId: "tc1" });

    expect(recorder.events).toEqual([
      expect.objectContaining({
        id: "ev-1",
        type: "delegate",
        toolName: "Researcher",
        status: "running",
      }),
    ]);
    expect(seen).toEqual({ recorder, parentEventId: "ev-1" });
  });

  it("shares the event the stream tap opened for the same tool call", () => {
    const { recorder } = recorderOf();
    const scope: RunEventScope = { recorder, parentEventId: null };
    const tools = {
      search: {
        inputSchema: {},
        execute: () => "ok",
      },
    } as unknown as Record<string, Tool>;

    recordUiChunk(scope, {
      type: "tool-input-available",
      toolCallId: "tc1",
      toolName: "search",
      input: {},
    });
    (
      wrapToolsWithRunEvents(tools, scope).search as unknown as {
        execute: (a: unknown, o: unknown) => unknown;
      }
    ).execute({}, { toolCallId: "tc1" });

    expect(recorder.events).toHaveLength(1);
  });

  it("leaves a tool without an execute alone", () => {
    const { recorder } = recorderOf();
    const tools = { providerSearch: { inputSchema: {} } } as unknown as Record<
      string,
      Tool
    >;

    const wrapped = wrapToolsWithRunEvents(tools, {
      recorder,
      parentEventId: null,
    });

    expect(wrapped.providerSearch).toBe(tools.providerSearch);
  });

  it("finds no scope on options a wrapper never touched", () => {
    expect(runEventScopeOf({ toolCallId: "tc1" })).toBeUndefined();
    expect(runEventScopeOf(undefined)).toBeUndefined();
  });
});
