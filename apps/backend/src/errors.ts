import type { ContentfulStatusCode } from "hono/utils/http-status";
import { FileValidationError } from "./services/file-gate.ts";

export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class LockedError extends Error {
  constructor(message = "This resource is managed at the organization level") {
    super(message);
    this.name = "LockedError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ConflictError extends Error {
  constructor(message = "This operation conflicts with an existing resource") {
    super(message);
    this.name = "ConflictError";
  }
}

export class ServiceUnavailableError extends Error {
  constructor(message = "Server is shutting down") {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class UnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedError";
  }
}

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

export const isUniqueViolation = (error: unknown): boolean => {
  const e = error as
    | {
        code?: string;
        message?: string;
        cause?: { code?: string; message?: string };
      }
    | null
    | undefined;
  if (!e) return false;
  return (
    e.code === "23505" ||
    e.cause?.code === "23505" ||
    !!e.message?.includes("unique constraint") ||
    !!e.cause?.message?.includes("unique constraint")
  );
};

export const isForeignKeyViolation = (error: unknown): boolean => {
  const e = error as
    { code?: string; cause?: { code?: string } } | null | undefined;
  if (!e) return false;
  return e.code === "23503" || e.cause?.code === "23503";
};

export const mapError = (
  error: unknown,
): {
  status: ContentfulStatusCode;
  message: string;
  files?: string[];
} | null => {
  if (error instanceof NotFoundError)
    return { status: 404, message: error.message };
  if (error instanceof LockedError)
    return { status: 403, message: error.message };
  if (error instanceof ConflictError)
    return { status: 409, message: error.message };
  if (error instanceof ServiceUnavailableError)
    return { status: 503, message: error.message };
  if (error instanceof ValidationError)
    return { status: 400, message: error.message };
  if (error instanceof UnsupportedError)
    return { status: 501, message: error.message };
  if (error instanceof UpstreamError)
    return { status: 502, message: error.message };
  if (error instanceof RateLimitError)
    return { status: 429, message: error.message };
  if (error instanceof FileValidationError)
    return { status: 400, message: error.message, files: error.files };
  if (isUniqueViolation(error))
    return { status: 409, message: "A resource with that name already exists" };
  if (isForeignKeyViolation(error))
    return {
      status: 409,
      message:
        "This change conflicts with a related resource that is still in use or no longer exists",
    };
  return null;
};
