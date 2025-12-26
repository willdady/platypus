import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { mockAuth, mockSession, mockNoSession } from "../test-utils.ts";
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

  it("should set user and session in context if session is found", async () => {
    const sessionData = {
      user: { id: "u1", email: "test@example.com" },
      session: { id: "s1" },
    };
    mockSession(sessionData.user);
    // Overwrite session id if needed, but mockSession sets it to session-1
    mockAuth.api.getSession.mockResolvedValue(sessionData);
    
    const app = new Hono<{ Variables: { user: any; session: any } }>();
    app.use("*", requireAuth);
    app.get("/test", (c) => {
      const user = c.get("user");
      const session = c.get("session");
      return c.json({ user, session });
    });

    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sessionData);
  });
});
