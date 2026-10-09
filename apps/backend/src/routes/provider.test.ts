import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Store,
} from "../test-utils.ts";
import app from "../server.ts";

/**
 * These tests state fixture rows rather than counting queries: `seedDb()`
 * installs the in-memory fake executor from `fake-db.ts`, which interprets the
 * `WHERE` each query builds. The stub sequences this file used to carry —
 * membership, then workspace, then the resource, then the delegation flag, in
 * the order the middleware happened to issue them, and a different number of
 * them for an admin than for an owner — are gone: what the route sees now
 * follows from the rows, so a lookup that dropped its Workspace or Organization
 * column reads a row it should not and the test fails.
 */
describe("Provider Routes", () => {
  let fake: FakeDb;

  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/providers`;

  /**
   * The baseline world: the caller (`user-1`) is a member of `org-1` at the
   * given role and owns `ws-1`. `providerSelfManagement` decides whether a
   * non-admin owner may configure Providers here (ADR-0006).
   */
  const world = (
    options: {
      role?: "admin" | "member";
      providerSelfManagement?: boolean;
      rows?: Store;
    } = {},
  ): FakeDb => {
    const {
      role = "admin",
      providerSelfManagement = false,
      rows = {},
    } = options;
    return seedDb(
      {
        organization_member: [
          { id: "m1", userId: "user-1", organizationId: orgId, role },
        ],
        workspace: [
          {
            id: workspaceId,
            name: "Alpha",
            organizationId: orgId,
            ownerId: "user-1",
            providerSelfManagement,
          },
          {
            id: "ws-2",
            name: "Beta",
            organizationId: orgId,
            ownerId: "user-1",
            providerSelfManagement,
          },
        ],
        ...rows,
      },
      {
        unique: {
          provider: [
            {
              name: "unique_provider_name_workspace",
              columns: ["workspaceId", "name"],
            },
          ],
        },
      },
    );
  };

  /** A Provider owned by this Workspace. */
  const workspaceProvider = (over: Store[string][number] = {}) => ({
    id: "p1",
    name: "WS OpenAI",
    providerType: "OpenAI",
    apiKey: "sk-secret",
    organizationId: null,
    workspaceId,
    modelIds: [{ id: "gpt-4" }],
    ...over,
  });

  /** A Shared Provider of this Organization — org-scoped, at no Workspace. */
  const sharedProvider = (over: Store[string][number] = {}) => ({
    id: "p2",
    name: "Org OpenAI",
    providerType: "OpenAI",
    apiKey: "sk-org",
    organizationId: orgId,
    workspaceId: null,
    modelIds: [{ id: "gpt-4" }],
    ...over,
  });

  const attachedHere = (resourceId: string) => ({
    id: "att-1",
    workspaceId,
    resourceType: "provider",
    resourceId,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });

  describe("POST /", () => {
    const createBody = {
      name: "OpenAI",
      providerType: "OpenAI",
      apiKey: "sk-123",
      modelIds: ["gpt-4"],
      taskModelId: "gpt-4",
      memoryExtractionModelId: "gpt-4",
      workspaceId,
    };

    const post = (payload: unknown = createBody) =>
      app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      });

    it("should create provider if workspace admin", async () => {
      mockSession();
      fake = world({ rows: { provider: [] } });

      const res = await post();

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(
        expect.objectContaining({ name: "OpenAI", providerType: "OpenAI" }),
      );
      expect(fake.tables.provider).toHaveLength(1);
    });

    it("takes the scope from the route, ignoring any scope in the body", async () => {
      // A workspace-surface create is always Workspace-scoped. Spreading the body
      // let a caller name another Workspace, or set organizationId and mint a
      // Shared Provider here — which only an Org Admin may do (ADR-0006/0007).
      mockSession();
      fake = world({ rows: { provider: [] } });

      const res = await post({
        ...createBody,
        workspaceId: "ws-2",
        organizationId: orgId,
      });

      expect(res.status).toBe(201);
      expect(fake.tables.provider[0]).toMatchObject({
        workspaceId,
        organizationId: null,
      });
    });

    it("should return 409 if provider name already exists in workspace", async () => {
      mockSession();
      // The database refuses the duplicate `(workspaceId, name)` pair, and the
      // unique violation flows through the central onError (ADR-0010).
      fake = world({
        rows: { provider: [workspaceProvider({ name: "Duplicate OpenAI" })] },
      });

      const res = await post({ ...createBody, name: "Duplicate OpenAI" });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "A resource with that name already exists",
      });
      expect(fake.tables.provider).toHaveLength(1);
    });

    // ADR-0006: workspace-provider config is admin-only unless the workspace's
    // providerSelfManagement flag delegates it to the owner.
    it("returns 403 for a non-admin owner when self-management is disabled", async () => {
      mockSession();
      fake = world({
        role: "member",
        providerSelfManagement: false,
        rows: { provider: [] },
      });

      const res = await post();
      expect(res.status).toBe(403);
      expect(fake.tables.provider).toHaveLength(0);
    });

    it("allows a non-admin owner when self-management is enabled", async () => {
      mockSession();
      fake = world({
        role: "member",
        providerSelfManagement: true,
        rows: { provider: [] },
      });

      const res = await post();
      expect(res.status).toBe(201);
      expect(fake.tables.provider).toHaveLength(1);
    });
  });

  describe("GET /", () => {
    const list = async () => {
      const res = await app.request(baseUrl);
      const data = (await res.json()) as {
        results: Record<string, unknown>[];
      };
      return { status: res.status, results: data.results };
    };

    it("lists this workspace's providers and only the org providers attached here", async () => {
      // Four Providers exist and two are visible here. Drop
      // `eq(provider.workspaceId, ctx.workspaceId)` from `listScoped` and the
      // other Workspace's private Provider is listed; drop the Attachment join
      // and the unattached Shared one is.
      mockSession();
      world({
        role: "member",
        rows: {
          provider: [
            workspaceProvider(),
            sharedProvider(),
            // Shared, but attached to no workspace of ours.
            sharedProvider({ id: "p3", name: "Unattached" }),
            // Another workspace's private Provider.
            workspaceProvider({
              id: "p4",
              name: "Beta OpenAI",
              workspaceId: "ws-2",
            }),
          ],
          attachment: [attachedHere("p2")],
        },
      });

      const { status, results } = await list();
      expect(status).toBe(200);
      expect(results).toEqual([
        expect.objectContaining({ id: "p1", scope: "workspace" }),
        expect.objectContaining({ id: "p2", scope: "organization" }),
      ]);
    });

    it("redacts apiKey when the owner has no providerSelfManagement", async () => {
      // ADR-0006: a Workspace Owner who was not delegated Provider management
      // may still LIST providers — selecting one on an Agent does not need the
      // delegation — but must not receive the stored credential.
      mockSession();
      world({
        role: "member",
        providerSelfManagement: false,
        rows: {
          provider: [
            workspaceProvider({ headers: { Authorization: "Bearer nope" } }),
          ],
        },
      });

      const { status, results } = await list();
      expect(status).toBe(200);
      const [row] = results;
      expect(row).not.toHaveProperty("apiKey");
      expect(row).not.toHaveProperty("headers");
      expect(row.apiKeySet).toEqual({ configured: true });
      expect(row.headersSet).toEqual({ configured: true });
      expect(JSON.stringify(results)).not.toContain("sk-secret");
    });

    it("reveals apiKey to an org admin", async () => {
      mockSession();
      world({ role: "admin", rows: { provider: [workspaceProvider()] } });

      const { status, results } = await list();
      expect(status).toBe(200);
      expect(results[0].apiKey).toBe("sk-secret");
    });

    it("reveals apiKey to an owner who was delegated providerSelfManagement", async () => {
      mockSession();
      world({
        role: "member",
        providerSelfManagement: true,
        rows: { provider: [workspaceProvider()] },
      });

      const { status, results } = await list();
      expect(status).toBe(200);
      expect(results[0].apiKey).toBe("sk-secret");
    });

    it("redacts a Shared Provider's apiKey from an owner delegated providerSelfManagement", async () => {
      // The delegation covers this Workspace's own Providers only; a Shared
      // Provider's credentials belong to the Org Admins (ADR-0007).
      mockSession();
      world({
        role: "member",
        providerSelfManagement: true,
        rows: {
          provider: [
            sharedProvider({ headers: { Authorization: "Bearer org-hdr" } }),
          ],
          attachment: [attachedHere("p2")],
        },
      });

      const { status, results } = await list();
      expect(status).toBe(200);
      expect(results[0]).not.toHaveProperty("apiKey");
      expect(results[0]).not.toHaveProperty("headers");
      expect(JSON.stringify(results)).not.toContain("sk-org");
      expect(JSON.stringify(results)).not.toContain("org-hdr");
    });
  });

  describe("GET /:providerId", () => {
    it("should return provider with scope", async () => {
      mockSession();
      world({
        role: "member",
        rows: {
          provider: [workspaceProvider({ apiKey: "", headers: null })],
        },
      });

      const res = await app.request(`${baseUrl}/p1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({
          id: "p1",
          apiKeySet: { configured: false },
          headersSet: { configured: false },
          scope: "workspace",
        }),
      );
    });

    it("redacts apiKey when the owner has no providerSelfManagement", async () => {
      mockSession();
      world({
        role: "member",
        providerSelfManagement: false,
        rows: { provider: [workspaceProvider()] },
      });

      const res = await app.request(`${baseUrl}/p1`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain("sk-secret");
      expect(JSON.parse(body)).not.toHaveProperty("apiKey");
    });

    it("redacts a Shared Provider's apiKey from an owner delegated providerSelfManagement", async () => {
      mockSession();
      world({
        role: "member",
        providerSelfManagement: true,
        rows: {
          provider: [sharedProvider()],
          attachment: [attachedHere("p2")],
        },
      });

      const res = await app.request(`${baseUrl}/p2`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain("sk-org");
      expect(JSON.parse(body)).not.toHaveProperty("apiKey");
    });

    it("should 404 for an org-scoped provider not attached here", async () => {
      mockSession();
      world({
        role: "member",
        rows: { provider: [sharedProvider()], attachment: [] },
      });

      const res = await app.request(`${baseUrl}/p2`);
      expect(res.status).toBe(404);
    });

    it("should 404 for another workspace's provider", async () => {
      // The lookup matches this Workspace's rows or a Shared row of this Org,
      // and classifies by the scope column the row actually carries — a
      // Provider private to `ws-2` is neither.
      mockSession();
      world({
        role: "member",
        rows: {
          provider: [
            workspaceProvider({
              id: "p4",
              name: "Beta OpenAI",
              workspaceId: "ws-2",
            }),
          ],
        },
      });

      const res = await app.request(`${baseUrl}/p4`);
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

    const put = (providerId: string, payload: unknown = updateBody) =>
      app.request(`${baseUrl}/${providerId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      });

    it("updates a workspace-scoped provider and returns the row", async () => {
      mockSession();
      fake = world({ rows: { provider: [workspaceProvider()] } });

      const res = await put("p1");

      expect(res.status).toBe(200);
      // The single row, not the raw `.returning()` array, plus the
      // alias de-migration report (empty — no alias was removed).
      expect(await res.json()).toEqual(
        expect.objectContaining({
          id: "p1",
          name: "Renamed",
          aliasRepoints: [],
        }),
      );
      expect(fake.tables.provider[0]).toMatchObject({ name: "Renamed" });
    });

    it("reports how many Agents and Chats were repointed when an alias is removed", async () => {
      mockSession();
      // The alias `flagship` exists before this save and not after it, so the
      // Agents and Chats that referenced it fall back to the concrete model.
      fake = world({
        rows: {
          provider: [
            workspaceProvider({
              modelIds: [{ id: "gpt-4", alias: "flagship" }],
            }),
          ],
          agent: [
            { id: "a1", providerId: "p1", modelId: "alias:flagship" },
            { id: "a2", providerId: "p1", modelId: "alias:FLAGSHIP" },
            // Another Provider's Agent, and one on a different model.
            { id: "a3", providerId: "p9", modelId: "alias:flagship" },
            { id: "a4", providerId: "p1", modelId: "gpt-4" },
          ],
          chat: [{ id: "c1", providerId: "p1", modelId: "alias:flagship" }],
        },
      });

      const res = await put("p1");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({
          aliasRepoints: [
            { alias: "flagship", modelId: "gpt-4", agents: 2, chats: 1 },
          ],
        }),
      );
      // The other Provider's Agent keeps its dangling reference: the repoint is
      // keyed on this Provider, not on the alias alone.
      expect(fake.tables.agent.map((row) => row.modelId)).toEqual([
        "gpt-4",
        "gpt-4",
        "alias:flagship",
        "gpt-4",
      ]);
    });

    it("should 403 when updating an attached org-scoped provider", async () => {
      mockSession();
      // Visible here through its Attachment, but Shared providers are edited
      // only on the Organization surface (ADR-0007).
      fake = world({
        rows: {
          provider: [sharedProvider()],
          attachment: [attachedHere("p2")],
        },
      });

      const res = await put("p2");
      expect(res.status).toBe(403);
      expect(fake.tables.provider[0]).toMatchObject({ name: "Org OpenAI" });
    });

    it("should 404 when updating another workspace's provider", async () => {
      mockSession();
      fake = world({
        rows: {
          provider: [workspaceProvider({ id: "p4", workspaceId: "ws-2" })],
        },
      });

      const res = await put("p4");
      expect(res.status).toBe(404);
      expect(fake.tables.provider[0]).toMatchObject({ name: "WS OpenAI" });
    });
  });

  describe("DELETE /:providerId", () => {
    it("deletes a workspace-scoped provider", async () => {
      mockSession();
      fake = world({ rows: { provider: [workspaceProvider()] } });

      const res = await app.request(`${baseUrl}/p1`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Provider deleted" });
      expect(fake.tables.provider).toHaveLength(0);
      // #605: the delete path used to run neither helper. A Provider's models
      // — and any alias among them — vanish along with the row, so there is
      // no surviving concrete id for de-migration to rewrite to, but stale
      // embedding vectors computed against it must still be cleared.
      expect(fake.execute).toHaveBeenCalledTimes(1);
    });

    it("should 409 naming the agents that still use the provider", async () => {
      mockSession();
      fake = world({
        rows: {
          provider: [workspaceProvider()],
          agent: [
            { id: "a1", workspaceId, providerId: "p1", name: "Helper" },
            { id: "a2", workspaceId, providerId: "p1", name: "Writer" },
          ],
        },
      });

      const res = await app.request(`${baseUrl}/p1`, { method: "DELETE" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error:
          'Cannot delete: this provider is used by 2 agents ("Helper", "Writer"). Delete them or switch them to another provider first.',
      });
      expect(fake.tables.provider).toHaveLength(1);
      expect(fake.execute).not.toHaveBeenCalled();
    });

    it("should 404 when deleting an org-scoped provider not attached here", async () => {
      mockSession();
      fake = world({
        rows: { provider: [sharedProvider()], attachment: [] },
      });

      const res = await app.request(`${baseUrl}/p2`, { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(fake.tables.provider).toHaveLength(1);
      expect(fake.execute).not.toHaveBeenCalled();
    });

    it("should 403 when deleting an attached org-scoped provider", async () => {
      mockSession();
      fake = world({
        rows: {
          provider: [sharedProvider()],
          attachment: [attachedHere("p2")],
        },
      });

      const res = await app.request(`${baseUrl}/p2`, { method: "DELETE" });
      expect(res.status).toBe(403);
      expect(fake.tables.provider).toHaveLength(1);
      expect(fake.execute).not.toHaveBeenCalled();
    });

    it("should 404 when deleting another workspace's provider", async () => {
      mockSession();
      fake = world({
        rows: {
          provider: [workspaceProvider({ id: "p4", workspaceId: "ws-2" })],
        },
      });

      const res = await app.request(`${baseUrl}/p4`, { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(fake.tables.provider).toHaveLength(1);
    });
  });
});
