export type ContextWindowPreset = {
  label: string;
  tokens: number;
};

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

export const CONTEXT_WINDOW_UNSET = "unset";

export const CONTEXT_WINDOW_CUSTOM = "custom";

export function optionForContextWindow(window: number | undefined): string {
  if (window === undefined) return CONTEXT_WINDOW_UNSET;
  const preset = CONTEXT_WINDOW_PRESETS.find((p) => p.tokens === window);
  return preset ? String(preset.tokens) : CONTEXT_WINDOW_CUSTOM;
}

export function contextWindowForOption(
  selection: string,
  current: number | undefined,
): number | undefined {
  if (selection === CONTEXT_WINDOW_UNSET) return undefined;
  if (selection === CONTEXT_WINDOW_CUSTOM) return current;
  const parsed = Number.parseInt(selection, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toTenth(value: number): number {
  return Number(value.toFixed(1));
}

// why: one formatter, or 1M in the meter and 1,000,000 in a run's stats read as two figures
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return tokens.toLocaleString();
  const thousands = toTenth(tokens / 1_000);
  return thousands >= 1_000
    ? `${toTenth(thousands / 1_000)}M`
    : `${thousands}K`;
}

export function parseContextWindowInput(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
