import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  applyToolResultClearing,
  clearStaleToolResults,
  DEFAULT_CLEARING_POLICY,
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
const DEFAULT_STEPS = 60;

const POLICY = DEFAULT_CLEARING_POLICY;

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

const messageChars = (message: ModelMessage): number => {
  if (typeof message.content === "string") return message.content.length;
  let total = 0;
  for (const part of message.content) {
    if (part.type === "text") total += part.text.length;
    else if (part.type === "tool-result" && part.output.type === "text") {
      total += part.output.value.length;
    }
  }
  return total;
};

type Measurement = {
  steps: number;
  stepsWithEarlierChange: number;
  changedEarlierMessages: number;
  invalidatedChars: number;
  maxInvalidatedChars: number;
  /** The largest occupancy a step READ, before clearing had a chance to run. */
  maxOccupancy: number;
};

type Rule = (
  messages: ModelMessage[],
  occupancy: number,
  window: number,
) => ModelMessage[];

/**
 * The rule before this change: clear everything past keep-recent once engaged.
 * `batchSize: 1` makes the shared prefix helper return every stale item, which
 * is exactly the old boundary.
 */
const oldRule: Rule = (messages, occupancy, window) => {
  if (occupancy / window < POLICY.thresholdFraction) return messages;
  return clearStaleToolResults(messages, { ...POLICY, batchSize: 1 });
};

/** The shipped rule. */
const newRule: Rule = (messages, occupancy, window) =>
  applyToolResultClearing(
    messages,
    { occupancy, contextWindow: window },
    POLICY,
  );

type Scenario = {
  basePromptChars: number;
  resultChars: number;
  window: number;
  steps?: number;
};

const simulate = (
  scenario: Scenario,
  rule: Rule,
): { measurement: Measurement; prompts: ModelMessage[][] } => {
  // `prepareStep`'s override carries forward, markers included.
  let working: ModelMessage[] = [
    { role: "user", content: "u".repeat(scenario.basePromptChars) },
  ];
  let previous: ModelMessage[] | undefined;
  const prompts: ModelMessage[][] = [];
  const measurement: Measurement = {
    steps: 0,
    stepsWithEarlierChange: 0,
    changedEarlierMessages: 0,
    invalidatedChars: 0,
    maxInvalidatedChars: 0,
    maxOccupancy: 0,
  };

  for (let step = 1; step <= (scenario.steps ?? DEFAULT_STEPS); step += 1) {
    working = [
      ...working,
      toolResultMessage(`t${step}`, "x".repeat(scenario.resultChars)),
    ];
    // What the vendor reports for the call about to be made: the whole working
    // conversation, markers included.
    const occupancy = Math.round(
      working.reduce((total, message) => total + messageChars(message), 0) /
        CHARS_PER_TOKEN,
    );
    measurement.maxOccupancy = Math.max(measurement.maxOccupancy, occupancy);
    const sent = rule(working, occupancy, scenario.window);
    measurement.steps += 1;
    prompts.push(sent);

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
  return { measurement, prompts };
};

const measure = (scenario: Scenario, rule: Rule): Measurement =>
  simulate(scenario, rule).measurement;

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

/** A turn that never reaches the trigger: neither rule touches it. */
const BELOW = {
  basePromptChars: 40_000,
  resultChars: 6_000,
  window: 200_000,
};

describe("Tool-result clearing — cached prompt prefix measurement", () => {
  const creepOld = measure(CREEP, oldRule);
  const creepNew = measure(CREEP, newRule);

  it("stops moving the survivor boundary on most steps in the creep regime", () => {
    // Recorded from this simulation. The batch moves the boundary once per
    // four results instead of once per result, so the invalidation count is a
    // quarter of the old rule's.
    expect(creepOld.stepsWithEarlierChange).toBe(56);
    expect(creepNew.stepsWithEarlierChange).toBe(14);
    expect(creepNew.stepsWithEarlierChange * POLICY.batchSize).toBe(
      creepOld.stepsWithEarlierChange,
    );
  });

  it("re-sends far fewer prompt characters than the old rule", () => {
    expect(creepNew.invalidatedChars).toBeLessThan(
      creepOld.invalidatedChars / 3,
    );
    // The change still happens in batches: an invalidation re-sends about the
    // same suffix as one old-rule step (the live tail dominates it), but it
    // happens a quarter as often.
    expect(creepNew.maxInvalidatedChars).toBeGreaterThanOrEqual(
      creepOld.maxInvalidatedChars,
    );
  });

  it("sends byte-identical prompts on a turn that never reaches the trigger", () => {
    const before = simulate(BELOW, oldRule).prompts.map((p) =>
      JSON.stringify(p),
    );
    const after = simulate(BELOW, newRule).prompts.map((p) =>
      JSON.stringify(p),
    );
    expect(after).toEqual(before);
  });
});
