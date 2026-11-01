import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  ANSWER_STEP_INSTRUCTION,
  withAnswerStepInstruction,
} from "./answer-step.ts";

/**
 * The Step ceiling's answer step (issue #1730).
 *
 * A turn stopped at its ceiling used to end wherever the model got to, often
 * with a Tool row and no answer. The last permitted step is now told, in the
 * request only, that it is the last one and must answer from what it has —
 * rather than having its tools taken away, which would drop the tool
 * definitions every Provider caches ahead of the conversation (ADR-0020).
 */

const conversation: ModelMessage[] = [
  { role: "user", content: "Find out what the service said." },
  {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "t1", toolName: "ping", input: {} },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "t1",
        toolName: "ping",
        output: { type: "text", value: "all clear" },
      },
    ],
  },
];

describe("withAnswerStepInstruction", () => {
  it("appends the instruction on the last allowed step", () => {
    const out = withAnswerStepInstruction(conversation, {
      stepNumber: 2,
      maxSteps: 3,
    });

    expect(out).toHaveLength(conversation.length + 1);
    expect(out.at(-1)).toEqual({
      role: "user",
      content: ANSWER_STEP_INSTRUCTION,
    });
  });

  it("appends nothing on an earlier step", () => {
    const out = withAnswerStepInstruction(conversation, {
      stepNumber: 1,
      maxSteps: 3,
    });

    expect(out).toBe(conversation);
  });

  // The answer step counts inside the ceiling: with a ceiling of one, the
  // instruction lands on the first (and only) call rather than a special case
  // adding a step.
  it("appends the instruction on a ceiling of one", () => {
    const out = withAnswerStepInstruction(conversation, {
      stepNumber: 0,
      maxSteps: 1,
    });

    expect(out.at(-1)).toMatchObject({ role: "user" });
    expect(out).toHaveLength(conversation.length + 1);
  });

  it("never mutates the conversation it was given", () => {
    const snapshot = structuredClone(conversation);

    withAnswerStepInstruction(conversation, { stepNumber: 2, maxSteps: 3 });

    expect(conversation).toEqual(snapshot);
  });

  // What the model is told is the whole point: it must be honest about this
  // being the last step and must not invite the model to claim the work is
  // done.
  it("tells the model it is the last step and to answer what it has", () => {
    expect(ANSWER_STEP_INSTRUCTION).toMatch(/final step/i);
    expect(ANSWER_STEP_INSTRUCTION).toMatch(/answer/i);
    expect(ANSWER_STEP_INSTRUCTION).toMatch(/could not|unfinished|incomplete/i);
  });
});
