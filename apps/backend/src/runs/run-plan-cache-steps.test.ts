import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { createOverflowRecovery } from "./context-overflow-recovery.ts";
import { buildModelInvocation, type RunPlan } from "./run-plan.ts";

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
    overflowRecovery: createOverflowRecovery(),
  }) as unknown as {
    prepareStep: (args: {
      steps: unknown[];
      messages: ModelMessage[];
      stepNumber: number;
    }) => { messages: ModelMessage[] };
  };

const cachePointCount = (messages: ModelMessage[]): number =>
  messages.filter((m) => m.providerOptions?.amazonBedrock.cachePoint).length;

const cachePointIndexes = (messages: ModelMessage[]): number[] =>
  messages.flatMap((m, i) =>
    m.providerOptions?.amazonBedrock.cachePoint ? [i] : [],
  );

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

    expect(cachePointIndexes(second)).toEqual([second.length - 1]);
    expect(second[0].providerOptions?.amazonBedrock.cachePoint).toBeUndefined();
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
