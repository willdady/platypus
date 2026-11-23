/**
 * How the Provider's background jobs size what they send against a job
 * model's declared context window: input tokens estimated as characters ÷ 4,
 * and at most `min(window / 2, window - maxOutputTokens)`. The half leaves room
 * for text that tokenises more densely than English prose — other languages,
 * code — where ÷ 4 runs low; the subtraction leaves room for the reply the call
 * actually requests, Thinking budget included. A window no bigger than the
 * reply leaves no input budget, and the caller skips the call rather than
 * shrinking the reply.
 */
export const CHARS_PER_TOKEN = 4;
const JOB_INPUT_SHARE = 0.5;

/**
 * The characters one job call may send a model declaring `contextWindow` while
 * requesting `maxOutputTokens` of output. Never negative: 0 means the reply
 * alone would fill the window, leaving no room for input.
 */
export const jobInputBudgetChars = (
  contextWindow: number,
  maxOutputTokens: number,
): number =>
  Math.max(
    0,
    Math.min(contextWindow * JOB_INPUT_SHARE, contextWindow - maxOutputTokens),
  ) * CHARS_PER_TOKEN;
