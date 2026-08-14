/**
 * The sampling parameters an Agent (or a Direct Chat turn) carries, as stored.
 *
 * Nullable because the UI clears a field back to "unset" by writing `null`
 * rather than dropping the key — without that, `JSON.stringify` omits the
 * cleared `undefined` and the column keeps its previous value (issue #263).
 */
export type SamplingSource = {
  temperature?: number | null;
  topP?: number | null;
  topK?: number | null;
  seed?: number | null;
  presencePenalty?: number | null;
  frequencyPenalty?: number | null;
};

/** The same parameters in the shape the AI SDK takes, with unset keys absent. */
export type SamplingSettings = {
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
};

/**
 * Narrow stored sampling parameters to the ones actually set.
 *
 * `null` and `undefined` both mean "unset" and are omitted entirely, so the
 * Provider's own default applies rather than an explicit null being sent.
 *
 * Shared rather than inlined because an Agent must generate with the parameters
 * assigned to it wherever it runs — a parent turn and a sub-agent run alike. Two
 * copies of this logic is how one of those quietly ends up with a shorter list
 * than the other.
 */
export const resolveSamplingSettings = (
  source: SamplingSource,
): SamplingSettings => {
  const settings: SamplingSettings = {};
  if (source.temperature != null) settings.temperature = source.temperature;
  if (source.topP != null) settings.topP = source.topP;
  if (source.topK != null) settings.topK = source.topK;
  if (source.seed != null) settings.seed = source.seed;
  if (source.presencePenalty != null)
    settings.presencePenalty = source.presencePenalty;
  if (source.frequencyPenalty != null)
    settings.frequencyPenalty = source.frequencyPenalty;
  return settings;
};
