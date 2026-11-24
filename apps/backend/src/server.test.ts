import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { dbError, mockDb, mockSession, resetMockDb } from "./test-utils.ts";
import app from "./server.ts";
import { db } from "./index.ts";
import { logger } from "./logger.ts";
import { readyRoutes } from "./ready.ts";
import { RunRegistry } from "./runs/run-registry.ts";

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

  it("answers a body that fails its schema with 400 and only the issues", async () => {
    mockSession({ id: "user-1", email: "test@example.com" });

    const res = await app.request("/users/me/contexts", {
      method: "POST",
      body: JSON.stringify({ content: 42, workspaceId: null }),
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
      body: JSON.stringify({ content: "Hello", workspaceId: null }),
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

describe("health and readiness", () => {
  let registry: RunRegistry;

  beforeEach(() => {
    resetMockDb();
    registry = new RunRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers /health ok without asking the database", async () => {
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("logs /health at debug, not info, so the health check does not flood the log", async () => {
    const info = vi.spyOn(logger, "info");
    const debug = vi.spyOn(logger, "debug");

    await app.request("/health");

    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/health" }),
      "Request processed",
    );
    expect(info).not.toHaveBeenCalledWith(
      expect.anything(),
      "Request processed",
    );
  });

  it("answers /ready 200 when the database answers SELECT 1", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] });
    Object.assign(mockDb, { $client: { query } });

    const res = await app.request("/ready");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ text: "SELECT 1", query_timeout: 2_000 }),
    );
  });

  it("answers /ready 503 when the database does not answer", async () => {
    Object.assign(mockDb, {
      $client: { query: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) },
    });

    const res = await app.request("/ready");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Database unavailable" });
  });

  it("answers /ready 503 once shutdown has started, without a db call", async () => {
    registry.beginStop();
    const query = vi.fn();
    Object.assign(mockDb, { $client: { query } });

    const res = await readyRoutes(db.$client, registry).request("/ready");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Server is shutting down" });
    expect(query).not.toHaveBeenCalled();
  });
});

describe("auth mount", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("hands /auth/* to better-auth under the BACKEND_URL prefix", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://chat.example.com/api/");
    vi.resetModules();
    const { auth } = await import("./auth.ts");
    let handled: URL | undefined;
    Object.assign(auth, {
      handler: (req: Request) => {
        handled = new URL(req.url);
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    const { default: prefixedApp } = await import("./server.ts");

    await prefixedApp.request("/auth/get-session?disableRefresh=true");

    expect(handled?.pathname).toBe("/api/auth/get-session");
    expect(handled?.search).toBe("?disableRefresh=true");
  });

  it("forwards a POST served by @hono/node-server, body included", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://chat.example.com/api/");
    vi.resetModules();
    const { auth } = await import("./auth.ts");
    let received: { path: string; body: string } | undefined;
    Object.assign(auth, {
      handler: async (req: Request) => {
        received = { path: new URL(req.url).pathname, body: await req.text() };
        return new Response(null, { status: 204 });
      },
    });
    const { default: prefixedApp } = await import("./server.ts");
    const { serve } = await import("@hono/node-server");
    const server = await new Promise<import("node:http").Server>((resolve) => {
      const s = serve({ fetch: prefixedApp.fetch, port: 0 }, () =>
        resolve(s as import("node:http").Server),
      );
    });
    try {
      const { port } = server.address() as import("node:net").AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"email":"a@example.com"}',
      });
      expect(res.status).toBe(204);
      expect(received).toEqual({
        path: "/api/auth/sign-in/email",
        body: '{"email":"a@example.com"}',
      });
    } finally {
      server.close();
    }
  });
});
