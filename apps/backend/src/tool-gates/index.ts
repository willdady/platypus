import type { ModelMessage, Tool, ToolApprovalStatus } from "ai";
import type {
  ReadOnlyHint,
  ToolGateCall,
  ToolGateOptions,
  ToolGateVerdict,
  ToolResultVerdict,
} from "@platypuschat/plugin-sdk";
import { logger } from "../logger.ts";
import { createContributionRegistry } from "../registry/contribution-registry.ts";
import { DeadlineExceededError, withDeadline } from "../utils/abort-race.ts";
import { errorMessage } from "../utils/error-message.ts";
import {
  isAsyncIterable,
  isThenable,
  wrapToolExecutes,
} from "../utils/tool-execution.ts";

export const DEFAULT_TOOL_GATE_TIMEOUT_MS = 10_000;
export const MAX_TOOL_GATE_TIMEOUT_MS = 30_000;

export type ToolGateRegistration = {
  id: string;
  name: string;
  timeoutMs: number;
  evaluate: (
    call: ToolGateCall,
    options: ToolGateOptions,
  ) => ToolGateVerdict | Promise<ToolGateVerdict>;
  evaluateResult?: (
    call: ToolGateCall,
    result: unknown,
    options: ToolGateOptions,
  ) => ToolResultVerdict | Promise<ToolResultVerdict>;
};

type ResultGate = ToolGateRegistration & {
  evaluateResult: NonNullable<ToolGateRegistration["evaluateResult"]>;
};

const TOOL_GATES = createContributionRegistry<ToolGateRegistration>({
  noun: "Tool gate",
});

export const registerToolGate = (registration: ToolGateRegistration): void => {
  TOOL_GATES.register(registration.id, registration);
};

export const getToolGates = (): readonly ToolGateRegistration[] =>
  TOOL_GATES.list();

export const clearToolGates = (): void => TOOL_GATES.clear();

export type ToolGateScope = {
  orgId: string;
  workspaceId: string;
  agentId?: string;
  attended: boolean;
  toolSetIds: ReadonlyMap<string, string>;
  readOnlyHints: ReadonlyMap<string, Exclude<ReadOnlyHint, "undeclared">>;
};

type Decision = {
  verdict: ToolGateVerdict["verdict"];
  reason: string;
  ask?: string;
};

type ResultDecision = { allowed: true } | { allowed: false; reason: string };

const RANK = { allow: 0, ask: 1, deny: 2 } as const;

const gateFailure = (
  gate: Pick<ToolGateRegistration, "id" | "name" | "timeoutMs">,
  error: unknown,
  toolName: string,
  message: string,
): string => {
  logger.warn({ err: error, toolGate: gate.id, toolName }, message);
  return error instanceof DeadlineExceededError
    ? `did not answer within ${gate.timeoutMs}ms`
    : `failed (${errorMessage(error)})`;
};

const runGate = async (
  gate: ToolGateRegistration,
  call: ToolGateCall,
  signal: AbortSignal,
): Promise<Decision> => {
  try {
    const answer = await withDeadline(
      (deadline) => gate.evaluate(call, { signal: deadline }),
      gate.timeoutMs,
      signal,
    );
    const verdict = (answer as Partial<ToolGateVerdict> | undefined)?.verdict;
    if (verdict !== "allow" && verdict !== "ask" && verdict !== "deny") {
      throw new Error(`returned ${JSON.stringify(verdict)}, not a Verdict`);
    }
    const given = typeof answer.reason === "string" ? answer.reason.trim() : "";
    const reason = given ? `: ${given}` : ".";
    return verdict === "ask"
      ? {
          verdict,
          reason: `The "${gate.name}" Tool gate wants a person to approve this call, and no one can approve it here${reason}`,
          ask:
            given ||
            `The "${gate.name}" Tool gate wants a person to approve this call.`,
        }
      : { verdict, reason: `Blocked by the "${gate.name}" Tool gate${reason}` };
  } catch (error) {
    const failure = `The "${gate.name}" Tool gate ${gateFailure(
      gate,
      error,
      call.toolName,
      "Tool gate failed to answer; the call is not run",
    )}`;
    return {
      verdict: "ask",
      reason: `${failure}, so the call was not run.`,
      ask: `${failure}.`,
    };
  }
};

const runResultGate = async (
  gate: ResultGate,
  call: ToolGateCall,
  result: unknown,
  signal: AbortSignal,
): Promise<ResultDecision> => {
  try {
    const answer = await withDeadline(
      (deadline) => gate.evaluateResult(call, result, { signal: deadline }),
      gate.timeoutMs,
      signal,
    );
    const verdict = (answer as Partial<ToolResultVerdict> | undefined)?.verdict;
    if (verdict !== "allow" && verdict !== "deny") {
      throw new Error(
        `returned ${JSON.stringify(verdict)}, not a Result Verdict`,
      );
    }
    if (verdict === "allow") return { allowed: true };
    const given = typeof answer.reason === "string" ? answer.reason.trim() : "";
    return {
      allowed: false,
      reason: `The tool ran, but the "${gate.name}" Tool gate withheld its result${given ? `: ${given}` : "."}`,
    };
  } catch (error) {
    const failure = gateFailure(
      gate,
      error,
      call.toolName,
      "Tool gate failed to vet a tool result; the result is withheld",
    );
    return {
      allowed: false,
      reason: `The tool ran, but the "${gate.name}" Tool gate ${failure}, so its result was withheld.`,
    };
  }
};

const runResultGates = async (
  gates: readonly ResultGate[],
  call: ToolGateCall,
  result: unknown,
  signal: AbortSignal,
): Promise<ResultDecision> => {
  const decisions = await Promise.all(
    gates.map((gate) => runResultGate(gate, call, result, signal)),
  );
  return decisions.find((decision) => !decision.allowed) ?? { allowed: true };
};

const toGateCall = (
  scope: ToolGateScope,
  toolName: string,
  tool: Tool | undefined,
  args: unknown,
): ToolGateCall => {
  const description = tool?.description;
  return {
    toolName,
    ...(typeof description === "string"
      ? { toolDescription: description }
      : {}),
    args,
    ...(scope.toolSetIds.has(toolName)
      ? { toolSetId: scope.toolSetIds.get(toolName) }
      : {}),
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    ...(scope.agentId !== undefined ? { agentId: scope.agentId } : {}),
    attended: scope.attended,
    readOnlyHint: scope.readOnlyHints.get(toolName) ?? "undeclared",
  };
};

type ApprovalRequest = {
  toolCall: {
    toolCallId: string;
    toolName: string;
    input: unknown;
    providerExecuted?: boolean;
  };
  tools: Record<string, Tool> | undefined;
  messages: ModelMessage[];
};

const approvedByUser = (
  toolCallId: string,
  messages: ModelMessage[],
): boolean => {
  const requested = new Set<string>();
  const approved = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (
        part.type === "tool-approval-request" &&
        part.toolCallId === toolCallId
      ) {
        requested.add(part.approvalId);
      } else if (part.type === "tool-approval-response" && part.approved) {
        approved.add(part.approvalId);
      }
    }
  }
  return [...requested].some((id) => approved.has(id));
};

export const toolGateOptions = (
  scope: ToolGateScope | undefined,
  signal: AbortSignal,
): {
  toolApproval?: (request: ApprovalRequest) => Promise<ToolApprovalStatus>;
} => {
  const gates = getToolGates();
  return gates.length === 0
    ? {}
    : {
        toolApproval: async ({ toolCall, tools, messages }) => {
          if (toolCall.providerExecuted) return undefined;
          if (approvedByUser(toolCall.toolCallId, messages)) return "approved";
          if (!scope) {
            return {
              type: "denied",
              reason: "No Tool gate could vet this call, so it was not run.",
            };
          }
          const call = toGateCall(
            scope,
            toolCall.toolName,
            tools?.[toolCall.toolName],
            toolCall.input,
          );
          const decisions = await Promise.all(
            gates.map((gate) => runGate(gate, call, signal)),
          );
          const decision = decisions.reduce((worst, next) =>
            RANK[next.verdict] > RANK[worst.verdict] ? next : worst,
          );
          if (decision.verdict === "allow") return undefined;
          return decision.verdict === "ask" && scope.attended
            ? { type: "user-approval", reason: decision.ask }
            : { type: "denied", reason: decision.reason };
        },
      };
};

type ResultStage = {
  scope: ToolGateScope;
  gates: readonly ResultGate[];
  signal: AbortSignal;
};

const gateOneResult = async (
  { scope, gates, signal }: ResultStage,
  toolName: string,
  tool: Tool,
  args: unknown,
  result: unknown,
): Promise<void> => {
  const decision = await runResultGates(
    gates,
    toGateCall(scope, toolName, tool, args),
    result,
    signal,
  );
  if (!decision.allowed) throw new Error(decision.reason);
};

const vetError = async (
  vet: (result: unknown) => Promise<void>,
  error: unknown,
): Promise<never> => {
  await vet(errorMessage(error));
  throw error;
};

const gateResultStream = (
  stream: AsyncIterable<unknown>,
  vet: (result: unknown) => Promise<void>,
): AsyncGenerator<unknown> =>
  (async function* () {
    let pending: unknown;
    let hasPending = false;
    try {
      for await (const value of stream) {
        if (hasPending) yield pending;
        pending = value;
        hasPending = true;
      }
    } catch (error) {
      if (hasPending) yield pending;
      return await vetError(vet, error);
    }
    if (!hasPending) return;
    await vet(pending);
    yield pending;
  })();

export const wrapToolsWithToolResultGate = (
  tools: Record<string, Tool>,
  scope: ToolGateScope | undefined,
  signal: AbortSignal,
): Record<string, Tool> => {
  const gates = getToolGates().filter(
    (gate): gate is ResultGate => typeof gate.evaluateResult === "function",
  );
  if (gates.length === 0 || !scope) return tools;

  const stage: ResultStage = { scope, gates, signal };
  return wrapToolExecutes(
    tools,
    (runExecute, tool, name) => (args, options) => {
      const vet = (result: unknown) =>
        gateOneResult(stage, name, tool, args, result);
      let result: unknown;
      try {
        result = runExecute.call(tool, args, options);
      } catch (error) {
        return vetError(vet, error);
      }
      if (isThenable(result)) {
        // why: two-argument then, so a denial thrown by vet is not vetted again
        return result.then(
          async (value) => {
            await vet(value);
            return value;
          },
          (error: unknown) => vetError(vet, error),
        );
      }
      if (isAsyncIterable(result)) return gateResultStream(result, vet);
      return vet(result).then(() => result);
    },
  );
};
