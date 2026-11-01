import type { ModelMessage } from "ai";

/**
 * What the model is told on its **answer step** — the last call the **Step
 * ceiling** allows.
 *
 * Addressed to the model, not the User: it exists only inside that one request.
 * `prepareStep`'s `messages` override never reaches the reducer's response
 * messages, so nothing here is persisted, rendered in a **Chat**, or replayed on
 * a later turn. It says the turn ends after this step, asks for an answer from
 * what has already been gathered, and asks the model to name what it could not
 * finish — the alternative is a confident-sounding summary of unfinished work.
 *
 * The last clause is deliberate and load-bearing: the tool calls this step
 * makes still execute, but the loop stops afterwards, so their results never
 * come back to the model. Saying so is what a model needs to choose prose over
 * another call.
 */
export const ANSWER_STEP_INSTRUCTION =
  "[Final step: this is the last step this turn may take, so there is no step after it and no tool result you call for now can come back to you. Answer now from what you have already gathered. State plainly anything you could not finish or could not verify — do not present unfinished work as complete.]";

/**
 * Appends {@link ANSWER_STEP_INSTRUCTION} to the conversation on the last step
 * the ceiling allows, and leaves every earlier step untouched.
 *
 * Appended as a trailing user message rather than by changing `tools`,
 * `activeTools` or `toolChoice` (issue #1730). Taking the tools away would
 * rewrite the front of the request — the `tools` tier every Provider caches
 * ahead of the conversation (ADR-0020) — and on Bedrock `toolChoice: "none"`
 * drops every tool from the request outright, while a conversation still
 * carrying tool calls and results has to be read by a request that declared
 * none. A trailing message leaves the cached prefix byte-identical and works on
 * every Provider type with no branch.
 *
 * `stepNumber` is the SDK's, and is 0-based: the first call is step 0, so the
 * last of `maxSteps` calls is `maxSteps - 1`. The answer step counts inside the
 * ceiling — a ceiling of one puts the instruction on the only call — rather than
 * granting an extra step.
 */
export const withAnswerStepInstruction = (
  messages: ModelMessage[],
  { stepNumber, maxSteps }: { stepNumber: number; maxSteps: number },
): ModelMessage[] =>
  stepNumber === maxSteps - 1
    ? [...messages, { role: "user", content: ANSWER_STEP_INSTRUCTION }]
    : messages;
