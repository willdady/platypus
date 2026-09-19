import {
  findModelEntry,
  modelLabelFor,
  resolveModelReference,
  type Agent,
  type ConcreteModelId,
  type Provider,
} from "@platypus/schemas";
import {
  getModelConfigs,
  getSearchCapability,
  passthroughFileTypesFor,
} from "./model-config";

export type ModelSelectionInput = {
  /** Omit entirely for a caller (like the Agent form) that never selects by Agent. */
  agentId?: string;
  modelId: string;
  providerId: string;
};

export type ResolvedModel = {
  /** What a picker shows for this model — never the storage `alias:` prefix. */
  label: string;
  concreteId: ConcreteModelId;
  /** The vendor's published total token capacity, or undefined if undeclared (ADR-0018). */
  contextWindow: number | undefined;
  /** The ceiling on a single reply, or undefined if undeclared (issue #454). */
  maxOutputTokens: number | undefined;
  /** The media types this model ingests natively (issue #328). */
  passthroughFileTypes: string[];
  /** Whether a searching turn against this model would serve search tools. */
  canSearch: boolean;
};

/**
 * The single entry point for "what model will this Chat turn use, and what
 * can it do?" Resolves the current selection — an Agent, or a direct
 * Provider/model pair — to one object carrying every capability a turn cares
 * about, so callers stop composing `resolveModelId` +
 * `getPassthroughFileTypes` + `getContextWindow` + … by hand at each call
 * site.
 *
 * Returns `null` whenever nothing resolves: no selection made yet, a
 * selected Agent or Provider that no longer exists, or a model reference
 * that names nothing on the resolved Provider (a dangling id, or an alias
 * that was removed). There is no partial result — a Chat turn either has a
 * model or it doesn't.
 */
export const resolveModel = (input: {
  providers: Provider[];
  /** Omit for a caller (like the Agent form) that never selects by Agent. */
  agents?: Agent[];
  selection: ModelSelectionInput;
}): ResolvedModel | null => {
  const { providers, agents = [], selection } = input;

  let provider: Provider | undefined;
  let modelReference: string | undefined;

  if (selection.agentId) {
    const agent = agents.find((a) => a.id === selection.agentId);
    if (!agent) return null;
    provider = providers.find((p) => p.id === agent.providerId);
    modelReference = agent.modelId;
  } else {
    provider = providers.find((p) => p.id === selection.providerId);
    modelReference = selection.modelId;
  }

  if (!provider || !modelReference) return null;

  // Normalise the Provider's model list ONCE and answer every capability from
  // that one list. Five provider-taking helpers each re-normalised it per
  // render — on the hot path of every Chat render (issue #869).
  const configs = getModelConfigs(provider);

  const concreteId = resolveModelReference(configs, modelReference);
  if (!concreteId) return null;

  const entry = findModelEntry(configs, modelReference);

  return {
    label: entry ? modelLabelFor(entry) : concreteId,
    concreteId,
    contextWindow: entry?.contextWindow,
    maxOutputTokens: entry?.maxOutputTokens,
    passthroughFileTypes: passthroughFileTypesFor(provider, entry),
    canSearch: getSearchCapability(provider),
  };
};
