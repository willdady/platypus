import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  applyToolResultClearing,
  clearStaleToolResults,
  DEFAULT_CLEARING_POLICY,
  observedConversationSize,
  type ClearingPolicy,
} from "./tool-result-clearing.ts";

/**
 * A before/after measurement of what batched clearing buys the Provider's
 * cached prompt prefix, on a simulated long tool-using turn.
 *
 * The quantity measured is what a cache miss costs: for every step after the
 * first, how many already-sent messages changed, and the characters from the
 * first changed message to the end — the suffix the Provider cannot serve from
 * its cache and must read again in full. It stands in for the vendor's
 * `cacheReadTokens` figure (`run-stats.ts`) without a live credential: a real
 * run's cache-read count also reflects the vendor's own breakpoint placement,
 * cached-write pricing and reasoning tokens a turn does not re-send, none of
 * which is observable here. What this pins is the mechanism — whether an earlier
 * message changes at all, and how much follows it.
 *
 * `prepareStep`'s `messages` override carries forward to later steps, so the
 * simulation carries the cleared markers forward too, which is how the real
 * loop behaves within one turn.
 */

/** Occupancy is simulated at four characters per token; the rule never assumes it. */
const CHARS_PER_TOKEN = 4;
const STEPS = 60;

const POLICY: ClearingPolicy = DEFAULT_CLEARING_POLICY;

const toolResultMessage = (
  toolCallId: string,
  value: string,
): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId,
      toolName: "read_url",
      output: { type: "text", value },
    },
  ],
});

const messageChars = (message: ModelMessage): number =>
  observedConversationSize([message]);

type Measurement = {
  steps: number;
  stepsWithEarlierChange: number;
  changedEarlierMessages: number;
  invalidatedChars: number;
  maxInvalidatedChars: number;
};

/** The rule before this change: clear everything past keep-recent once engaged. */
const oldRule = (
  messages: ModelMessage[],
  occupancy: number,
  window: number,
): ModelMessage[] => {
  if (occupancy / window < POLICY.thresholdFraction) return messages;
  return clearStaleToolResults(messages, POLICY);
};

/** The shipped rule. */
const newRule = (
  messages: ModelMessage[],
  occupancy: number,
  window: number,
): ModelMessage[] =>
  applyToolResultClearing(
    messages,
    { occupancy, contextWindow: window },
    POLICY,
  );

const measure = (input: {
  basePromptChars: number;
  resultChars: number;
  window: number;
  rule: (
    messages: ModelMessage[],
    occupancy: number,
    window: number,
  ) => ModelMessage[];
}): Measurement => {
  // `prepareStep`'s override carries forward, markers included.
  let working: ModelMessage[] = [
    { role: "user", content: "u".repeat(input.basePromptChars) },
  ];
  let previous: ModelMessage[] | undefined;
  const measurement: Measurement = {
    steps: 0,
    stepsWithEarlierChange: 0,
    changedEarlierMessages: 0,
    invalidatedChars: 0,
    maxInvalidatedChars: 0,
  };

  for (let step = 1; step <= STEPS; step += 1) {
    working = [
      ...working,
      toolResultMessage(`t${step}`, "x".repeat(input.resultChars)),
    ];
    // What the vendor reports for the call about to be made: the whole working
    // conversation, markers included.
    const occupancy = Math.round(
      working.reduce((total, message) => total + messageChars(message), 0) /
        CHARS_PER_TOKEN,
    );
    const sent = input.rule(working, occupancy, input.window);
    measurement.steps += 1;

    if (previous !== undefined) {
      const overlap = Math.min(previous.length, sent.length);
      let firstChanged = -1;
      let changed = 0;
      for (let index = 0; index < overlap; index += 1) {
        if (sent[index] === previous[index]) continue;
        changed += 1;
        if (firstChanged === -1) firstChanged = index;
      }
      measurement.changedEarlierMessages += changed;
      if (changed > 0) measurement.stepsWithEarlierChange += 1;
      if (firstChanged !== -1) {
        const invalidated = sent
          .slice(firstChanged)
          .reduce((total, message) => total + messageChars(message), 0);
        measurement.invalidatedChars += invalidated;
        measurement.maxInvalidatedChars = Math.max(
          measurement.maxInvalidatedChars,
          invalidated,
        );
      }
    }
    previous = sent;
    working = sent;
  }
  return measurement;
};

/**
 * The regime the issue describes: four recent results plus the rest of the
 * conversation already reach the trigger, so clearing everything past
 * keep-recent cannot get back under it. The old rule then clears one more
 * result on every step; the batched rule waits for a batch.
 */
const CREEP = {
  basePromptChars: 440_000,
  resultChars: 32_000,
  window: 200_000,
};

/** A turn with room to spare: clearing everything past keep-recent is enough. */
const ROOMY = {
  basePromptChars: 400_000,
  resultChars: 6_000,
  window: 200_000,
};

describe("Tool-result clearing — cached prompt prefix measurement", () => {
  const creepOld = measure({ ...CREEP, rule: oldRule });
  const creepNew = measure({ ...CREEP, rule: newRule });

  it("stops moving the survivor boundary on most steps in the creep regime", () => {
    // Recorded from this simulation; a change to the trigger, target or
    // minimum batch moves these and should update them deliberately.
    expect({ before: creepOld, after: creepNew }).toMatchObject({
      before: {
        steps: 60,
        stepsWithEarlierChange: 56,
        changedEarlierMessages: 56,
        invalidatedChars: 7_176_456,
        maxInvalidatedChars: 128_151,
      },
      after: {
        steps: 60,
        stepsWithEarlierChange: 14,
        changedEarlierMessages: 56,
        invalidatedChars: 1_800_456,
        maxInvalidatedChars: 128_604,
      },
    });
  });

  it("re-sends a quarter of the prompt characters the old rule did", () => {
    expect(creepNew.invalidatedChars).toBeLessThan(
      creepOld.invalidatedChars / 3,
    );
    // The change still happens in batches: an invalidation re-sends about the
    // same suffix as one old-rule step (the live tail dominates it), but it
    // happens 14 times instead of 56.
    expect(creepNew.maxInvalidatedChars).toBeGreaterThan(
      creepOld.maxInvalidatedChars,
    );
  });

  it("does not regress a turn that already had room to clear", () => {
    expect(measure({ ...ROOMY, rule: newRule })).toMatchObject(
      measure({ ...ROOMY, rule: oldRule }),
    );
  });
});
