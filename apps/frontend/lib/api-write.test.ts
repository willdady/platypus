// @vitest-environment node
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  writeEntity,
  writeAt,
  scopedUrl,
  attachmentsEntity,
  chatListEntity,
  organizationEntity,
} from "./api-write";
import { jsonResponse } from "./test-utils";

const BACKEND_URL = "http://localhost:4000";

/** Stubs `fetch` to answer every request with `status` and `body`. */
const respond = (status: number, body: unknown = {}) => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status, body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("writeEntity — transport", () => {
  it("POSTs to the org-scoped collection path when creating with no workspace scope", async () => {
    const fetchMock = respond(201, { id: "a1" });

    await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1" },
      { data: { name: "Bot" } },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/organizations/org1/agents",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bot" }),
      }),
    );
  });

  it("POSTs to the workspace-scoped collection path when a workspaceId is present", async () => {
    const fetchMock = respond(201);

    await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1", workspaceId: "ws1" },
      { data: { name: "Bot" } },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/organizations/org1/workspaces/ws1/agents",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("PUTs to the item path when an id and data are both given (update)", async () => {
    const fetchMock = respond(200);

    await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1", workspaceId: "ws1" },
      { id: "a1", data: { name: "Renamed" } },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/organizations/org1/workspaces/ws1/agents/a1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ name: "Renamed" }),
      }),
    );
  });

  it("DELETEs the item path with no body when an id is given without data", async () => {
    const fetchMock = respond(200);

    await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1", workspaceId: "ws1" },
      { id: "a1" },
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect(init.credentials).toBe("include");
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it("POSTs to the root collection path when the scope carries no orgId", async () => {
    const fetchMock = respond(201, { id: "org1" });

    await writeEntity(
      BACKEND_URL,
      "organizations",
      {},
      { data: { name: "Acme" } },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/organizations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Acme" }),
      }),
    );
  });

  it("PUTs to the root item path when the scope carries no orgId but an id is given", async () => {
    const fetchMock = respond(200);

    await writeEntity(
      BACKEND_URL,
      "organizations",
      {},
      { id: "org1", data: { name: "Renamed" } },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/organizations/org1",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("DELETEs the root item path when the scope carries no orgId", async () => {
    const fetchMock = respond(200);

    await writeEntity(BACKEND_URL, "organizations", {}, { id: "org1" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:4000/organizations/org1");
    expect(init.method).toBe("DELETE");
  });
});

describe("scopedUrl — the read-side path shape", () => {
  it("builds the workspace-scoped URL when a workspaceId is present", () => {
    expect(
      scopedUrl(BACKEND_URL, "providers", {
        orgId: "org1",
        workspaceId: "ws1",
      }),
    ).toBe("http://localhost:4000/organizations/org1/workspaces/ws1/providers");
  });

  it("builds the org-scoped URL when no workspaceId is given", () => {
    expect(scopedUrl(BACKEND_URL, "agents", { orgId: "org1" })).toBe(
      "http://localhost:4000/organizations/org1/agents",
    );
  });
});

describe("the query-parameterized key builders", () => {
  it("makes the parameterless chat list key a prefix of every variant of it", () => {
    const prefix = scopedUrl(BACKEND_URL, chatListEntity(), {
      orgId: "org1",
      workspaceId: "ws1",
    });
    const searched = scopedUrl(
      BACKEND_URL,
      chatListEntity({ limit: 100, search: "hello there" }),
      { orgId: "org1", workspaceId: "ws1" },
    );
    expect(searched.startsWith(prefix)).toBe(true);
    expect(searched).toContain("limit=100");
    expect(searched).toContain("search=hello+there");
  });

  it("spells the attachments key the same for every surface that asks", () => {
    expect(attachmentsEntity("skill", "s1")).toBe(
      "attachments?resourceType=skill&resourceId=s1",
    );
  });

  it("keeps one Organization at the root collection, not nested under itself", () => {
    expect(scopedUrl(BACKEND_URL, organizationEntity("org1"), {})).toBe(
      "http://localhost:4000/organizations/org1",
    );
  });
});

describe("writeEntity — outcomes", () => {
  it("maps a 2xx response to a success outcome carrying the parsed body", async () => {
    respond(201, { id: "a1", name: "Bot" });

    const result = await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1" },
      { data: { name: "Bot" } },
    );

    expect(result).toEqual({
      outcome: "success",
      data: { id: "a1", name: "Bot" },
      revalidateKeys: ["http://localhost:4000/organizations/org1/agents"],
    });
  });

  it("declares both the collection and item keys to revalidate after an update", async () => {
    respond(200);

    const result = await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1" },
      { id: "a1", data: { name: "Renamed" } },
    );

    expect(result).toMatchObject({
      outcome: "success",
      revalidateKeys: [
        "http://localhost:4000/organizations/org1/agents",
        "http://localhost:4000/organizations/org1/agents/a1",
      ],
    });
  });

  it("declares only the collection key to revalidate after a delete", async () => {
    respond(200);

    const result = await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1" },
      { id: "a1" },
    );

    expect(result).toMatchObject({
      outcome: "success",
      revalidateKeys: ["http://localhost:4000/organizations/org1/agents"],
    });
  });

  // One row per backend error class, and the neutral default a bare body gets.
  it.each([
    [
      "404 (NotFoundError)",
      404,
      { error: "Agent not found" },
      { outcome: "notFound", message: "Agent not found" },
    ],
    [
      "404 with no message",
      404,
      {},
      { outcome: "notFound", message: "Not found" },
    ],
    [
      "403 (LockedError or an authorization refusal)",
      403,
      { error: "This resource is managed at the organization level" },
      {
        outcome: "forbidden",
        message: "This resource is managed at the organization level",
      },
    ],
    [
      "403 with no message",
      403,
      {},
      {
        outcome: "forbidden",
        message: "You do not have permission to do this.",
      },
    ],
    [
      "409 (ConflictError / unique violation)",
      409,
      { error: "A resource with that name already exists" },
      {
        outcome: "conflict",
        message: "A resource with that name already exists",
      },
    ],
    [
      "400 with a plain string error (ValidationError)",
      400,
      { error: "Invalid label ID" },
      { outcome: "invalid", message: "Invalid label ID", fieldErrors: {} },
    ],
    [
      "an unmapped status",
      500,
      { error: "Internal Server Error" },
      { outcome: "error", message: "Internal Server Error", httpStatus: 500 },
    ],
  ])("maps a %s", async (_name, status, body, expected) => {
    respond(status, body);

    const result = await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1" },
      { id: "a1", data: { name: "x" } },
    );

    expect(result).toEqual(expected);
  });

  it("maps a 400 with sValidator's issue-array shape to invalid with dot-path field errors", async () => {
    respond(400, {
      data: {},
      success: false,
      error: [
        { path: ["modelIds", 1, "alias"], message: "Alias 'dup' duplicates" },
        { path: ["name"], message: "Name is required" },
      ],
    });

    const result = await writeEntity(
      BACKEND_URL,
      "providers",
      { orgId: "org1" },
      { data: {} },
    );

    expect(result).toEqual({
      outcome: "invalid",
      message: "Alias 'dup' duplicates",
      fieldErrors: {
        "modelIds.1.alias": "Alias 'dup' duplicates",
        modelIds: "Alias 'dup' duplicates",
        name: "Name is required",
      },
    });
  });

  it("maps a 400 with a files array (FileValidationError) to invalid, carrying the offending files", async () => {
    respond(400, {
      error: "Some files could not be processed: scan.pdf",
      files: ["scan.pdf"],
    });

    const result = await writeEntity(BACKEND_URL, "attachments", {
      orgId: "org1",
    });

    expect(result).toEqual({
      outcome: "invalid",
      message: "Some files could not be processed: scan.pdf",
      fieldErrors: {},
      files: ["scan.pdf"],
    });
  });

  it("maps a network failure to an error outcome instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    const result = await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1" },
      { data: {} },
    );

    expect(result).toEqual({
      outcome: "error",
      message: "Network request failed",
    });
  });

  it("tolerates a response body that isn't valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "",
        json: async () => {
          throw new SyntaxError("Unexpected end of input");
        },
      } as unknown as Response),
    );

    const result = await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1" },
      { id: "a1" },
    );

    expect(result).toMatchObject({ outcome: "success", data: null });
  });
});

describe("writeAt", () => {
  it.each(["POST", "PATCH"] as const)(
    "sends a %s and its body to the given URL",
    async (method) => {
      const fetchMock = respond(200, { id: "c1" });

      await writeAt(`${BACKEND_URL}/users/me/contexts`, {
        method,
        data: { content: "hi" },
      });

      expect(fetchMock).toHaveBeenCalledWith(
        `${BACKEND_URL}/users/me/contexts`,
        expect.objectContaining({
          method,
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "hi" }),
        }),
      );
    },
  );

  it("sends no body for a DELETE", async () => {
    const fetchMock = respond(200);

    await writeAt(`${BACKEND_URL}/users/me/contexts/c1`, {
      method: "DELETE",
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it("defaults revalidateKeys to an empty array when omitted", async () => {
    respond(200, { ok: true });

    const result = await writeAt(`${BACKEND_URL}/oauth/mcp/callback`, {
      method: "POST",
      data: { code: "x", state: "y" },
    });

    expect(result).toEqual({
      outcome: "success",
      data: { ok: true },
      revalidateKeys: [],
    });
  });

  it("carries caller-supplied revalidateKeys on success", async () => {
    respond(200);

    const result = await writeAt(`${BACKEND_URL}/users/me/contexts/c1`, {
      method: "PUT",
      data: { content: "updated" },
      revalidateKeys: [`${BACKEND_URL}/users/me/contexts`],
    });

    expect(result).toMatchObject({
      outcome: "success",
      revalidateKeys: [`${BACKEND_URL}/users/me/contexts`],
    });
  });

  it("maps outcomes through the same ADR-0010 mapping as writeEntity", async () => {
    respond(409, { error: "You already have a context for this scope" });

    const result = await writeAt(`${BACKEND_URL}/users/me/contexts`, {
      method: "POST",
      data: { content: "hi" },
    });

    expect(result).toEqual({
      outcome: "conflict",
      message: "You already have a context for this scope",
    });
  });
});
