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

// The Tool gate (ADR-0033): every enabled gate sees every locally-executed
// tool call before it runs, through the one seam all three Drives share — the
// AI SDK's `toolApproval` hook on `buildModelInvocation`. Core owns the rules a
// gate cannot be trusted to keep: the timeout, failing closed, combining
// several gates, asking the User where one is watching, turning `ask` into
// `deny` where no one can be asked, and never re-vetting an approved call.

// The default applies when a contribution omits `timeoutMs`; the ceiling is
// refused at boot by the plugin loader, as the Web-search backend's is. A gate
// sits on every tool call, so its ceiling is a quarter of a web backend's.
export const DEFAULT_TOOL_GATE_TIMEOUT_MS = 10_000;
export const MAX_TOOL_GATE_TIMEOUT_MS = 30_000;

/** What core registers for one gate: its plugin config already bound in. */
export type ToolGateRegistration = {
  id: string;
  name: string;
  timeoutMs: number;
  evaluate: (
    call: ToolGateCall,
    options: ToolGateOptions,
  ) => ToolGateVerdict | Promise<ToolGateVerdict>;
  /** The optional after-call stage; absent on a gate that only vets calls. */
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

/** Every registered gate, in registration order. */
export const getToolGates = (): readonly ToolGateRegistration[] =>
  TOOL_GATES.list();

/** Test-only reset — see {@link createContributionRegistry}. */
export const clearToolGates = (): void => TOOL_GATES.clear();

/**
 * What a run's gates are told about where a call is made, beyond the call
 * itself. Built by the Tool session that resolved the run's tools, so a
 * Sub-Agent's scope is its own nested session's.
 */
export type ToolGateScope = {
  orgId: string;
  workspaceId: string;
  agentId?: string;
  /** A User is watching: a top-level, interactive Chat turn. */
  attended: boolean;
  /** Tool name → the Tool set or MCP it came from. */
  toolSetIds: ReadonlyMap<string, string>;
  /** Tool name → its declared hint. A name absent here declared nothing. */
  readOnlyHints: ReadonlyMap<string, Exclude<ReadOnlyHint, "undeclared">>;
};

type Decision = {
  verdict: ToolGateVerdict["verdict"];
  /** Why the call was not run, as the model is told it. */
  reason: string;
  /** For an `ask`: what a User asked to approve the call is shown. */
  ask?: string;
};

const RANK = { allow: 0, ask: 1, deny: 2 } as const;

/**
 * Log a gate's failure and phrase it for the model, uncapitalised so callers
 * can slot it into their own sentence. Used by both stages: a timeout and a
 * throw are the same fact before and after a call.
 */
const gateFailure = (
  gate: Pick<ToolGateRegistration, "id" | "name" | "timeoutMs">,
  error: unknown,
  toolName: string,
  message: string,
): string => {
  logger.warn({ err: error, toolGate: gate.id, toolName }, message);
  return error instanceof DeadlineExceededError
    ? `the "${gate.name}" Tool gate did not answer within ${gate.timeoutMs}ms`
    : `the "${gate.name}" Tool gate failed (${errorMessage(error)})`;
};

const sentence = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

// One gate's answer, in core's terms. Anything a gate cannot vouch for is
// `ask`: a throw, a timeout, or an answer that is not a Verdict at all.
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
          // The User is shown the gate's own words, when it gave any.
          ask:
            given ||
            `The "${gate.name}" Tool gate wants a person to approve this call.`,
        }
      : { verdict, reason: `Blocked by the "${gate.name}" Tool gate${reason}` };
  } catch (error) {
    const failure = sentence(
      gateFailure(
        gate,
        error,
        call.toolName,
        "Tool gate failed to answer; the call is not run",
      ),
    );
    return {
      verdict: "ask",
      reason: `${failure}, so the call was not run.`,
      ask: `${failure}.`,
    };
  }
};

/**
 * One gate's answer about a result, in core's terms. Anything a gate cannot
 * vouch for is a denial: a throw, a timeout, or an answer that is not a result
 * Verdict at all. There is no `ask`, because the tool already ran.
 */
const runResultGate = async (
  gate: ResultGate,
  call: ToolGateCall,
  result: unknown,
  signal: AbortSignal,
): Promise<{ allowed: true } | { allowed: false; reason: string }> => {
  try {
    const answer = await withDeadline(
      (deadline) => gate.evaluateResult(call, result, { signal: deadline }),
      gate.timeoutMs,
      signal,
    );
    const verdict = (answer as Partial<ToolResultVerdict> | undefined)?.verdict;
    if (verdict !== "allow" && verdict !== "deny") {
      throw new Error(
        `returned ${JSON.stringify(verdict)}, not a result Verdict`,
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
      reason: `The tool ran, but ${failure}, so its result was withheld.`,
    };
  }
};

/**
 * Ask every result-evaluating gate about one result, in parallel. Any denial
 * wins, and the first in registration order supplies the reason the model and
 * the User are given.
 */
const runResultGates = async (
  gates: readonly ResultGate[],
  call: ToolGateCall,
  result: unknown,
  signal: AbortSignal,
): Promise<{ allowed: true } | { allowed: false; reason: string }> => {
  const decisions = await Promise.all(
    gates.map((gate) => runResultGate(gate, call, result, signal)),
  );
  const denied = decisions.find(
    (decision): decision is { allowed: false; reason: string } =>
      !decision.allowed,
  );
  return denied ?? { allowed: true };
};

/**
 * The {@link ToolGateCall} a call is described by, for either stage. Reads the
 * description off the tool itself, because the result stage has no request
 * carrying one.
 */
const gateCall = (
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

/**
 * Whether the User has already approved this call: the SDK hands the hook
 * every approved call again before running it, with the Transcript holding
 * the request and its answer. Tool call ids are unique per call, so a call
 * being vetted for the first time never matches. The Transcript is the
 * server's own rows (ADR-0026), so a client cannot forge an approval.
 */
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

/**
 * The `toolApproval` option for one run's model invocation, or nothing when no
 * gate is enabled — so a deployment without gates sends exactly the request it
 * always did.
 *
 * An `allow` is `not-applicable` rather than `approved`: an approved call would
 * put approval parts on the stream, and an allow is recorded nowhere.
 */
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
          // Never reached the backend, so nothing here can stop it (ADR-0033).
          if (toolCall.providerExecuted) return undefined;
          // A User's approval is final: no gate re-vets the call it approved.
          if (approvedByUser(toolCall.toolCallId, messages)) return "approved";
          // Every plan core builds carries a scope; one that doesn't cannot be
          // vetted, and an unvetted call does not run.
          if (!scope) {
            return {
              type: "denied",
              reason: "No Tool gate could vet this call, so it was not run.",
            };
          }
          const call = gateCall(
            scope,
            toolCall.toolName,
            tools?.[toolCall.toolName],
            toolCall.input,
          );
          const decisions = await Promise.all(
            gates.map((gate) => runGate(gate, call, signal)),
          );
          // The first of the most restrictive, so its reason is the one given.
          const decision = decisions.reduce((worst, next) =>
            RANK[next.verdict] > RANK[worst.verdict] ? next : worst,
          );
          if (decision.verdict === "allow") return undefined;
          // Only a watching User can be asked; anywhere else `ask` is `deny`.
          // The SDK stops the turn at the end of the step to ask.
          return decision.verdict === "ask" && scope.attended
            ? { type: "user-approval", reason: decision.ask }
            : { type: "denied", reason: decision.reason };
        },
      };
};

/** Everything the result stage needs about one run, carried as a value. */
type ResultStage = {
  scope: ToolGateScope | undefined;
  gates: readonly ResultGate[];
  signal: AbortSignal;
};

/** Vet one result against every result gate, throwing the first denial. */
const gateOneResult = async (
  { scope, gates, signal }: ResultStage,
  toolName: string,
  tool: Tool,
  args: unknown,
  result: unknown,
): Promise<void> => {
  // A plan with no scope cannot describe its calls to a gate. The before-call
  // stage already refused the call, so this only fires for a result produced
  // ahead of that seam; it fails closed too.
  if (!scope) {
    throw new Error(
      "The tool ran, but no Tool gate could vet its result, so its result was withheld.",
    );
  }
  const decision = await runResultGates(
    gates,
    gateCall(scope, toolName, tool, args),
    result,
    signal,
  );
  if (!decision.allowed) throw new Error(decision.reason);
};

/**
 * A streaming tool's result while it is withheld from the model until the gate
 * answers. Every yield but the last is preliminary activity the UI may show;
 * the last is the value the model receives, so it is held back until it is
 * vetted and dropped entirely if the gate denies it. Holding one yield back is
 * what makes the last one provably not final: it is released only once a later
 * yield exists.
 */
const gateResultStream = (
  stream: AsyncIterable<unknown>,
  vet: (result: unknown) => Promise<void>,
): AsyncGenerator<unknown> =>
  (async function* () {
    let pending: unknown;
    let hasPending = false;
    for await (const value of stream) {
      if (hasPending) yield pending;
      pending = value;
      hasPending = true;
    }
    // A generator that yielded nothing produced no result to withhold.
    if (!hasPending) return;
    await vet(pending);
    yield pending;
  })();

/**
 * The after-call stage of the Tool gate (ADR-0033), applied to every locally
 * executed tool at the model-invocation seam all Drives share — so no Drive can
 * miss it and a Provider-executed tool (which has no `execute`) is untouched.
 *
 * Returns `tools` itself when no gate declares a result stage, so a deployment
 * without one sends exactly the tools it always did.
 */
export const wrapToolsWithToolResultGate = (
  tools: Record<string, Tool>,
  scope: ToolGateScope | undefined,
  signal: AbortSignal,
): Record<string, Tool> => {
  const gates = getToolGates().filter(
    (gate): gate is ResultGate => typeof gate.evaluateResult === "function",
  );
  if (gates.length === 0) return tools;

  const stage: ResultStage = { scope, gates, signal };
  return wrapToolExecutes(
    tools,
    (runExecute, tool, name) => (args, options) => {
      const vet = (result: unknown) =>
        gateOneResult(stage, name, tool, args, result);
      const result = runExecute.call(tool, args, options);
      if (isThenable(result)) {
        return result.then(async (value) => {
          await vet(value);
          return value;
        });
      }
      if (isAsyncIterable(result)) return gateResultStream(result, vet);
      return vet(result).then(() => result);
    },
  );
};
