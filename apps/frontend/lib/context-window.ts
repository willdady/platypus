/**
 * The Context window control's preset list and the mapping between what it
 * shows and the integer that gets stored (ADR-0018).
 *
 * Pure and separate from the component on purpose: the mapping is the part with
 * a wrong answer — decimal vs binary thousands, what Custom does to a value
 * already set — and no test can drive a Radix select open in this suite's jsdom
 * setup. Storage is always a plain integer; the presets are an affordance, so a
 * proxied model with an odd capacity is never unrepresentable.
 */

export type ContextWindowPreset = {
  /** What the option reads as, e.g. `128k`. */
  label: string;
  /** The integer that option stores. */
  tokens: number;
};

/**
 * Common published window sizes, read as DECIMAL thousands — `128k` is 128,000,
 * not 131,072.
 *
 * Under-declaring is harmless (the meter simply reads conservatively) while
 * over-declaring hard-fails at the vendor, so decimal is the safe reading of an
 * ambiguous label: a genuine 131,072-token model declared as 128k forfeits 3k
 * and nothing else.
 */
export const CONTEXT_WINDOW_PRESETS: ContextWindowPreset[] = [
  { label: "8k", tokens: 8_000 },
  { label: "16k", tokens: 16_000 },
  { label: "32k", tokens: 32_000 },
  { label: "64k", tokens: 64_000 },
  { label: "128k", tokens: 128_000 },
  { label: "200k", tokens: 200_000 },
  { label: "256k", tokens: 256_000 },
  { label: "1M", tokens: 1_000_000 },
];

/** The option meaning "no window declared" — the default for every model. */
export const CONTEXT_WINDOW_UNSET = "unset";

/** The option that swaps the select for a plain number input. */
export const CONTEXT_WINDOW_CUSTOM = "custom";

/**
 * Window → option. Which option a stored window selects; anything that is not
 * one of the presets reads as Custom, including a value the schema would
 * reject, because a row showing a number the server refused has to keep showing
 * it or the reader cannot see what to fix.
 */
export const optionForContextWindow = (window: number | undefined): string => {
  if (window === undefined) return CONTEXT_WINDOW_UNSET;
  const preset = CONTEXT_WINDOW_PRESETS.find((p) => p.tokens === window);
  return preset ? String(preset.tokens) : CONTEXT_WINDOW_CUSTOM;
};

/**
 * Option → window. What a chosen option means, given what the row currently
 * holds.
 *
 * Custom keeps the current value rather than clearing it — choosing it is the
 * reader opening a text box to edit 128,000 into 131,072, not discarding what
 * they had.
 */
export const contextWindowForOption = (
  selection: string,
  current: number | undefined,
): number | undefined => {
  if (selection === CONTEXT_WINDOW_UNSET) return undefined;
  if (selection === CONTEXT_WINDOW_CUSTOM) return current;
  const parsed = Number.parseInt(selection, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** A tenth of a unit, with a trailing `.0` dropped: 1.05 → `1.1`, 42.0 → `42`. */
const toTenth = (value: number): number => Number(value.toFixed(1));

/**
 * A token figure as it is READ — abbreviated from a thousand up, because past
 * three digits these stop being read as numbers and start being counted.
 * `1,100` becomes `1.1K` and `1,048,576` becomes `1M`; what that rounding drops
 * is far below what any of these readings is accurate to.
 *
 * Shared, because the same quantity surfaces in two places — the Chat meter and
 * a Trigger run's stats — and a figure that reads `1M` in one and `1,000,000`
 * in the other looks like two different measurements.
 */
export const formatTokens = (tokens: number): string => {
  if (tokens < 1_000) return tokens.toLocaleString();
  // Rounded at the unit first, then promoted if that rounding carried, so
  // 999,999 reads `1M` rather than the `1000K` a straight threshold gives.
  const thousands = toTenth(tokens / 1_000);
  return thousands >= 1_000
    ? `${toTenth(thousands / 1_000)}M`
    : `${thousands}K`;
};

/**
 * What a typed Custom value means. An empty or unreadable field is "no window
 * declared"; anything numeric is passed through EXACTLY as typed, bounds
 * included, so a `128` meant as 128k is rejected by the schema with a message
 * rather than silently becoming no declaration at all.
 */
export const parseContextWindowInput = (value: string): number | undefined => {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
