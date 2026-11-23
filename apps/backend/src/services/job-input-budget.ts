export const CHARS_PER_TOKEN = 4;
const JOB_INPUT_SHARE = 0.5;

export const jobInputBudgetChars = (
  contextWindow: number,
  maxOutputTokens: number,
): number =>
  Math.max(
    0,
    Math.min(contextWindow * JOB_INPUT_SHARE, contextWindow - maxOutputTokens),
  ) * CHARS_PER_TOKEN;
