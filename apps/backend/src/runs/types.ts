import type { PlatypusUIMessage } from "../types.ts";
import type { ChatTurn } from "../services/chat-execution.ts";

export type RunId = string;

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

export type RunStats = {
  steps?: number;
  toolCalls?: Array<{ name: string; count: number }>;
  inputTokens?: number;
  outputTokens?: number;
};

/**
 * Identifies the source of model + agent configuration for a run.
 *
 * - `agent`: load agent record by ID; tools, model, system prompt and
 *   generation defaults derive from the agent.
 * - `adhoc`: caller supplies provider + model directly with no agent. No
 *   tools or skills are loaded; system prompt and generation come entirely
 *   from request overrides.
 */
export type RunInputSource =
  | { kind: "agent"; agentId: string }
  | {
      kind: "adhoc";
      providerId: string;
      modelId: string;
      systemPrompt?: string;
    };

export type RunInputOverrides = {
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  search?: boolean;
};

export type RunInput = {
  runId: RunId;
  source: RunInputSource;
  messages: PlatypusUIMessage[];
  overrides?: RunInputOverrides;
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
  onStart(ctx: { runId: RunId }): Promise<void>;
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
