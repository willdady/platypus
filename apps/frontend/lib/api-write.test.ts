import { describe, it, expect, afterEach, vi } from "vitest";
import { writeEntity } from "./api-write";

function mockResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as unknown as Response;
}

const BACKEND_URL = "http://localhost:4000";

describe("writeEntity — transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to the org-scoped collection path when creating with no workspace scope", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse(201, { id: "a1" }));
    vi.stubGlobal("fetch", fetchMock);

    await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1" },
      {
        data: { name: "Bot" },
      },
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
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(201, {}));
    vi.stubGlobal("fetch", fetchMock);

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
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

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
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

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

  it("always sends credentials: include", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1" },
      {
        id: "a1",
      },
    );

    expect(fetchMock.mock.calls[0][1].credentials).toBe("include");
  });
});

describe("writeEntity — outcomes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps a 2xx response to a success outcome carrying the parsed body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse(201, { id: "a1", name: "Bot" })),
    );

    const result = await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1" },
      {
        data: { name: "Bot" },
      },
    );

    expect(result).toEqual({
      outcome: "success",
      data: { id: "a1", name: "Bot" },
      revalidateKeys: ["http://localhost:4000/organizations/org1/agents"],
    });
  });

  it("declares both the collection and item keys to revalidate after an update", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, {})));

    const result = await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1" },
      {
        id: "a1",
        data: { name: "Renamed" },
      },
    );

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.revalidateKeys).toEqual([
        "http://localhost:4000/organizations/org1/agents",
        "http://localhost:4000/organizations/org1/agents/a1",
      ]);
    }
  });

  it("declares only the collection key to revalidate after a delete", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, {})));

    const result = await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1" },
      {
        id: "a1",
      },
    );

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.revalidateKeys).toEqual([
        "http://localhost:4000/organizations/org1/agents",
      ]);
    }
  });

  it("maps 404 (NotFoundError) to a notFound outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(mockResponse(404, { error: "Agent not found" })),
    );

    const result = await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1" },
      {
        id: "missing",
        data: { name: "x" },
      },
    );

    expect(result).toEqual({ outcome: "notFound", message: "Agent not found" });
  });

  it("falls back to a default message when a 404 body carries none", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(404, {})));

    const result = await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1" },
      {
        id: "missing",
        data: {},
      },
    );

    expect(result).toEqual({ outcome: "notFound", message: "Not found" });
  });

  it("maps 403 (LockedError) to a locked outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(403, {
          error: "This resource is managed at the organization level",
        }),
      ),
    );

    const result = await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1" },
      {
        id: "a1",
        data: { name: "x" },
      },
    );

    expect(result).toEqual({
      outcome: "locked",
      message: "This resource is managed at the organization level",
    });
  });

  it("maps 409 (ConflictError / unique violation) to a conflict outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(409, {
          error: "A resource with that name already exists",
        }),
      ),
    );

    const result = await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1" },
      {
        data: { name: "dup" },
      },
    );

    expect(result).toEqual({
      outcome: "conflict",
      message: "A resource with that name already exists",
    });
  });

  it("maps a 400 with sValidator's issue-array shape to invalid with dot-path field errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(400, {
          data: {},
          success: false,
          error: [
            {
              path: ["modelIds", 1, "alias"],
              message: "Alias 'dup' duplicates",
            },
            { path: ["name"], message: "Name is required" },
          ],
        }),
      ),
    );

    const result = await writeEntity(
      BACKEND_URL,
      "providers",
      { orgId: "org1" },
      {
        data: {},
      },
    );

    expect(result.outcome).toBe("invalid");
    if (result.outcome === "invalid") {
      expect(result.fieldErrors).toEqual({
        "modelIds.1.alias": "Alias 'dup' duplicates",
        modelIds: "Alias 'dup' duplicates",
        name: "Name is required",
      });
      expect(result.message).toBe("Alias 'dup' duplicates");
    }
  });

  it("maps a 400 with a files array (FileValidationError) to invalid, carrying the offending files", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(400, {
          error: "Some files could not be processed: scan.pdf",
          files: ["scan.pdf"],
        }),
      ),
    );

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

  it("maps a 400 with a plain string error (ValidationError) to invalid with no field errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(mockResponse(400, { error: "Invalid label ID" })),
    );

    const result = await writeEntity(BACKEND_URL, "boards", {
      orgId: "org1",
      workspaceId: "ws1",
    });

    expect(result).toEqual({
      outcome: "invalid",
      message: "Invalid label ID",
      fieldErrors: {},
    });
  });

  it("maps an unmapped status to a generic error outcome carrying the HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          mockResponse(500, { error: "Internal Server Error" }),
        ),
    );

    const result = await writeEntity(
      BACKEND_URL,
      "agents",
      { orgId: "org1" },
      {
        data: {},
      },
    );

    expect(result).toEqual({
      outcome: "error",
      message: "Internal Server Error",
      httpStatus: 500,
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
      {
        data: {},
      },
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
      {
        id: "a1",
      },
    );

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.data).toBeNull();
    }
  });
});
