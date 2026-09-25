// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchToolSets } from "./tool-sets-request";

const cookie = "better-auth.session_token=abc";

function stubFetch(impl: () => Promise<Response> | Response) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

/**
 * A genuine `Response`, not the shape-cast stub in `lib/test-utils`: this
 * module runs server-side and reads the body through the real class.
 */
function httpResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchToolSets", () => {
  beforeEach(() => {
    process.env.INTERNAL_BACKEND_URL = "http://backend:4000";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.INTERNAL_BACKEND_URL;
    delete process.env.BACKEND_URL;
  });

  it("returns the tool sets when the request succeeds", async () => {
    stubFetch(() => httpResponse({ results: [{ id: "ts1", name: "Web" }] }));

    const result = await fetchToolSets("/organizations/o1/tools", cookie);

    expect(result).toEqual({
      ok: true,
      toolSets: [{ id: "ts1", name: "Web" }],
    });
  });

  it("returns an empty list, not a failure, when the workspace has no tool sets", async () => {
    stubFetch(() => httpResponse({ results: [] }));

    const result = await fetchToolSets("/organizations/o1/tools", cookie);

    expect(result).toEqual({ ok: true, toolSets: [] });
  });

  it("forwards the caller's cookie to the backend so SSR requests carry the session", async () => {
    const spy = stubFetch(() => httpResponse({ results: [] }));

    await fetchToolSets("/organizations/o1/tools", cookie);

    expect(spy).toHaveBeenCalledWith(
      "http://backend:4000/organizations/o1/tools",
      { headers: { cookie } },
    );
  });

  it.each([401, 403])(
    "reports an unauthorized failure on %i rather than throwing",
    async (status) => {
      stubFetch(() => httpResponse({ error: "Unauthorized" }, status));

      const result = await fetchToolSets("/organizations/o1/tools", cookie);

      expect(result).toEqual({ ok: false, reason: "unauthorized" });
    },
  );

  it.each([
    ["a server error", () => httpResponse({ error: "Boom" }, 500)],
    [
      "a body that is not valid JSON",
      () => new Response("<html>gateway</html>", { status: 200 }),
    ],
    [
      "a 200 body with no results array",
      () => httpResponse({ unexpected: true }),
    ],
    ["a rejected fetch", () => Promise.reject(new Error("ECONNREFUSED"))],
  ])("reports an unavailable failure on %s", async (_name, impl) => {
    stubFetch(impl);

    const result = await fetchToolSets("/organizations/o1/tools", cookie);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("falls back to BACKEND_URL when no internal URL is configured", async () => {
    delete process.env.INTERNAL_BACKEND_URL;
    process.env.BACKEND_URL = "http://localhost:4000";
    const spy = stubFetch(() => httpResponse({ results: [] }));

    await fetchToolSets("/organizations/o1/tools", cookie);

    expect(spy).toHaveBeenCalledWith(
      "http://localhost:4000/organizations/o1/tools",
      { headers: { cookie } },
    );
  });
});
