import type { PlatypusUIMessage } from "../types.ts";
import type {
  CachedInputTokens,
  ConcreteModelId,
  ReasoningEffort,
  ModelSwitch,
  ModelUsage,
  TranscriptSummaryRow,
  UnloadedToolSet,
} from "@platypus/schemas";
import type { WorkspaceScope } from "../scope.ts";
import type { RunTimeouts } from "./run-registry.ts";
import type { RunEventRecorder } from "./run-events.ts";
import type { GenerationField, RunPlan } from "./run-plan.ts";

export type RunId = string;

export type ChatTurnRequest = {
  agentId?: string;
  providerId?: string;
  modelId?: string;
  search?: boolean;
  instructions?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  reasoningThinking?: boolean | null;
  reasoningEffort?: ReasoningEffort | null;
  thinkingBudget?: number | null;
  maxSteps?: number | null;
};

export type ParentRunContext = {
  runId: RunId;
  scope: WorkspaceScope;
  timeouts?: RunTimeouts;
  setDelegateUsage: (delegateRunId: RunId, stats: RunStats) => void;
};

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

export type FallbackTurn = {
  plan: Pick<RunPlan, Exclude<GenerationField, "system">>;
  system: string;
};

export type RunStats = {
  steps?: number;
  toolCalls?: Array<{ name: string; count: number }>;
  inputTokens?: number;
  outputTokens?: number;
  usageByModel?: ModelUsage[];
  contextOccupancy?: number;
  truncatedByTokenLimit?: true;
  stoppedAtStepLimit?: true;
  fallback?: ModelSwitch;
} & CachedInputTokens;

export type TurnRequest = {
  request: ChatTurnRequest;
  messages: PlatypusUIMessage[];
  chatSummaries?: TranscriptSummaryRow[];
  memorySnapshot?: string;
  memoriesReferenceDate: Date;
  includeMemories: boolean;
  memoryTools: boolean;
};

export type RunInput = {
  runId: RunId;
  turnId?: string;
} & TurnRequest;

export type TurnFacts = {
  agentId?: string;
  searchUnavailable?: boolean;
  prepDurationMs?: number;
  summaryId?: string;
};

export type ResolvedGeneration = {
  agentId?: string;
  providerId: string;
  modelId: string;
  instructions?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  reasoningThinking?: boolean;
  reasoningEffort?: ReasoningEffort;
  thinkingBudget?: number;
  maxSteps?: number;
};

export type ResolvedRunPlan = {
  resolved: ResolvedGeneration;
  resolvedModelId: ConcreteModelId;
  unloadedToolSets?: readonly UnloadedToolSet[];
  contextWindow?: number;
  readOnlyToolNames?: ReadonlySet<string>;
};

export interface RunSink {
  onStart(ctx: {
    runId: RunId;
    messages: PlatypusUIMessage[];
    memorySnapshot?: string;
    events?: RunEventRecorder;
  }): Promise<void>;
  onResolved(ctx: { runId: RunId; plan: ResolvedRunPlan }): Promise<void>;
  onProgress(ctx: {
    runId: RunId;
    messages: PlatypusUIMessage[];
    stats: RunStats;
  }): Promise<void>;
  onOutput?(ctx: {
    runId: RunId;
    messages: PlatypusUIMessage[];
  }): Promise<void>;
  onFinish(ctx: {
    runId: RunId;
    status: RunStatus;
    messages: PlatypusUIMessage[];
    stats: RunStats;
    error?: Error;
    finalText?: string;
  }): Promise<void>;
}
