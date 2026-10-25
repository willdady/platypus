import type { ModelMessage, Tool, ToolApprovalStatus } from "ai";
import type {
  ReadOnlyHint,
  ToolGateCall,
  ToolGateOptions,
  ToolGateVerdict,
} from "@platypuschat/plugin-sdk";
import { logger } from "../logger.ts";
import { createContributionRegistry } from "../registry/contribution-registry.ts";
import { DeadlineExceededError, withDeadline } from "../utils/abort-race.ts";
import { errorMessage } from "../utils/error-message.ts";

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
    const reason =
      typeof answer.reason === "string" && answer.reason.trim()
        ? `: ${answer.reason.trim()}`
        : ".";
    return verdict === "ask"
      ? {
          verdict,
          reason: `The "${gate.name}" Tool gate wants a person to approve this call, and no one can approve it here${reason}`,
          ask: `The "${gate.name}" Tool gate wants a person to approve this call${reason}`,
        }
      : { verdict, reason: `Blocked by the "${gate.name}" Tool gate${reason}` };
  } catch (error) {
    logger.warn(
      { err: error, toolGate: gate.id, toolName: call.toolName },
      "Tool gate failed to answer; the call is not run",
    );
    const failure =
      error instanceof DeadlineExceededError
        ? `The "${gate.name}" Tool gate did not answer within ${gate.timeoutMs}ms`
        : `The "${gate.name}" Tool gate failed (${errorMessage(error)})`;
    return {
      verdict: "ask",
      reason: `${failure}, so the call was not run.`,
      ask: `${failure}.`,
    };
  }
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
          const description = tools?.[toolCall.toolName]?.description;
          const call: ToolGateCall = {
            toolName: toolCall.toolName,
            ...(typeof description === "string"
              ? { toolDescription: description }
              : {}),
            args: toolCall.input,
            ...(scope.toolSetIds.has(toolCall.toolName)
              ? { toolSetId: scope.toolSetIds.get(toolCall.toolName) }
              : {}),
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            ...(scope.agentId !== undefined ? { agentId: scope.agentId } : {}),
            attended: scope.attended,
            readOnlyHint:
              scope.readOnlyHints.get(toolCall.toolName) ?? "undeclared",
          };
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
