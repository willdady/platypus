import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
  type Store,
} from "../test-utils.ts";
import app from "../server.ts";

describe("Organization Provider Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/providers`;

  const json = (method: string, body: unknown) => ({
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

  /** A Shared Provider of `org-1`. */
  const sharedProvider = (over: Row = {}): Row => ({
    id: "p1",
    name: "Org OpenAI",
    providerType: "OpenAI",
    apiKey: "sk-secret",
    organizationId: orgId,
    workspaceId: null,
    modelIds: [{ id: "gpt-4" }],
    ...over,
  });

  /**
   * The caller (`user-1`) is a member of `org-1` at `role`. Alongside `org-1`'s
   * Shared Provider sit two this surface must never reach: another
   * Organization's Shared Provider and a Workspace-scoped Provider of its own
   * org — all three named alike, so only the scope tells them apart.
   */
  const world = (
    role: "admin" | "member" = "admin",
    rows: Store = {},
  ): FakeDb =>
    seedDb(
      {
        organization_member: [
          { id: "m1", userId: "user-1", organizationId: orgId, role },
        ],
        workspace: [{ id: "ws-1", organizationId: orgId, ownerId: "user-1" }],
        provider: [
          sharedProvider(),
          sharedProvider({ id: "p-other-org", organizationId: "org-2" }),
          sharedProvider({
            id: "p-ws",
            organizationId: null,
            workspaceId: "ws-1",
          }),
        ],
        ...rows,
      },
      {
        unique: {
          provider: [
            {
              name: "unique_provider_name_org",
              columns: ["organizationId", "name"],
              where: (row) => row.organizationId != null,
            },
          ],
        },
      },
    );

  const idsOf = (fake: FakeDb) => fake.tables.provider.map((p) => p.id);

  describe("POST /", () => {
    const createBody = {
      name: "New OpenAI",
      providerType: "OpenAI",
      apiKey: "sk-123",
      modelIds: ["gpt-4"],
      taskModelId: "gpt-4",
      memoryExtractionModelId: "gpt-4",
      organizationId: orgId,
    };

    it("should create org provider if org admin", async () => {
      mockSession();
      const fake = world("admin");

      const res = await app.request(baseUrl, json("POST", createBody));

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        name: "New OpenAI",
        providerType: "OpenAI",
        organizationId: orgId,
        workspaceId: null,
      });
      expect(fake.tables.provider).toHaveLength(4);
    });

    it("should fail if not org admin", async () => {
      mockSession();
      const fake = world("member");

      const res = await app.request(baseUrl, json("POST", createBody));

      expect(res.status).toBe(403);
      expect(fake.tables.provider).toHaveLength(3);
    });

    it("should return 409 if provider name already exists in org", async () => {
      mockSession();
      // The database refuses the duplicate `(organizationId, name)` pair.
      const fake = world("admin");

      const res = await app.request(
        baseUrl,
        json("POST", { ...createBody, name: "Org OpenAI" }),
      );

      // The unique violation flows through the central onError (ADR-0010).
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "A resource with that name already exists",
      });
      expect(fake.tables.provider).toHaveLength(3);
    });
  });

  describe("GET /", () => {
    const list = async () => {
      const res = await app.request(baseUrl);
      const body = (await res.json()) as { results: Row[] };
      return { status: res.status, results: body.results };
    };

    // Guards listOrgScoped's `organizationId = orgId` filter.
    it("should list only this organization's Shared providers", async () => {
      mockSession();
      world("member");

      const { status, results } = await list();

      expect(status).toBe(200);
      expect(results.map((r) => r.id)).toEqual(["p1"]);
    });

    it("redacts apiKey for a non-admin member", async () => {
      // A plain member may list Shared Providers — it is how one is selected —
      // but credentials are Org-Admin-only (ADR-0006), so the row comes back
      // with the secret fields replaced by presence flags.
      mockSession();
      world("member");

      const [row] = (await list()).results;

      expect(row).not.toHaveProperty("apiKey");
      expect(row).toMatchObject({
        apiKeySet: { configured: true },
        headersSet: { configured: false },
      });
    });

    it("reveals apiKey to an org admin", async () => {
      mockSession();
      world("admin");

      const [row] = (await list()).results;

      expect(row.apiKey).toBe("sk-secret");
    });
  });

  describe("GET /:providerId", () => {
    it("should return org provider, redacted for a member", async () => {
      mockSession();
      world("member");

      const res = await app.request(`${baseUrl}/p1`);

      expect(res.status).toBe(200);
      // Credentials are Org-Admin-only (ADR-0006); see the list route.
      const body = (await res.json()) as Row;
      expect(body).toMatchObject({
        id: "p1",
        name: "Org OpenAI",
        apiKeySet: { configured: true },
      });
      expect(body).not.toHaveProperty("apiKey");
    });

    it.each([
      ["another organization's Shared provider", "p-other-org"],
      ["a Workspace-scoped provider", "p-ws"],
    ])("returns 404 for %s", async (_label, id) => {
      mockSession();
      world("admin");

      const res = await app.request(`${baseUrl}/${id}`);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:providerId", () => {
    const updateBody = {
      name: "Renamed",
      providerType: "OpenAI",
      apiKey: "sk-123",
      modelIds: ["gpt-4"],
      taskModelId: "gpt-4",
      memoryExtractionModelId: "gpt-4",
    };

    it("updates an org provider and returns the row", async () => {
      mockSession();
      const fake = world("admin");

      const res = await app.request(`${baseUrl}/p1`, json("PUT", updateBody));

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: "p1",
        name: "Renamed",
        organizationId: orgId,
        aliasRepoints: [],
      });
      expect(fake.tables.provider.find((p) => p.id === "p1")).toMatchObject({
        name: "Renamed",
      });
    });

    // #605: the org surface used to skip this check entirely, discovering a
    // missing Provider only when the UPDATE matched no row. Guards
    // requireOrgScoped's `organizationId = orgId` filter.
    it.each([
      ["missing", "missing"],
      ["another organization's Shared provider", "p-other-org"],
      ["a Workspace-scoped provider", "p-ws"],
    ])("returns 404 for %s, without touching the write", async (_label, id) => {
      mockSession();
      const fake = world("admin");

      const res = await app.request(
        `${baseUrl}/${id}`,
        json("PUT", updateBody),
      );

      expect(res.status).toBe(404);
      expect(fake.tables.provider.map((p) => p.name)).not.toContain("Renamed");
      expect(fake.queries.some((q) => q.kind === "update")).toBe(false);
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      const fake = world("member");

      const res = await app.request(`${baseUrl}/p1`, json("PUT", updateBody));

      expect(res.status).toBe(403);
      expect(fake.queries.some((q) => q.kind === "update")).toBe(false);
    });
  });

  describe("DELETE /:providerId", () => {
    const remove = (id = "p1") =>
      app.request(`${baseUrl}/${id}`, { method: "DELETE" });

    it("deletes an org provider if admin and not attached", async () => {
      mockSession();
      const fake = world("admin");

      const res = await remove();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Provider deleted" });
      expect(idsOf(fake)).toEqual(["p-other-org", "p-ws"]);
    });

    it("invalidates memory embeddings before deleting, without de-migrating aliases", async () => {
      // The delete path used to run neither helper (#605): a Provider's
      // models — and any alias among them — vanish along with the row, so
      // there is no surviving concrete id for de-migration to rewrite to, but
      // stale embedding vectors computed against it must still be cleared.
      mockSession();
      const fake = world("admin");

      const res = await remove();

      expect(res.status).toBe(200);
      // nullifyEmbeddingsForProvider
      expect(fake.execute).toHaveBeenCalledTimes(1);
      expect(idsOf(fake)).not.toContain("p1");
    });

    it.each([
      ["another organization's Shared provider", "p-other-org"],
      ["a Workspace-scoped provider", "p-ws"],
    ])("returns 404 for %s, leaving it in place", async (_label, id) => {
      mockSession();
      const fake = world("admin");

      const res = await remove(id);

      expect(res.status).toBe(404);
      expect(idsOf(fake)).toEqual(["p1", "p-other-org", "p-ws"]);
    });

    it("returns 409 when the provider is attached to a workspace", async () => {
      mockSession();
      const fake = world("admin", {
        attachment: [
          {
            id: "att-1",
            workspaceId: "ws-1",
            resourceType: "provider",
            resourceId: "p1",
          },
        ],
      });

      const res = await remove();

      expect(res.status).toBe(409);
      expect(idsOf(fake)).toContain("p1");
    });

    it("returns 409 when the provider is listed in a blueprint", async () => {
      mockSession();
      const fake = world("admin", {
        blueprint_item: [
          {
            id: "bpi-1",
            blueprintId: "bp-1",
            resourceType: "provider",
            resourceId: "p1",
          },
        ],
      });

      const res = await remove();

      expect(res.status).toBe(409);
      expect(idsOf(fake)).toContain("p1");
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      const fake = world("member");

      const res = await remove();

      expect(res.status).toBe(403);
      expect(idsOf(fake)).toContain("p1");
    });
  });
});
