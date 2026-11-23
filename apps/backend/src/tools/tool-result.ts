import {
  ConflictError,
  LockedError,
  NotFoundError,
  ValidationError,
} from "../errors.ts";

export type ToolError = { error: string };

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

export async function asToolResult<T>(
  run: () => Promise<T>,
): Promise<T | ToolError> {
  try {
    return await run();
  } catch (error) {
    return toToolError(error);
  }
}
