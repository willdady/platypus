import {
  modelReferenceFor,
  resolveExtractedTextCap,
  resolveModelReference,
  type ConcreteModelId,
  type ModelConfig,
  type ReasoningMap,
} from "@platypus/schemas";
import type { ProviderRow } from "./provider-write.ts";

/**
 * Per-model file capability resolution.
 *
 * Capability is a property of the `(provider, model)` pair and is *declared*,
 * not inferred (see issue #328). A model's `passthroughFileTypes` lists the
 * media types it ingests natively; anything else is converted to text where
 * possible (Phase 2) or, until then, cleanly rejected. This module is the
 * single source of truth for turning a provider's stored models — which may be
 * the new per-model objects OR a legacy `string[]` — into resolved
 * `ModelConfig`s. There is no Provider-type default (ADR-0039).
 */

/** All a model lookup reads of a Provider: its models, as stored. */
type ProviderModels = Pick<ProviderRow, "modelIds">;

/**
 * Normalize a provider's stored models into resolved `ModelConfig`s.
 *
 * Tolerates both shapes: a bare `string` entry, or an object with no
 * `passthroughFileTypes`, ingests nothing natively. Migration 0091 backfills
 * stored rows; dev `drizzle-kit push` skips it.
 */
export const resolveProviderModels = (
  provider: ProviderModels,
): ModelConfig[] =>
  provider.modelIds.map((entry) => {
    if (typeof entry === "string") {
      return { id: entry, passthroughFileTypes: [] };
    }
    // Spread the stored entry so per-model metadata added later (e.g.
    // `maxExtractedTextChars`) survives resolution without touching this.
    return {
      ...entry,
      passthroughFileTypes: entry.passthroughFileTypes ?? [],
    };
  });

/**
 * The list of model REFERENCES a caller should store, preserving order — the
 * alias reference for an aliased entry, the concrete id otherwise.
 *
 * The backend mirror of the frontend's `getModelOptions`: what an alias-aware
 * picker submits. Deliberately not a plain id list, so a tool advertising a
 * Provider's models to an Agent cannot hand back a concrete id the UI would
 * never have offered and thereby opt that Agent out of future repoints
 * (ADR-0017). Anything that needs the concrete id must go through
 * `resolveModelId`, which is the only mint of `ConcreteModelId`.
 */
export const providerModelReferences = (provider: ProviderModels): string[] =>
  resolveProviderModels(provider).map(modelReferenceFor);

/**
 * Dedupe a provider payload's models by id (first entry wins, so an operator's
 * explicit `passthroughFileTypes` is kept over a later duplicate) and sort by
 * id for stable storage. Replaces the old `dedupeArray(modelIds).sort()` on the
 * flat string list, which no longer works now that entries are objects.
 */
export const dedupeModelConfigs = (models: ModelConfig[]): ModelConfig[] => {
  const byId = new Map<string, ModelConfig>();
  for (const model of models) {
    if (!byId.has(model.id)) byId.set(model.id, model);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
};

/**
 * Resolve a stored model reference — `agent.modelId`, `chat.modelId`, or an
 * API-supplied `modelId` — to the concrete model it names, or `undefined` when
 * it names nothing this provider has.
 *
 * The SOLE producer of `ConcreteModelId`, and therefore the only way into the
 * capability helpers and `openProvider(...).languageModel(...)` below. Callers
 * must treat `undefined` as a hard error and never fall back to another model
 * (ADR-0017): silently answering with a different model is worse than failing
 * the turn, which is what a dangling concrete id has always done.
 */
export const resolveModelId = (
  provider: ProviderModels,
  reference: string,
): ConcreteModelId | undefined =>
  resolveModelReference(resolveProviderModels(provider), reference);

/**
 * Brand one of the Provider's own pointer-settings — `taskModelId`,
 * `memoryExtractionModelId`, `embeddingModelId` — as concrete.
 *
 * Sound because `providerBaseSchema` rejects an `alias:`-prefixed value in all
 * three, so they cannot hold a reference in the first place. Deliberately
 * long-named: this is the one hole in the brand, and passing an `agent.modelId`
 * or `chat.modelId` through it defeats the guarantee the brand exists for.
 */
export const pointerSettingModelId = (value: string): ConcreteModelId =>
  value as ConcreteModelId;

/**
 * The resolved entry for a model, or undefined when this Provider has no such
 * model. Every per-model accessor below goes through it, so "what does this
 * Provider say about this model?" is asked in exactly one place.
 */
const modelEntry = (
  provider: ProviderModels,
  modelId: ConcreteModelId,
): ModelConfig | undefined =>
  resolveProviderModels(provider).find((m) => m.id === modelId);

/**
 * The media types the given model ingests natively; none when the model isn't
 * found (defensive — callers should validate the model id first).
 */
export const passthroughFileTypesForModel = (
  provider: ProviderModels,
  modelId: ConcreteModelId,
): string[] => modelEntry(provider, modelId)?.passthroughFileTypes ?? [];

/**
 * How much extracted document text this model may be sent (issue #342).
 * `resolveExtractedTextCap` decides what an absent or nonsense declaration
 * means, so this and the schema can't drift.
 */
export const maxExtractedTextCharsForModel = (
  provider: ProviderModels,
  modelId: ConcreteModelId,
): number =>
  resolveExtractedTextCap(modelEntry(provider, modelId)?.maxExtractedTextChars);

/**
 * The output-token ceiling declared for this model, or `undefined` when the
 * Provider declares none (issue #454).
 *
 * No default of its own, deliberately — unlike the extracted-text cap. An
 * undeclared model must reach the SDK with no ceiling at all, exactly as it did
 * before the field existed, because the sane value differs per provider and per
 * model and only the vendor knows it. Declaring one is what rescues Amazon
 * Bedrock, whose Converse API silently applies a low default when the field is
 * absent.
 */
export const maxOutputTokensForModel = (
  provider: ProviderModels,
  modelId: ConcreteModelId,
): number | undefined => modelEntry(provider, modelId)?.maxOutputTokens;

/**
 * The total token capacity an Org Admin declared for this model, or `undefined`
 * where none was declared (ADR-0018).
 *
 * No default either, for a different reason from the ceiling above: nothing can
 * discover a context window, so an undeclared one stays unknown and every reader
 * hides rather than guesses. Keyed on `(provider, model)` because the same model
 * reached directly and through a proxy can honestly differ, and because the
 * declaration lives on the model entry a Model alias carries its window with it.
 */
export const contextWindowForModel = (
  provider: ProviderModels,
  modelId: ConcreteModelId,
): number | undefined => modelEntry(provider, modelId)?.contextWindow;

/**
 * The Reasoning map an Org Admin declared for this model (ADR-0040), or
 * `undefined` where none was — in which case nothing is sent.
 */
export const reasoningMapForModel = (
  provider: ProviderModels,
  modelId: ConcreteModelId,
): ReasoningMap | undefined => modelEntry(provider, modelId)?.reasoning;
