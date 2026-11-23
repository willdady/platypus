import type { ModelMessage } from "ai";

export const ANSWER_STEP_INSTRUCTION =
  "[Final step: this is the last step this turn may take, so there is no step after it and no tool result you call for now can come back to you. Answer now from what you have already gathered. State plainly anything you could not finish or could not verify — do not present unfinished work as complete.]";

export const withAnswerStepInstruction = (
  messages: ModelMessage[],
  { stepNumber, maxSteps }: { stepNumber: number; maxSteps: number },
): ModelMessage[] =>
  stepNumber === maxSteps - 1
    ? [...messages, { role: "user", content: ANSWER_STEP_INSTRUCTION }]
    : messages;
