import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { mockAuth, mockNoSession } from "../test-utils.ts";
import { requireAuth } from "./authentication.ts";

describe("Authentication Middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return 401 if no session is found", async () => {
    mockNoSession();

    const app = new Hono();
    app.use("*", requireAuth);
    app.get("/test", (c) => c.text("ok"));

    const res = await app.request("/test");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("should set the session user in context if a session is found", async () => {
    const sessionData = {
      user: { id: "u1", email: "test@example.com" },
      session: { id: "s1" },
    };
    mockAuth.api.getSession.mockResolvedValue(sessionData);

    const app = new Hono<{ Variables: { user: unknown } }>();
    app.use("*", requireAuth);
    app.get("/test", (c) => c.json({ user: c.get("user") }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: sessionData.user });
  });
});
