import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Store,
} from "../test-utils.ts";
import app from "../server.ts";
import { auth as mcpAuth } from "@ai-sdk/mcp";

vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: vi.fn().mockResolvedValue({
    tools: vi.fn().mockResolvedValue({ tool1: {} }),
    close: vi.fn().mockResolvedValue(undefined),
  }),
  auth: vi.fn(),
}));

/**
 * Seeded rows rather than stubbed query sequences, as in `provider.test.ts`:
 * `seedDb()` evaluates each query's `WHERE`, so a lookup that dropped its
 * Workspace, Organization or Attachment scope reads a row it should not and
 * the test fails.
 */
describe("MCP Routes", () => {
  let fake: FakeDb;

  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/mcps`;

  /**
   * The baseline world: the caller (`user-1`) is a member of `org-1` at the
   * given role and owns `ws-1` and `ws-2`. `mcpSelfManagement` decides whether
   * a non-admin owner may configure MCPs here (ADR-0006).
   */
  const world = (
    options: {
      role?: "admin" | "member";
      mcpSelfManagement?: boolean;
      rows?: Store;
    } = {},
  ): FakeDb => {
    const { role = "admin", mcpSelfManagement = false, rows = {} } = options;
    return seedDb({
      organization_member: [
        { id: "m1", userId: "user-1", organizationId: orgId, role },
      ],
      workspace: [
        {
          id: workspaceId,
          name: "Alpha",
          organizationId: orgId,
          ownerId: "user-1",
          mcpSelfManagement,
        },
        {
          id: "ws-2",
          name: "Beta",
          organizationId: orgId,
          ownerId: "user-1",
          mcpSelfManagement,
        },
      ],
      ...rows,
    });
  };

  /** An MCP owned by this Workspace. */
  const workspaceMcp = (over: Store[string][number] = {}) => ({
    id: "mcp-1",
    name: "WS MCP",
    slug: "ws_mcp",
    url: "http://mcp.com",
    authType: "None",
    organizationId: null,
    workspaceId,
    ...over,
  });

  /** A Shared MCP of this Organization — org-scoped, at no Workspace. */
  const sharedMcp = (over: Store[string][number] = {}) => ({
    id: "mcp-org",
    name: "Shared",
    slug: "shared",
    url: "http://mcp.com",
    authType: "None",
    organizationId: orgId,
    workspaceId: null,
    ...over,
  });

  const attachedHere = (resourceId: string) => ({
    id: "att-1",
    workspaceId,
    resourceType: "mcp",
    resourceId,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });

  const json = (method: string, payload: unknown) => ({
    method,
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });

  describe("POST /", () => {
    // ADR-0006: MCP config is admin-only unless the workspace's
    // mcpSelfManagement flag delegates it to the owner.
    const createBody = {
      name: "New MCP",
      url: "http://mcp.com",
      authType: "None",
      workspaceId,
    };

    const post = (payload: unknown = createBody) =>
      app.request(baseUrl, json("POST", payload));

    it("should create MCP if workspace admin", async () => {
      mockSession();
      fake = world({ rows: { mcp: [] } });

      const res = await post();

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(
        expect.objectContaining({ name: "New MCP", url: "http://mcp.com" }),
      );
      expect(fake.tables.mcp).toEqual([
        expect.objectContaining({
          name: "New MCP",
          slug: "new_mcp",
          workspaceId,
          organizationId: null,
        }),
      ]);
    });

    // The scope-from-route-not-body rule (a caller cannot name another
    // Workspace, or set organizationId and mint a Shared MCP here — only an
    // Org Admin may do that, ADR-0006/0007) is `createMcp`'s job now; see
    // `services/mcp-write.test.ts`'s createMcp tests.

    it("409s on a tool-namespace slug clash within this Organization only", async () => {
      // Guards `assertMcpSlugAvailable`'s Organization filter: `new_mcp` is
      // taken in another Organization's Workspace, which must not block this
      // create, and then in a sibling Workspace of this one, which must.
      mockSession();
      const taken = workspaceMcp({
        id: "mcp-other",
        name: "New-MCP",
        slug: "new_mcp",
        workspaceId: "ws-other",
      });
      fake = world({ rows: { mcp: [taken] } });
      fake.tables.workspace.push({ id: "ws-other", organizationId: "org-2" });

      expect((await post()).status).toBe(201);
      expect(fake.tables.mcp).toHaveLength(2);

      mockSession();
      fake = world({ rows: { mcp: [{ ...taken, workspaceId: "ws-2" }] } });

      const res = await post();
      expect(res.status).toBe(409);
      expect(fake.tables.mcp).toHaveLength(1);
    });

    it("returns 403 for a non-admin owner when self-management is disabled", async () => {
      mockSession();
      fake = world({
        role: "member",
        mcpSelfManagement: false,
        rows: { mcp: [] },
      });

      expect((await post()).status).toBe(403);
      expect(fake.tables.mcp).toHaveLength(0);
    });

    it("allows a non-admin owner when self-management is enabled", async () => {
      mockSession();
      fake = world({
        role: "member",
        mcpSelfManagement: true,
        rows: { mcp: [] },
      });

      expect((await post()).status).toBe(201);
      expect(fake.tables.mcp).toHaveLength(1);
    });
  });

  describe("GET /", () => {
    it("should list workspace-scoped MCPs and only attached org-scoped MCPs", async () => {
      // Four MCPs exist and two are visible here. Drop
      // `eq(mcp.workspaceId, ctx.workspaceId)` from `listScoped` and the other
      // Workspace's private MCP is listed; drop the Attachment join and the
      // unattached Shared one is.
      mockSession();
      world({
        role: "member",
        rows: {
          mcp: [
            workspaceMcp({ id: "mcp-ws" }),
            sharedMcp(),
            sharedMcp({ id: "mcp-unattached", name: "Unattached" }),
            workspaceMcp({ id: "mcp-beta", workspaceId: "ws-2" }),
          ],
          attachment: [attachedHere("mcp-org")],
        },
      });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: unknown[] };
      // listScoped returns Workspace rows first, then attached org rows; the
      // frontend regroups by scope, so order is not observable behaviour.
      expect(body.results).toEqual([
        expect.objectContaining({ id: "mcp-ws", scope: "workspace" }),
        expect.objectContaining({ id: "mcp-org", scope: "organization" }),
      ]);
    });

    it("redacts a Shared MCP's bearerToken from an owner delegated mcpSelfManagement", async () => {
      mockSession();
      world({
        role: "member",
        mcpSelfManagement: true,
        rows: {
          mcp: [
            workspaceMcp({ authType: "Bearer", bearerToken: "ws-tok" }),
            sharedMcp({ authType: "Bearer", bearerToken: "org-tok" }),
          ],
          attachment: [attachedHere("mcp-org")],
        },
      });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain("org-tok");
      // The delegation still reveals the Workspace's own MCP.
      expect(body).toContain("ws-tok");
    });
  });

  describe("GET /:mcpId", () => {
    it("redacts bearerToken when the owner has no mcpSelfManagement", async () => {
      // ADR-0006: an MCP stays listable and grantable without the delegation,
      // but its stored request credentials must not be returned.
      mockSession();
      world({
        role: "member",
        rows: {
          mcp: [
            workspaceMcp({
              authType: "Bearer",
              bearerToken: "tok-secret",
              headers: { "X-Api-Key": "hdr-secret" },
            }),
          ],
        },
      });

      const res = await app.request(`${baseUrl}/mcp-1`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain("tok-secret");
      expect(body).not.toContain("hdr-secret");
      const parsed = JSON.parse(body) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty("bearerToken");
      expect(parsed.bearerTokenSet).toEqual({ configured: true });
    });

    it("reveals bearerToken to an org admin", async () => {
      mockSession();
      world({
        role: "admin",
        rows: {
          mcp: [
            workspaceMcp({ authType: "Bearer", bearerToken: "tok-secret" }),
          ],
        },
      });

      const res = await app.request(`${baseUrl}/mcp-1`);
      expect(res.status).toBe(200);
      const parsed = (await res.json()) as Record<string, unknown>;
      expect(parsed.bearerToken).toBe("tok-secret");
    });

    it("returns a workspace-scoped MCP tagged scope workspace", async () => {
      mockSession();
      world({ role: "member", rows: { mcp: [workspaceMcp()] } });

      const res = await app.request(`${baseUrl}/mcp-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({ id: "mcp-1", scope: "workspace" }),
      );
    });

    it("returns an attached org-scoped MCP tagged scope organization", async () => {
      mockSession();
      world({
        role: "member",
        rows: { mcp: [sharedMcp()], attachment: [attachedHere("mcp-org")] },
      });

      const res = await app.request(`${baseUrl}/mcp-org`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({ id: "mcp-org", scope: "organization" }),
      );
    });

    it("redacts a Shared MCP's bearerToken from an owner delegated mcpSelfManagement", async () => {
      // The delegation covers this Workspace's own MCPs only; a Shared MCP's
      // credentials belong to the Org Admins (ADR-0007).
      mockSession();
      world({
        role: "member",
        mcpSelfManagement: true,
        rows: {
          mcp: [
            sharedMcp({
              authType: "Bearer",
              bearerToken: "org-tok",
              headers: { "X-Api-Key": "org-hdr" },
            }),
          ],
          attachment: [attachedHere("mcp-org")],
        },
      });

      const res = await app.request(`${baseUrl}/mcp-org`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain("org-tok");
      expect(body).not.toContain("org-hdr");
      expect(JSON.parse(body)).not.toHaveProperty("bearerToken");
    });

    it("returns 404 for an org-scoped MCP not attached here", async () => {
      mockSession();
      world({ role: "member", rows: { mcp: [sharedMcp()], attachment: [] } });

      const res = await app.request(`${baseUrl}/mcp-org`);
      expect(res.status).toBe(404);
    });

    it("returns 404 for another workspace's MCP", async () => {
      // Guards the lookup's `eq(mcp.workspaceId, ctx.workspaceId)`: an MCP
      // private to `ws-2` is neither this Workspace's nor Shared.
      mockSession();
      world({
        role: "member",
        rows: { mcp: [workspaceMcp({ workspaceId: "ws-2" })] },
      });

      const res = await app.request(`${baseUrl}/mcp-1`);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:mcpId", () => {
    const updateBody = {
      name: "Renamed",
      url: "http://mcp.com",
      authType: "None",
    };

    const put = (mcpId: string) =>
      app.request(`${baseUrl}/${mcpId}`, json("PUT", updateBody));

    it("updates a workspace-scoped MCP", async () => {
      mockSession();
      fake = world({ rows: { mcp: [workspaceMcp()] } });

      const res = await put("mcp-1");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({ id: "mcp-1", name: "Renamed" }),
      );
      expect(fake.tables.mcp[0]).toMatchObject({
        name: "Renamed",
        slug: "renamed",
      });
    });

    it("returns 403 (locked) when updating an attached org-scoped MCP", async () => {
      mockSession();
      fake = world({
        rows: { mcp: [sharedMcp()], attachment: [attachedHere("mcp-org")] },
      });

      const res = await put("mcp-org");
      // Shared MCPs are managed only on the Organization surface (ADR-0007).
      expect(res.status).toBe(403);
      expect(fake.queries).not.toContainEqual(
        expect.objectContaining({ kind: "update" }),
      );
    });

    it("returns 404 when updating an org-scoped MCP not attached here", async () => {
      mockSession();
      fake = world({ rows: { mcp: [sharedMcp()], attachment: [] } });

      const res = await put("mcp-org");
      expect(res.status).toBe(404);
      expect(fake.tables.mcp[0]).toMatchObject({ name: "Shared" });
    });

    it("returns 404 when updating another workspace's MCP", async () => {
      mockSession();
      fake = world({ rows: { mcp: [workspaceMcp({ workspaceId: "ws-2" })] } });

      const res = await put("mcp-1");
      expect(res.status).toBe(404);
      expect(fake.tables.mcp[0]).toMatchObject({ name: "WS MCP" });
    });
  });

  describe("DELETE /:mcpId", () => {
    const del = (mcpId: string) =>
      app.request(`${baseUrl}/${mcpId}`, { method: "DELETE" });

    it("deletes a workspace-scoped MCP", async () => {
      mockSession();
      fake = world({
        rows: {
          mcp: [workspaceMcp(), workspaceMcp({ id: "mcp-2", name: "Other" })],
          agent: [{ id: "a1", workspaceId, toolSetIds: ["mcp-1", "mcp-2"] }],
        },
      });

      const res = await del("mcp-1");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "MCP deleted" });
      expect(fake.tables.mcp).toEqual([
        expect.objectContaining({ id: "mcp-2" }),
      ]);
      // #689: the deleted MCP's id is scrubbed from referencing Agents.
      expect(fake.tables.agent[0].toolSetIds).toEqual(["mcp-2"]);
    });

    it("returns 403 (locked) when deleting an attached org-scoped MCP", async () => {
      mockSession();
      fake = world({
        rows: { mcp: [sharedMcp()], attachment: [attachedHere("mcp-org")] },
      });

      expect((await del("mcp-org")).status).toBe(403);
      expect(fake.tables.mcp).toHaveLength(1);
    });

    it("returns 404 when deleting an org-scoped MCP not attached here", async () => {
      mockSession();
      fake = world({ rows: { mcp: [sharedMcp()], attachment: [] } });

      expect((await del("mcp-org")).status).toBe(404);
      expect(fake.tables.mcp).toHaveLength(1);
    });

    it("returns 404 when deleting another workspace's MCP", async () => {
      mockSession();
      fake = world({ rows: { mcp: [workspaceMcp({ workspaceId: "ws-2" })] } });

      expect((await del("mcp-1")).status).toBe(404);
      expect(fake.tables.mcp).toHaveLength(1);
    });
  });

  describe("POST /test", () => {
    const probe = (payload: unknown) =>
      app.request(`${baseUrl}/test`, json("POST", payload));

    it("should test MCP connection", async () => {
      mockSession();
      world();

      const res = await probe({ url: "http://mcp.com", authType: "None" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        toolNames: ["tool1"],
        invalidToolNames: [],
      });
    });

    it("namespaces tool names under the slug derived from the given name", async () => {
      mockSession();
      world();

      const res = await probe({
        url: "http://mcp.com",
        authType: "None",
        name: "My Server",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        toolNames: ["my_server__tool1"],
        invalidToolNames: [],
      });
    });

    it("probes an attached org-scoped OAuth MCP — the Shared-MCP visibility fix", async () => {
      // Read-only, so an attached Shared MCP resolves and the probe runs
      // (mcp-connection.ts's docstring), unlike the bare 404 this used to be.
      mockSession();
      world({
        rows: {
          mcp: [
            sharedMcp({ authType: "OAuth", oauthAccessToken: "access-token" }),
          ],
          attachment: [attachedHere("mcp-org")],
        },
      });

      const res = await probe({
        url: "http://mcp.com",
        authType: "OAuth",
        mcpId: "mcp-org",
      });

      expect(res.status).toBe(200);
      // Namespaced under the stored row's slug: the probe used the resolved MCP.
      expect(await res.json()).toEqual({
        success: true,
        toolNames: ["shared__tool1"],
        invalidToolNames: [],
      });
    });

    it("returns a 404 result for an org-scoped OAuth MCP not attached here", async () => {
      mockSession();
      world({ rows: { mcp: [sharedMcp()], attachment: [] } });

      const res = await probe({
        url: "http://mcp.com",
        authType: "OAuth",
        mcpId: "mcp-org",
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "MCP not found" });
    });
  });

  describe("POST /:mcpId/oauth/authorize", () => {
    const authorizeUrl = `${baseUrl}/mcp-1/oauth/authorize`;

    const oauthMcp = workspaceMcp({
      authType: "OAuth",
      url: "http://mcp.example.com",
      oauthAccessToken: "access-old",
      oauthRefreshToken: "refresh-old",
      oauthTokenExpiresAt: new Date(),
      oauthScope: "read",
      oauthClientId: "client-id",
      oauthClientSecret: "client-secret",
      oauthClientDynamicallyRegistered: false,
    });

    it("force=true: clears the four oauth token columns in DB and returns authorizationUrl", async () => {
      mockSession();
      // Another Workspace's MCP under the same id: the token clear is scoped
      // to this Workspace's row (`workspaceScopedWhere`), so it keeps its tokens.
      fake = world({
        rows: { mcp: [oauthMcp, { ...oauthMcp, workspaceId: "ws-2" }] },
      });

      vi.mocked(mcpAuth).mockImplementation(
        (provider: { redirectToAuthorization: (url: URL) => void }) => {
          provider.redirectToAuthorization(
            new URL("https://provider.example.com/authorize?x=1"),
          );
          return Promise.resolve("REDIRECT");
        },
      );

      const res = await app.request(`${authorizeUrl}?force=true`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        authorizationUrl: "https://provider.example.com/authorize?x=1",
      });

      // The token clear leaves the client alone; only a dynamically registered
      // one is dropped, by its own guarded UPDATE (see mcp-connection.test.ts).
      expect(fake.tables.mcp[0]).toMatchObject({
        oauthAccessToken: null,
        oauthRefreshToken: null,
        oauthTokenExpiresAt: null,
        oauthScope: null,
        oauthClientId: "client-id",
        oauthClientSecret: "client-secret",
      });
      expect(fake.tables.mcp[1]).toMatchObject({
        oauthAccessToken: "access-old",
      });
    });

    it("no force flag: leaves token columns untouched when SDK silently refreshes", async () => {
      mockSession();
      fake = world({ rows: { mcp: [oauthMcp] } });

      vi.mocked(mcpAuth).mockResolvedValue("AUTHORIZED");

      const res = await app.request(authorizeUrl, { method: "POST" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ alreadyAuthorized: true });
      expect(fake.tables.mcp[0]).toMatchObject({
        oauthAccessToken: "access-old",
        oauthRefreshToken: "refresh-old",
      });
    });

    it("returns 403 (locked) for an attached org-scoped MCP — mutates org-owned credentials", async () => {
      // Shared-MCP visibility fix: this used to be a bare 404 that denied the
      // row exists; it is now the same Locked refusal PUT/DELETE give.
      mockSession();
      fake = world({
        rows: {
          mcp: [sharedMcp({ authType: "OAuth", oauthAccessToken: "tok" })],
          attachment: [attachedHere("mcp-org")],
        },
      });

      const res = await app.request(`${baseUrl}/mcp-org/oauth/authorize`, {
        method: "POST",
      });

      expect(res.status).toBe(403);
      expect(fake.tables.mcp[0]).toMatchObject({ oauthAccessToken: "tok" });
    });

    it("returns 404 for an org-scoped MCP not attached here", async () => {
      mockSession();
      world({ rows: { mcp: [sharedMcp()], attachment: [] } });

      const res = await app.request(`${baseUrl}/mcp-org/oauth/authorize`, {
        method: "POST",
      });

      expect(res.status).toBe(404);
    });
  });

  describe("POST /:mcpId/oauth/revoke", () => {
    const revoke = (mcpId: string) =>
      app.request(`${baseUrl}/${mcpId}/oauth/revoke`, { method: "POST" });

    const tokens = {
      authType: "OAuth",
      oauthAccessToken: "tok",
      oauthRefreshToken: "refresh",
      oauthTokenExpiresAt: new Date(),
      oauthScope: "read",
    };

    it("clears tokens for a workspace-scoped MCP", async () => {
      mockSession();
      fake = world({ rows: { mcp: [workspaceMcp(tokens)] } });

      const res = await revoke("mcp-1");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        message: "OAuth authorization revoked",
      });
      expect(fake.tables.mcp[0]).toMatchObject({
        oauthAccessToken: null,
        oauthRefreshToken: null,
        oauthTokenExpiresAt: null,
        oauthScope: null,
      });
    });

    it("returns 403 (locked) for an attached org-scoped MCP", async () => {
      // Same refusal semantics as PUT/DELETE and /oauth/authorize above.
      mockSession();
      fake = world({
        rows: {
          mcp: [sharedMcp(tokens)],
          attachment: [attachedHere("mcp-org")],
        },
      });

      expect((await revoke("mcp-org")).status).toBe(403);
      expect(fake.tables.mcp[0]).toMatchObject({ oauthAccessToken: "tok" });
    });

    it("returns 404 for an org-scoped MCP not attached here", async () => {
      mockSession();
      fake = world({ rows: { mcp: [sharedMcp(tokens)], attachment: [] } });

      expect((await revoke("mcp-org")).status).toBe(404);
      expect(fake.tables.mcp[0]).toMatchObject({ oauthAccessToken: "tok" });
    });
  });
});
