import {
  ConflictError,
  LockedError,
  NotFoundError,
  ValidationError,
} from "../errors.ts";

/** What a Tool returns when the module refuses the write. */
export type ToolError = { error: string };

/**
 * Turns a module's typed refusal into the `{ error }` payload a Tool result
 * carries — a Tool reports a problem back to the model rather than throwing it
 * into the run. Anything else is a fault and still throws.
 */
export function toToolError(error: unknown): ToolError {
  if (
    error instanceof NotFoundError ||
    error instanceof ValidationError ||
    error instanceof ConflictError ||
    error instanceof LockedError
  ) {
    return { error: error.message };
  }
  throw error;
}

/** Runs a module write, returning its refusal as `{ error }`. */
export async function asToolResult<T>(
  run: () => Promise<T>,
): Promise<T | ToolError> {
  try {
    return await run();
  } catch (error) {
    return toToolError(error);
  }
}
