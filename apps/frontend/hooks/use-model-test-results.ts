"use client";

import { useRef, useState } from "react";
import type { ProviderTest, ProviderTestResponse } from "@platypus/schemas";
import { writeAt } from "@/lib/api-write";

/**
 * A card's outcome. `probe` is a verdict the Provider returned; `not-run` is a
 * request refused before it reached the Provider — a validation error on a
 * half-filled form, a 403, a transport failure — and is reported as such rather
 * than dressed up as an Unknown Provider error.
 */
export type ModelTestVerdict =
  | { kind: "probe"; result: ProviderTestResponse }
  | { kind: "not-run"; message: string };

/** The request's Provider config, before the card's model id is added. */
export type ProviderTestPayload = Omit<ProviderTest, "modelId">;

/**
 * The Provider form's per-model Test state: one verdict per card, the card
 * whose probe is in flight, and the invalidation rules the form's edit
 * handlers drive.
 *
 * Cards are addressed by list index, as they are in the form (two entries may
 * legitimately share a model id, and `modelIds` is replaced wholesale on save).
 * Because a probe outlives the click, every request carries the epoch it
 * started under; a config change bumps that epoch, so a verdict for values the
 * reader has already edited away is dropped rather than landing on the card.
 */
export type ModelTestResults = {
  /** Verdicts by card index. */
  results: Record<number, ModelTestVerdict>;
  /** The card whose probe is running, if any. */
  pendingIndex: number | null;
  /** Tests one card's model with `payload` as the Provider config. */
  run: (
    index: number,
    modelId: string,
    payload: ProviderTestPayload,
  ) => Promise<void>;
  /** Drops every verdict, and discards any probe already running. */
  clearAll: () => void;
  /** Drops one card's verdict, and discards its probe if that one is running. */
  clearCard: (index: number) => void;
};

export function useModelTestResults(testUrl: string): ModelTestResults {
  const [results, setResults] = useState<Record<number, ModelTestVerdict>>({});
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  // Bumped whenever what a probe described stops being what the form holds.
  const epoch = useRef(0);

  const removeResult = (index: number) => {
    setResults((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  const clearAll = () => {
    epoch.current += 1;
    setResults({});
  };

  const clearCard = (index: number) => {
    // A probe for this card is describing values that just changed; one for
    // another card still describes that card's untouched model.
    if (pendingIndex === index) epoch.current += 1;
    removeResult(index);
  };

  const run = async (
    index: number,
    modelId: string,
    payload: ProviderTestPayload,
  ) => {
    const startedAt = epoch.current;
    setPendingIndex(index);
    removeResult(index);

    const outcome = await writeAt<ProviderTestResponse>(testUrl, {
      method: "POST",
      data: { ...payload, modelId },
    });
    setPendingIndex(null);
    if (epoch.current !== startedAt) return;

    setResults((prev) => ({
      ...prev,
      [index]:
        outcome.outcome === "success"
          ? { kind: "probe", result: outcome.data }
          : { kind: "not-run", message: outcome.message },
    }));
  };

  return { results, pendingIndex, run, clearAll, clearCard };
}
