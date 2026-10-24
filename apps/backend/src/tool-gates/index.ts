import type { Tool, ToolApprovalStatus } from "ai";
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
// several gates, and turning `ask` into `deny` where no one can be asked.

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

type Decision = { verdict: ToolGateVerdict["verdict"]; reason: string };

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
    return {
      verdict,
      reason:
        verdict === "ask"
          ? `The "${gate.name}" Tool gate wants a person to approve this call, and no one can approve it here${reason}`
          : `Blocked by the "${gate.name}" Tool gate${reason}`,
    };
  } catch (error) {
    logger.warn(
      { err: error, toolGate: gate.id, toolName: call.toolName },
      "Tool gate failed to answer; the call is not run",
    );
    return {
      verdict: "ask",
      reason:
        error instanceof DeadlineExceededError
          ? `The "${gate.name}" Tool gate did not answer within ${gate.timeoutMs}ms, so the call was not run.`
          : `The "${gate.name}" Tool gate failed (${errorMessage(error)}), so the call was not run.`,
    };
  }
};

type ApprovalRequest = {
  toolCall: {
    toolName: string;
    input: unknown;
    providerExecuted?: boolean;
  };
  tools: Record<string, Tool> | undefined;
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
        toolApproval: async ({ toolCall, tools }) => {
          // Never reached the backend, so nothing here can stop it (ADR-0033).
          if (toolCall.providerExecuted) return undefined;
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
          // `ask` reaches no one yet (#1256): it is `deny` in every Drive.
          return decision.verdict === "allow"
            ? undefined
            : { type: "denied", reason: decision.reason };
        },
      };
};
