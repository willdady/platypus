/** A thrown value as a log-ready string: an Error's message, else the value. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
