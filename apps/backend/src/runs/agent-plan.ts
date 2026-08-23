import { NotFoundError, ValidationError } from "../errors.ts";
import { openProvider } from "../services/provider.ts";
import {
  contextWindowForModel,
  maxOutputTokensForModel,
  resolveModelId,
} from "../services/model-capability.ts";
import {
  resolveSamplingSettings,
  type SamplingSource,
} from "../services/sampling-settings.ts";
import {
  aliasNameFromReference,
  DEFAULT_AGENT_MAX_STEPS,
  DEFAULT_DIRECT_MAX_STEPS,
} from "@platypus/schemas";
import type { ConcreteModelId, Provider } from "@platypus/schemas";
import type { RunPlan } from "./run-plan.ts";
import type { ScopeContext } from "../scope.ts";

/**
 * The Agent-row fields a generation plan reads. Deliberately a structural
 * subset rather than the full `agent` table row: an Agent row satisfies it,
 * and so does a sub-Agent fixture in a test — both callers of
 * `resolveGenerationPlan` only ever have this much in hand.
 */
export type GenerationAgentSource = {
  providerId: string;
  modelId: string;
  maxSteps?: number | null;
} & SamplingSource;

/**
 * What an Agent generates under, resolved from either of its two sources: an
 * Agent row (Chat's Agent path, and every sub-Agent) or a direct Provider +
 * model selection (Chat's Direct path, which has no row and falls back to
 * `DEFAULT_DIRECT_MAX_STEPS`, issue #463). One module decides this so the
 * parent turn and a delegated sub-Agent can never resolve it differently
 * (issues #417, #456, #459 each had to patch this logic in two places, in the
 * same commit).
 */
export type GenerationSource =
  | { agent: GenerationAgentSource }
  // `maxSteps` is the per-chat Max steps setting riding the turn request
  // (#539); null/absent means unset and falls back to the shared Direct
  // ceiling, exactly as an Agent's null does to the Agent default.
  | ({
      providerId: string;
      modelId: string;
      maxSteps?: number | null;
    } & SamplingSource);

/**
 * Where a generation plan resolves — the half of a `WorkspaceScope` a
 * data-access lookup actually reads (the currency `WorkspaceScope`-derived
 * types share since commit b8c3a3f).
 */
export type GenerationPlanScope = ScopeContext;

/**
 * The data-access surface `resolveGenerationPlan` depends on — a single
 * lookup, unlike the Chat turn's whole query surface, because resolving a
 * generation plan only ever needs one Provider row.
 */
export type GenerationPlanQueries = {
  getProvider(
    id: string,
    orgId: string,
    workspaceId: string,
  ): Promise<Provider | null>;
};

export type GenerationPlan = {
  /** Everything `buildModelInvocation` needs except `system` and `tools` —
   * those are composed differently by each caller (the full system prompt for
   * a Chat turn, Instructions + guardrails alone for a sub-Agent, ADR-0016). */
  plan: Omit<RunPlan, "system" | "tools">;
  provider: Provider;
  resolvedModelId: ConcreteModelId;
  /** The reference AS STORED — a concrete id, or `alias:<name>` (ADR-0017). */
  modelReference: string;
  /** The resolved Provider's free-text security directives, or null. */
  guardrails: string | null;
};

/**
 * Why a model reference resolved to nothing, said in the caller's terms: a
 * dangling alias and a dangling concrete id are different mistakes to fix.
 */
const unresolvedModelMessage = (
  reference: string,
  providerId: string,
): string => {
  const aliasName = aliasNameFromReference(reference);
  return aliasName === null
    ? `Model id '${reference}' not enabled for provider '${providerId}'`
    : `Model alias '${aliasName}' is not defined on provider '${providerId}'`;
};

/**
 * Resolves an Agent row or a direct Provider+model selection to everything its
 * generation needs: the opened model, its step ceiling, its output ceiling,
 * its sampling parameters, and its Provider's guardrails text.
 *
 * Aliases re-resolve on EVERY call — no pinning — so repointing an alias moves
 * every Agent and Chat using it on their next turn or delegation. A reference
 * that matches nothing is a hard error, never a fallback to some other model.
 */
export const resolveGenerationPlan = async (
  source: GenerationSource,
  scope: GenerationPlanScope,
  queries: GenerationPlanQueries,
): Promise<GenerationPlan> => {
  const providerId =
    "agent" in source ? source.agent.providerId : source.providerId;
  const modelReference =
    "agent" in source ? source.agent.modelId : source.modelId;
  const maxSteps =
    "agent" in source
      ? (source.agent.maxSteps ?? DEFAULT_AGENT_MAX_STEPS)
      : (source.maxSteps ?? DEFAULT_DIRECT_MAX_STEPS);
  const samplingSource: SamplingSource =
    "agent" in source ? source.agent : source;

  const provider = await queries.getProvider(
    providerId,
    scope.orgId,
    scope.workspaceId,
  );
  if (!provider) {
    throw new NotFoundError(`Provider with id '${providerId}' not found`);
  }

  const resolvedModelId = resolveModelId(provider, modelReference);
  if (!resolvedModelId) {
    throw new ValidationError(
      unresolvedModelMessage(modelReference, providerId),
    );
  }

  const model = openProvider(provider).languageModel(resolvedModelId);
  const maxOutputTokens = maxOutputTokensForModel(provider, resolvedModelId);
  const contextWindow = contextWindowForModel(provider, resolvedModelId);

  return {
    plan: {
      model,
      maxSteps,
      // Left off entirely rather than sent as `undefined` when the Provider
      // declares no ceiling for this model (issue #454) — so a reader can
      // assert "the key is absent" instead of guarding against `undefined`
      // sneaking in as though it were unset.
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      // Absent when the Provider declares no Context window (ADR-0018) — the
      // sole gate on Tool-result clearing, so an undeclared window must reach
      // `buildModelInvocation` as a true absence, not a guessed default.
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...resolveSamplingSettings(samplingSource),
    },
    provider,
    resolvedModelId,
    modelReference,
    guardrails: provider.securityGuardrails ?? null,
  };
};
