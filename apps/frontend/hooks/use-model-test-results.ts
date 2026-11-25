"use client";

import { useRef, useState } from "react";
import type { ProviderTest, ProviderTestResponse } from "@platypus/schemas";
import { writeAt } from "@/lib/api-write";

export type ModelTestVerdict =
  | { kind: "probe"; result: ProviderTestResponse }
  | { kind: "not-run"; message: string };

export type ProviderTestPayload = Omit<ProviderTest, "modelId">;

export type ModelTestResults = {
  results: Record<number, ModelTestVerdict>;
  pendingIndex: number | null;
  run: (
    index: number,
    modelId: string,
    payload: ProviderTestPayload,
  ) => Promise<void>;
  clearAll: () => void;
  clearCard: (index: number) => void;
};

export function useModelTestResults(testUrl: string): ModelTestResults {
  const [results, setResults] = useState<Record<number, ModelTestVerdict>>({});
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  // why: a probe outlives the click, so a config change must discard its verdict
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
    // why: only this card's probe describes the values that just changed
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
