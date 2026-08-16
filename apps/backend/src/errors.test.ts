import { describe, it, expect } from "vitest";
import {
  NotFoundError,
  LockedError,
  ConflictError,
  ValidationError,
  isUniqueViolation,
  mapError,
} from "./errors.ts";
import { FileValidationError } from "./services/file-gate.ts";

describe("central error mapping (app.onError)", () => {
  it("maps NotFoundError → 404", () => {
    expect(mapError(new NotFoundError("Agent not found"))).toEqual({
      status: 404,
      message: "Agent not found",
    });
  });

  it("maps LockedError → 403", () => {
    const mapped = mapError(new LockedError());
    expect(mapped?.status).toBe(403);
  });

  it("maps ConflictError → 409", () => {
    const mapped = mapError(new ConflictError());
    expect(mapped?.status).toBe(409);
  });

  it("maps ValidationError → 400", () => {
    expect(mapError(new ValidationError("Invalid label ID"))).toEqual({
      status: 400,
      message: "Invalid label ID",
    });
  });

  it("maps FileValidationError → 400, carrying the offending files", () => {
    const error = new FileValidationError([
      { file: "scan.pdf", reason: "unextractable" },
    ]);
    expect(mapError(error)).toEqual({
      status: 400,
      message: error.message,
      files: ["scan.pdf"],
    });
  });

  it("maps a Postgres unique violation (23505) → 409", () => {
    expect(mapError({ code: "23505" })?.status).toBe(409);
    // The code can surface on the error's cause across driver shapes.
    expect(mapError({ cause: { code: "23505" } })?.status).toBe(409);
  });

  it("returns null for an unmapped error (falls back to 500)", () => {
    expect(mapError(new Error("boom"))).toBeNull();
  });

  it("detects unique violations across driver shapes", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(
      isUniqueViolation({
        message: "duplicate key value violates unique constraint",
      }),
    ).toBe(true);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
