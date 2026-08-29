import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { buildModelInvocation, type RunPlan } from "./run-plan.ts";

/**
 * The Bedrock cache point across a multi-step turn.
 *
 * `prepareStep`'s `messages` override carries forward: the SDK computes the
 * next step's input as `[...stepMessages, ...responseMessages]`, where
 * `stepMessages` is the override when one was returned. So whatever this
 * attaches on step one is still in the array on step two. These tests drive
 * `prepareStep` the way the SDK does and assert the point *moves* rather than
 * accumulating — a request may only carry so many checkpoints, so one per step
 * eventually fails the whole call.
 */

const plan = (): RunPlan => ({
  model: "test-model",
  system: "system prompt",
  tools: {},
  maxSteps: 10,
  contextWindow: 200_000,
});

const invocation = () =>
  buildModelInvocation(plan(), {
    abortSignal: new AbortController().signal,
  }) as unknown as {
    prepareStep: (args: {
      steps: unknown[];
      messages: ModelMessage[];
      stepNumber: number;
    }) => { messages: ModelMessage[] };
  };

/** How many messages carry a Bedrock cache point. */
const cachePointCount = (messages: ModelMessage[]): number =>
  messages.filter((m) => m.providerOptions?.amazonBedrock?.cachePoint).length;

/** Index of the messages carrying a cache point. */
const cachePointIndexes = (messages: ModelMessage[]): number[] =>
  messages.flatMap((m, i) =>
    m.providerOptions?.amazonBedrock?.cachePoint ? [i] : [],
  );

/** Exactly what `ai` does between steps. */
const nextStepMessages = (
  override: ModelMessage[],
  step: number,
): ModelMessage[] => [
  ...override,
  { role: "assistant", content: `call ${step}` },
  { role: "user", content: `result ${step}` },
];

describe("Bedrock cache point across steps", () => {
  it("carries exactly one cache point however many steps a turn takes", () => {
    const { prepareStep } = invocation();
    let messages: ModelMessage[] = [{ role: "user", content: "start" }];

    for (let step = 0; step < 6; step++) {
      const { messages: override } = prepareStep({
        steps: [],
        messages,
        stepNumber: step,
      });

      expect(cachePointCount(override)).toBe(1);
      // ...and it is on the tail, not stranded behind it.
      expect(cachePointIndexes(override)).toEqual([override.length - 1]);

      messages = nextStepMessages(override, step);
    }
  });

  it("strips the previous step's point when the conversation has grown", () => {
    const { prepareStep } = invocation();

    const first = prepareStep({
      steps: [],
      messages: [{ role: "user", content: "start" }],
      stepNumber: 0,
    }).messages;
    expect(cachePointIndexes(first)).toEqual([0]);

    const second = prepareStep({
      steps: [],
      messages: nextStepMessages(first, 0),
      stepNumber: 1,
    }).messages;

    // The point that was on index 0 is gone; only the new tail carries one.
    expect(cachePointIndexes(second)).toEqual([second.length - 1]);
    expect(
      second[0].providerOptions?.amazonBedrock?.cachePoint,
    ).toBeUndefined();
  });

  it("leaves a message's other providerOptions intact when stripping", () => {
    const { prepareStep } = invocation();

    const first = prepareStep({
      steps: [],
      messages: [
        {
          role: "user",
          content: "start",
          providerOptions: {
            amazonBedrock: { somethingElse: true },
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
        },
      ],
      stepNumber: 0,
    }).messages;

    const second = prepareStep({
      steps: [],
      messages: nextStepMessages(first, 0),
      stepNumber: 1,
    }).messages;

    expect(second[0].providerOptions?.amazonBedrock).toEqual({
      somethingElse: true,
    });
    expect(second[0].providerOptions?.anthropic).toEqual({
      cacheControl: { type: "ephemeral" },
    });
  });
});
