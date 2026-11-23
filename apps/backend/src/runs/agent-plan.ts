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
import { reasoningCallSettings } from "../services/reasoning.ts";
import {
  aliasNameFromReference,
  DEFAULT_AGENT_MAX_STEPS,
  DEFAULT_DIRECT_MAX_STEPS,
} from "@platypus/schemas";
import type { ConcreteModelId } from "@platypus/schemas";
import type { ProviderRow } from "../services/provider-write.ts";
import type { RunPlan } from "./run-plan.ts";
import type { ScopeContext } from "../scope.ts";

type GenerationAgentSource = {
  providerId: string;
  modelId: string;
  maxSteps?: number | null;
} & SamplingSource;

export type GenerationSource =
  | { agent: GenerationAgentSource }
  | ({
      providerId: string;
      modelId: string;
      maxSteps?: number | null;
    } & SamplingSource);

export type GenerationPlanScope = ScopeContext & {
  sessionId: string;
};

export type GenerationPlanQueries = {
  getProvider(
    id: string,
    orgId: string,
    workspaceId: string,
  ): Promise<ProviderRow | null>;
};

export type GenerationPlan = {
  plan: Omit<RunPlan, "system" | "tools">;
  provider: ProviderRow;
  resolvedModelId: ConcreteModelId;
  modelReference: string;
  guardrails: string | null;
};

const unresolvedModelMessage = (
  reference: string,
  providerId: string,
): string => {
  const aliasName = aliasNameFromReference(reference);
  return aliasName === null
    ? `Model id '${reference}' not enabled for provider '${providerId}'`
    : `Model alias '${aliasName}' is not defined on provider '${providerId}'`;
};

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

  const model = openProvider(provider, {
    sessionId: scope.sessionId,
  }).languageModel(resolvedModelId);
  const maxOutputTokens = maxOutputTokensForModel(provider, resolvedModelId);
  const contextWindow = contextWindowForModel(provider, resolvedModelId);
  const sampling = resolveSamplingSettings(samplingSource);

  return {
    plan: {
      model,
      usageModel: { providerId: provider.id, model: resolvedModelId },
      maxSteps,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...sampling,
      ...reasoningCallSettings(
        provider,
        resolvedModelId,
        samplingSource,
        sampling,
      ),
    },
    provider,
    resolvedModelId,
    modelReference,
    guardrails: provider.securityGuardrails ?? null,
  };
};

export type FallbackAgentSource = GenerationAgentSource & {
  fallbackProviderId?: string | null;
  fallbackModelId?: string | null;
};

export const resolveFallbackGeneration = async (
  agent: FallbackAgentSource,
  scope: GenerationPlanScope,
  queries: GenerationPlanQueries,
): Promise<GenerationPlan | undefined> => {
  if (!agent.fallbackProviderId || !agent.fallbackModelId) return undefined;
  const source: GenerationAgentSource = {
    ...agent,
    providerId: agent.fallbackProviderId,
    modelId: agent.fallbackModelId,
  };
  return resolveGenerationPlan({ agent: source }, scope, queries);
};
