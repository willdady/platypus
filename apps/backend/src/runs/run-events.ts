import { randomUUID } from "node:crypto";
import type { InferUIMessageChunk, Tool } from "ai";
import {
  RUN_EVENT_ERROR_MAX_BYTES,
  type ModelSwitch,
  type RunEvent,
  type RunEventError,
  type RunEventStatus,
  type RunEventType,
} from "@platypus/schemas";
import type { PlatypusUIMessage } from "../types.ts";
import { storable } from "../utils/storable.ts";
import type { RunStatus } from "./types.ts";
import { DELEGATE_TOOL_NAME } from "../tools/turn-tool-names.ts";

const RUN_EVENT_CEILING = 10_000;

export type RunEventScope = {
  recorder: RunEventRecorder;
  parentEventId: string | null;
};

export type RunEventClocks = {
  now: () => number;
  monotonic: () => number;
};

export type RunEventPatch = Pick<
  RunEvent,
  "id" | "status" | "durationMs" | "error" | "childrenTruncated"
>;

export type RunEventBatch = { inserts: RunEvent[]; updates: RunEventPatch[] };

type OpenSpec = {
  type: RunEventType;
  toolName?: string;
  modelSwitch?: ModelSwitch;
};
type CloseSpec = { status: Exclude<RunEventStatus, "running">; error?: string };

export const capRunEventError = (error: string): RunEventError => {
  const message = storable(error);
  const originalBytes = Buffer.byteLength(message, "utf8");
  if (originalBytes <= RUN_EVENT_ERROR_MAX_BYTES) {
    return { message, truncated: false, originalBytes };
  }
  let bytes = 0;
  let preview = "";
  for (const char of message) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > RUN_EVENT_ERROR_MAX_BYTES) break;
    bytes += size;
    preview += char;
  }
  return { message: preview, truncated: true, originalBytes };
};

type Recorded = { event: RunEvent; monoStart: number };

export class RunEventRecorder {
  readonly runId: string;
  private readonly ceiling: number;
  private readonly clocks: RunEventClocks;
  private readonly generateId: () => string;
  private readonly records: Recorded[] = [];
  private readonly byId = new Map<string, Recorded>();
  private readonly byKey = new Map<string, string>();
  private pendingInsert = new Set<string>();
  private pendingUpdate = new Set<string>();
  private readonly approvalToolKeys = new Map<string, string>();
  private truncated = false;
  private failedCalls = 0;
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

  get events(): readonly RunEvent[] {
    return this.records.map((r) => r.event);
  }

  get eventsTruncated(): boolean {
    return this.truncated;
  }

  get failedToolCalls(): number {
    return this.failedCalls;
  }

  subscribe(listener: () => void): void {
    this.listener = listener;
  }

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
      toolName: spec.toolName === undefined ? null : storable(spec.toolName),
      startedAt: this.clocks.now(),
      durationMs: null,
      status: "running",
      error: null,
      modelSwitch: spec.modelSwitch ?? null,
      childrenTruncated: false,
    };
    const recorded = { event, monoStart: this.clocks.monotonic() };
    this.records.push(recorded);
    this.byId.set(id, recorded);
    this.pendingInsert.add(id);
    this.listener?.();
    return id;
  }

  noteApproval(approvalId: string, key: string): void {
    this.approvalToolKeys.set(approvalId, key);
  }

  closeDenied(approvalId: string, reason: string | undefined): void {
    const key = this.approvalToolKeys.get(approvalId);
    if (key) {
      this.closeKeyed(key, {
        status: "cancelled",
        ...(reason !== undefined ? { error: reason } : {}),
      });
    }
  }

  close(id: string, spec: CloseSpec): void {
    const recorded = this.byId.get(id);
    if (!recorded || recorded.event.status !== "running") return;
    this.settle(recorded, spec);
    this.listener?.();
  }

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

  closeKeyed(key: string, spec: CloseSpec): void {
    const id = this.byKey.get(key);
    if (id) this.close(id, spec);
  }

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

  drain(): RunEventBatch {
    const inserts: RunEvent[] = [];
    for (const id of this.pendingInsert) {
      const recorded = this.byId.get(id);
      if (recorded) inserts.push({ ...recorded.event });
    }
    const updates: RunEventPatch[] = [];
    for (const id of this.pendingUpdate) {
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

  requeue(batch: RunEventBatch): void {
    for (const { id } of batch.inserts) {
      this.pendingInsert.add(id);
      this.pendingUpdate.delete(id);
    }
    for (const { id } of batch.updates) this.markChanged(id);
  }

  private settle(recorded: Recorded, spec: CloseSpec): void {
    recorded.event.status = spec.status;
    if (
      spec.status === "error" &&
      (recorded.event.type === "tool-call" ||
        recorded.event.type === "delegate")
    ) {
      this.failedCalls++;
    }
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

const toolKey = (scope: RunEventScope, toolCallId: string): string =>
  `${scope.parentEventId ?? "root"}:tool:${toolCallId}`;

const stretchKey = (
  scope: RunEventScope,
  kind: "text" | "reasoning" | "tool-input",
  id: string,
): string => `${scope.parentEventId ?? "root"}:${kind}:${id}`;

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
    case "tool-input-start":
      recorder.openKeyed(
        stretchKey(scope, "tool-input", chunk.toolCallId),
        parentEventId,
        { type: "tool-input", toolName: chunk.toolName },
      );
      return;
    case "tool-input-available":
      recorder.closeKeyed(stretchKey(scope, "tool-input", chunk.toolCallId), {
        status: "completed",
      });
      recorder.openKeyed(
        toolKey(scope, chunk.toolCallId),
        parentEventId,
        toolSpec(chunk.toolName, chunk.input),
      );
      return;
    case "tool-input-error":
      recorder.closeKeyed(stretchKey(scope, "tool-input", chunk.toolCallId), {
        status: "error",
        error: chunk.errorText,
      });
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
    case "tool-approval-request":
      recorder.noteApproval(chunk.approvalId, toolKey(scope, chunk.toolCallId));
      return;
    case "tool-approval-response":
      if (!chunk.approved) recorder.closeDenied(chunk.approvalId, chunk.reason);
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

const RUN_EVENT_SCOPE: unique symbol = Symbol("platypus.runEventScope");

type ScopedOptions = { [RUN_EVENT_SCOPE]?: RunEventScope };

const optionsRecord = (
  options: unknown,
): (Record<string, unknown> & ScopedOptions) | undefined =>
  typeof options === "object" && options !== null
    ? (options as Record<string, unknown> & ScopedOptions)
    : undefined;

export const runEventScopeOf = (options: unknown): RunEventScope | undefined =>
  optionsRecord(options)?.[RUN_EVENT_SCOPE];

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
