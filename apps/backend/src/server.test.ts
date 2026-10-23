import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockSession, resetMockDb } from "./test-utils.ts";
import app from "./server.ts";
import { logger } from "./logger.ts";

describe("app error responses", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  it("answers a malformed JSON body with 400 and an error, without logging", async () => {
    mockSession({ id: "user-1", email: "test@example.com" });
    const logError = vi.spyOn(logger, "error");

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

  it("answers an unknown path with 404 and an error", async () => {
    const res = await app.request("/no-such-path");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not Found" });
  });
});
