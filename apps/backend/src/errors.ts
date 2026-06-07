import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Typed domain errors raised by services and route handlers for the three
 * cross-cutting failure modes, mapped to HTTP status in a single Hono
 * `app.onError` (ADR-0009): a resource that does not exist, an
 * Organization-scoped (Shared) resource locked against Workspace-surface
 * mutation, and a unique-constraint violation. Route-specific 4xx responses
 * (validation, sub-agent rules, `findNonSharedReferences`) stay inline.
 */

/** The requested resource does not exist (or is not visible here). → 404 */
export class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

/**
 * The resource exists but is locked against the attempted mutation — an
 * Organization-scoped (Shared) resource is a single source of truth edited only
 * on the Organization surface, so it is locked in every Workspace (ADR-0007).
 * → 403
 */
export class LockedError extends Error {
  constructor(message = "This resource is managed at the organization level") {
    super(message);
    this.name = "LockedError";
  }
}

/** The operation conflicts with existing state (e.g. a duplicate name). → 409 */
export class ConflictError extends Error {
  constructor(message = "This operation conflicts with an existing resource") {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * Detects a Postgres unique-constraint violation (SQLSTATE `23505`) across the
 * driver shapes we see — the code can surface on the error itself or on its
 * `cause`, and some drivers only expose it in the message text. Centralised
 * here so the previously-duplicated per-route copies all collapse to one.
 */
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

/**
 * Maps a thrown error to its HTTP response, or returns `null` when the error is
 * not one of the cross-cutting modes (the caller then falls back to a 500). The
 * mapping lives in a pure function so it can be unit-tested without a request.
 */
export const mapError = (
  error: unknown,
): { status: ContentfulStatusCode; message: string } | null => {
  if (error instanceof NotFoundError)
    return { status: 404, message: error.message };
  if (error instanceof LockedError)
    return { status: 403, message: error.message };
  if (error instanceof ConflictError)
    return { status: 409, message: error.message };
  if (isUniqueViolation(error))
    return { status: 409, message: "A resource with that name already exists" };
  return null;
};
