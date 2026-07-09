import type { PlatypusUIMessage } from "../types.ts";
import type { ChatTurnRequest, ChatTurn } from "../services/chat-execution.ts";

export type RunId = string;

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

export type RunStats = {
  steps?: number;
  toolCalls?: Array<{ name: string; count: number }>;
  inputTokens?: number;
  outputTokens?: number;
};

/**
 * Inputs for a single run. `request` is the same shape `prepareChatTurn`
 * expects: agent or direct provider/model selection, plus optional
 * generation overrides (temperature, topP, seed, etc.) and search flag.
 */
export type RunInput = {
  runId: RunId;
  request: ChatTurnRequest;
  messages: PlatypusUIMessage[];
};

/**
 * The fully-resolved plan for a run. Mirrors `ChatTurn["resolved"]` —
 * already does agent-vs-direct nulling, so sinks just map fields to their
 * persistence schema.
 */
export type ResolvedRunPlan = {
  resolved: ChatTurn["resolved"];
};

/**
 * Lifecycle events for a run. Sinks decide their own write cadence.
 *
 * - `onStart` fires exactly once, before any plan resolution. Sinks that
 *   need a row to exist for *all* terminal outcomes (including resolution
 *   failures) should write it here.
 * - `onResolved` fires once after the plan is resolved and just before
 *   model execution. Skipped if `prepare()` throws — `onFinish` fires.
 * - `onProgress` cadence is currently absent; PR #3 introduces time-based
 *   flushing controlled by the sink.
 * - `onFinish` fires exactly once at termination (any status), including
 *   resolution failures.
 */
export interface RunSink {
  onStart(ctx: { runId: RunId; messages: PlatypusUIMessage[] }): Promise<void>;
  onResolved(ctx: { runId: RunId; plan: ResolvedRunPlan }): Promise<void>;
  onProgress(ctx: {
    runId: RunId;
    messages: PlatypusUIMessage[];
    stats: RunStats;
  }): Promise<void>;
  onFinish(ctx: {
    runId: RunId;
    status: RunStatus;
    messages: PlatypusUIMessage[];
    stats: RunStats;
    error?: Error;
  }): Promise<void>;
}
