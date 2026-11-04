"use client";

import { useRef, useState } from "react";
import type { ProviderTestResponse } from "@platypus/schemas";
import { writeAt } from "@/lib/api-write";

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
  results: Record<number, ProviderTestResponse>;
  /** The card whose probe is running, if any. */
  pendingIndex: number | null;
  /** Tests one card's model with `payload` as the Provider config. */
  run: (
    index: number,
    modelId: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  /** Drops every verdict, and discards any probe already running. */
  clearAll: () => void;
  /** Drops one card's verdict, and discards its probe if that one is running. */
  clearCard: (index: number) => void;
};

export function useModelTestResults(testUrl: string): ModelTestResults {
  const [results, setResults] = useState<Record<number, ProviderTestResponse>>(
    {},
  );
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
    payload: Record<string, unknown>,
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

    // A transport or validation refusal still belongs on the card; there is no
    // failure class to report, so it reads as Unknown with the API's message.
    // No probe ran, so no session placeholder was substituted.
    const result: ProviderTestResponse =
      outcome.outcome === "success"
        ? outcome.data
        : {
            success: false,
            modelId,
            failureClass: "unknown",
            message: outcome.message,
            sessionIdSubstituted: false,
          };
    setResults((prev) => ({ ...prev, [index]: result }));
  };

  return { results, pendingIndex, run, clearAll, clearCard };
}
