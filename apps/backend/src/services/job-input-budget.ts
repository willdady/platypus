/**
 * How the Provider's background jobs size what they send against a job
 * model's declared context window: tokens estimated as characters ÷ 4, and at
 * most half the window. The half leaves room for the reply, and for text that
 * tokenises more densely than English prose — other languages, code — where
 * ÷ 4 runs low.
 */
export const CHARS_PER_TOKEN = 4;
const JOB_INPUT_SHARE = 0.5;

/** The characters one job call may send a model declaring `contextWindow`. */
export const jobInputBudgetChars = (contextWindow: number): number =>
  contextWindow * JOB_INPUT_SHARE * CHARS_PER_TOKEN;
