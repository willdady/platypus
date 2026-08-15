import type { PlatypusUIMessage } from "../types.ts";
import type { ChatTurnRequest, ChatTurn } from "../services/chat-execution.ts";
import type { WorkspaceScope } from "../scope.ts";
import type { RunTimeouts } from "./run-registry.ts";

export type RunId = string;

/**
 * The run a sub-Agent delegation nests inside.
 *
 * A delegated run is a run in its own right — registry entry, timers,
 * statistics — so it has to say whose child it is (`workspaceScopeForSubAgent`
 * chains the principal), inherit the bounds the parent was started under rather
 * than the process defaults, and be cancelled when the parent is.
 */
export type ParentRunContext = {
  runId: RunId;
  scope: WorkspaceScope;
  timeouts?: RunTimeouts;
};

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

export type RunStats = {
  steps?: number;
  toolCalls?: Array<{ name: string; count: number }>;
  /** Cross-step SUMS of every step's usage — billing figures, not occupancy. */
  inputTokens?: number;
  outputTokens?: number;
  /**
   * How full the model's context got: the input tokens reported for the LAST
   * step, which is the whole conversation as last sent (ADR-0018). A last
   * value, never a sum — `inputTokens` above folds every step together and on a
   * long tool-using turn reads roughly an order of magnitude high.
   *
   * Absent where the Provider reported no usage. Nothing is estimated, and 0 is
   * never substituted: it would read as a measurement of an empty context.
   */
  contextOccupancy?: number;
  /**
   * Set only when the run stopped at the model's output ceiling. Absent rather
   * than `false`, mirroring the Chat message metadata marker.
   */
  truncatedByTokenLimit?: true;
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
