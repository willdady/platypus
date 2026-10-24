import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { dbError, mockDb, mockSession, resetMockDb } from "./test-utils.ts";
import app from "./server.ts";
import { logger } from "./logger.ts";

describe("app error responses", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers a malformed JSON body with 400 and an error, without logging", async () => {
    mockSession({ id: "user-1", email: "test@example.com" });
    const logError = vi.spyOn(logger, "error");

    // Any route behind sValidator("json") would do; Contexts needs only a session.
    const res = await app.request("/users/me/contexts", {
      method: "POST",
      body: "{not json",
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Malformed JSON in request body",
    });
    expect(logError).not.toHaveBeenCalled();
  });

  // The one body that isn't an error message: the issues array, which the
  // frontend maps onto form fields. No `success`, no echo of the request.
  it("answers a body that fails its schema with 400 and only the issues", async () => {
    mockSession({ id: "user-1", email: "test@example.com" });

    const res = await app.request("/users/me/contexts", {
      method: "POST",
      body: JSON.stringify({ content: 42 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: Array<{ path: unknown[]; message: string }>;
    };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error).toEqual([
      expect.objectContaining({
        path: ["content"],
        message: expect.any(String) as string,
      }),
    ]);
  });

  it("answers a thrown error with only an error key", async () => {
    mockSession({ id: "user-1", email: "test@example.com" });
    mockDb.returning.mockRejectedValueOnce(dbError("23505"));

    const res = await app.request("/users/me/contexts", {
      method: "POST",
      body: JSON.stringify({ content: "Hello" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(409);
    expect(Object.keys((await res.json()) as object)).toEqual(["error"]);
  });

  it("answers an unknown path with 404 and an error", async () => {
    const res = await app.request("/no-such-path");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not Found" });
  });
});
