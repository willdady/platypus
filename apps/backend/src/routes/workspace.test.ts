import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  resetMockDb,
  seedDb,
  useTempDiskStorage,
  putStoredFiles,
  isStored,
} from "../test-utils.ts";
import { mockLogger } from "../test-setup.ts";
import { getStorage } from "../storage/index.ts";
import app from "../server.ts";
import { resolveScoped } from "../services/scoped-resource.ts";
import {
  workspace as workspaceTable,
  provider as providerTable,
} from "../db/schema.ts";

// The memory pointer-settings must resolve through the Scoped resource
// authority, not a bare id lookup (GHSA-qg7h-g2rm-37qh). Spy on it so the tests
// assert the route delegates the scoping decision — the chained mockDb ignores
// WHERE predicates and cannot itself tell a scoped lookup from a global one.
vi.mock("../services/scoped-resource.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/scoped-resource.ts")>()),
  resolveScoped: vi.fn(),
}));
const resolveScopedMock = vi.mocked(resolveScoped);

describe("Workspace Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();

    // Force reset where to ensure it returns mockDb
    mockDb.where.mockReturnValue(mockDb);
  });

  describe("POST /organizations/:orgId/workspaces", () => {
    // ADR-0008: Workspace creation is org-admin-only.
    it("should create workspace for an org admin", async () => {
      mockSession({ id: "user-1", role: "user" });

      // Mock requireOrgAccess: return admin role
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);

      // Mock insert
      const mockWorkspace = { id: "ws-1", name: "New Workspace" };
      mockDb.returning.mockResolvedValueOnce([mockWorkspace]);

      const res = await app.request("/organizations/org-1/workspaces", {
        method: "POST",
        body: JSON.stringify({
          name: "New Workspace",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockWorkspace);
      // Owner defaults to the calling admin when no ownerId is supplied.
      const insertedValues = mockDb.values.mock.calls.at(-1)?.[0];
      expect(insertedValues).toMatchObject({
        ownerId: "user-1",
        organizationId: "org-1",
      });
    });

    // ADR-0008: a regular member can no longer self-create Workspaces.
    it("should return 403 for a regular member", async () => {
      mockSession({ id: "user-1", role: "user" });

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await app.request("/organizations/org-1/workspaces", {
        method: "POST",
        body: JSON.stringify({
          name: "New Workspace",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(403);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    // ADR-0008: ownerId is admin-assignable to another org member.
    it("should let an admin assign a different owner who is a member", async () => {
      mockSession({ id: "admin-1", role: "user" });

      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ userId: "member-2" }]); // owner is a member
      const mockWorkspace = { id: "ws-1", name: "Member Workspace" };
      mockDb.returning.mockResolvedValueOnce([mockWorkspace]);

      const res = await app.request("/organizations/org-1/workspaces", {
        method: "POST",
        body: JSON.stringify({
          name: "Member Workspace",
          ownerId: "member-2",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      const insertedValues = mockDb.values.mock.calls.at(-1)?.[0];
      expect(insertedValues).toMatchObject({
        ownerId: "member-2",
        organizationId: "org-1",
      });
    });

    // Governance: an admin cannot hand a workspace to a non-member.
    it("should return 400 when the assigned owner is not an org member", async () => {
      mockSession({ id: "admin-1", role: "user" });

      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([]); // owner not a member

      const res = await app.request("/organizations/org-1/workspaces", {
        method: "POST",
        body: JSON.stringify({
          name: "Member Workspace",
          ownerId: "outsider",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Owner must be a member of the organization",
      });
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    // The organization id is a tenancy boundary. It is derived from the path
    // after requireOrgAccess, rather than accepted from the request body.
    it("binds a workspace to the authorized organization", async () => {
      mockSession({ id: "admin-1", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.returning.mockResolvedValueOnce([
        { id: "ws-1", name: "Bound Workspace", organizationId: "org-1" },
      ]);

      const res = await app.request("/organizations/org-1/workspaces", {
        method: "POST",
        body: JSON.stringify({
          name: "Bound Workspace",
          // A stale or malicious client cannot redirect creation into org-2.
          organizationId: "org-2",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org-1",
          ownerId: "admin-1",
        }),
      );
    });
  });

  describe("POST /organizations/:orgId/workspaces with provisioned resources", () => {
    const post = (body: unknown) =>
      app.request("/organizations/org-1/workspaces", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });

    const provider = {
      name: "OpenAI",
      providerType: "OpenAI",
      apiKey: "sk-test",
      modelIds: [{ id: "gpt-5" }],
      taskModelId: "gpt-5",
      memoryExtractionModelId: "gpt-5",
    };

    it("creates the Workspace, its Provider, Attachments and Sandbox in one transaction", async () => {
      mockSession({ id: "admin-1", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { id: "shared-1", organizationId: "org-1" },
      ]); // the Shared Provider resolves in this org
      mockDb.returning.mockResolvedValueOnce([{ id: "ws-1", name: "Ready" }]);
      mockDb.returning.mockResolvedValueOnce([{ id: "p-1" }]);

      const res = await post({
        name: "Ready",
        provider,
        sharedProviderIds: ["shared-1"],
        sandbox: { name: "Local", backend: "docker" },
      });

      expect(res.status).toBe(201);
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      const inserted = mockDb.values.mock.calls.map((call) => call[0]);
      expect(inserted).toEqual([
        expect.objectContaining({ name: "Ready", organizationId: "org-1" }),
        // The new Provider is scoped to the new Workspace, never the body.
        expect.objectContaining({
          name: "OpenAI",
          workspaceId: "ws-1",
          organizationId: null,
        }),
        [
          expect.objectContaining({
            workspaceId: "ws-1",
            resourceType: "provider",
            resourceId: "shared-1",
          }),
        ],
        expect.objectContaining({ name: "Local", workspaceId: "ws-1" }),
      ]);
      // The nested resources are not columns of the Workspace row.
      expect(inserted[0]).not.toHaveProperty("provider");
      expect(inserted[0]).not.toHaveProperty("sandbox");
    });

    it("returns 404 and writes nothing when a Shared Provider is not in this org", async () => {
      mockSession({ id: "admin-1", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([]); // not an org-scoped Provider here

      const res = await post({
        name: "Ready",
        sharedProviderIds: ["elsewhere"],
      });

      expect(res.status).toBe(404);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("returns 400 and writes nothing when the Sandbox is invalid", async () => {
      mockSession({ id: "admin-1", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);

      const res = await post({
        name: "Ready",
        provider,
        sandbox: {
          name: "Local",
          backend: "docker",
          adminEnv: { TOKEN: "a" },
          userEnv: { TOKEN: "b" },
        },
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/TOKEN/);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("GET /organizations/:orgId/workspaces", () => {
    // ws-a/ws-b sit in org-1 (the caller owns ws-a); ws-c is the caller's own
    // Workspace in another org, so a list that dropped its org scope shows it.
    const seedWorkspaces = (role: "admin" | "member") =>
      seedDb({
        organization_member: [
          { id: "m1", userId: "user-1", organizationId: "org-1", role },
        ],
        workspace: [
          { id: "ws-a", organizationId: "org-1", ownerId: "user-1" },
          { id: "ws-b", organizationId: "org-1", ownerId: "user-2" },
          { id: "ws-c", organizationId: "org-2", ownerId: "user-1" },
        ],
      });

    const listIds = async () => {
      const res = await app.request("/organizations/org-1/workspaces");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: { id: string }[] };
      return body.results.map((w) => w.id);
    };

    it("should return all of the org's workspaces for org admin", async () => {
      mockSession({ id: "user-1", role: "user" });
      seedWorkspaces("admin");

      expect(await listIds()).toEqual(["ws-a", "ws-b"]);
    });

    it("should return only owned workspaces for regular member", async () => {
      mockSession({ id: "user-1", role: "user" });
      seedWorkspaces("member");

      expect(await listIds()).toEqual(["ws-a"]);
    });
  });

  describe("GET /organizations/:orgId/workspaces/:workspaceId", () => {
    it("should return workspace", async () => {
      mockSession({ id: "user-1", role: "user" });
      const mockWorkspace = { id: "ws-1", name: "WS 1" };

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // Mock requireWorkspaceAccess: workspace owned by user
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      // Mock get workspace
      mockDb.limit.mockResolvedValueOnce([mockWorkspace]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockWorkspace);
    });

    it("returns 404 for a workspace of another organization", async () => {
      mockSession({ id: "user-1", role: "user" });
      seedDb({
        organization_member: [
          {
            id: "m1",
            userId: "user-1",
            organizationId: "org-1",
            role: "admin",
          },
        ],
        workspace: [{ id: "ws-c", organizationId: "org-2", ownerId: "user-1" }],
      });

      const res = await app.request("/organizations/org-1/workspaces/ws-c");
      expect(res.status).toBe(404);
    });

    it("should return 404 if workspace not found", async () => {
      mockSession({ id: "user-1", role: "user" });

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // Mock requireWorkspaceAccess: workspace not found
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /organizations/:orgId/workspaces/:workspaceId", () => {
    it("should update workspace if owner", async () => {
      mockSession({ id: "user-1", role: "user" });
      const mockWorkspace = { id: "ws-1", name: "Updated WS" };

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // Mock requireWorkspaceAccess: workspace owned by user
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);

      // Mock update
      mockDb.returning.mockResolvedValueOnce([mockWorkspace]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1", {
        method: "PUT",
        body: JSON.stringify({ name: "Updated WS" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockWorkspace);
    });

    // ADR-0006: delegation flags are admin-only; a non-admin owner's attempt
    // to set them is silently stripped before the update.
    it("strips delegation flags from a non-admin owner's update", async () => {
      mockSession({ id: "user-1", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.returning.mockResolvedValueOnce([
        { id: "ws-1", name: "My Workspace" },
      ]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1", {
        method: "PUT",
        body: JSON.stringify({
          name: "My Workspace",
          providerSelfManagement: true,
          mcpSelfManagement: true,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      const setArg = mockDb.set.mock.calls.at(-1)?.[0];
      expect(setArg).not.toHaveProperty("providerSelfManagement");
      expect(setArg).not.toHaveProperty("mcpSelfManagement");
    });

    // Security (GHSA-qg7h-g2rm-37qh): a memory Provider pointer must resolve
    // through the Scoped resource authority, scoped to this Workspace, so a
    // Provider not visible here — e.g. one owned by another Organization —
    // resolves to null and is rejected, never stamped. Asserting the delegation
    // (not just the 404) is what pins the fix: the vulnerable code did a bare id
    // lookup and never called resolveScoped.
    it("rejects a memory provider not visible in the workspace", async () => {
      mockSession({ id: "user-1", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      resolveScopedMock.mockResolvedValueOnce(null); // not visible in (org-1, ws-1)

      const res = await app.request("/organizations/org-1/workspaces/ws-1", {
        method: "PUT",
        body: JSON.stringify({
          name: "My Workspace",
          memoryExtractionProviderId: "provider-other-org",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: "Memory extraction provider not found",
      });
      expect(resolveScopedMock).toHaveBeenCalledWith(
        expect.anything(),
        "provider",
        "provider-other-org",
        // The middleware's WorkspaceScope, passed through: what pins the fix is
        // that the org/workspace pair reaches resolveScoped at all.
        expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1" }),
      );
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("accepts a workspace-visible memory provider that has the model", async () => {
      mockSession({ id: "user-1", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      resolveScopedMock.mockResolvedValueOnce({
        row: {
          id: "provider-1",
          memoryExtractionModelId: "model-x",
        } as never,
        scope: "workspace",
      });
      mockDb.returning.mockResolvedValueOnce([
        { id: "ws-1", name: "My Workspace" },
      ]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1", {
        method: "PUT",
        body: JSON.stringify({
          name: "My Workspace",
          memoryExtractionProviderId: "provider-1",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ memoryExtractionProviderId: "provider-1" }),
      );
    });

    const putAsOwner = (body: Record<string, unknown>) => {
      mockSession({ id: "user-1", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      return app.request("/organizations/org-1/workspaces/ws-1", {
        method: "PUT",
        body: JSON.stringify({ name: "My Workspace", ...body }),
        headers: { "Content-Type": "application/json" },
      });
    };

    const visibleProvider = (row: Record<string, unknown>) =>
      resolveScopedMock.mockResolvedValueOnce({
        row: { id: "provider-1", ...row } as never,
        scope: "workspace",
      });

    it.each([
      [
        "extraction",
        "memoryExtractionProviderId",
        "Selected provider does not have a memory extraction model configured",
      ],
      [
        "embedding",
        "memoryEmbeddingProviderId",
        "Selected provider does not have an embedding model configured",
      ],
    ])(
      "rejects a memory %s provider without the needed model",
      async (_kind, field, error) => {
        visibleProvider({});

        const res = await putAsOwner({ [field]: "provider-1" });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error });
        expect(mockDb.update).not.toHaveBeenCalled();
      },
    );

    it("rejects a memory embedding provider not visible in the workspace", async () => {
      resolveScopedMock.mockResolvedValueOnce(null);

      const res = await putAsOwner({
        memoryEmbeddingProviderId: "provider-other-org",
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: "Memory embedding provider not found",
      });
      expect(resolveScopedMock).toHaveBeenCalledWith(
        expect.anything(),
        "provider",
        "provider-other-org",
        expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1" }),
      );
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("accepts a workspace-visible memory embedding provider that has the model", async () => {
      visibleProvider({ embeddingModelId: "embed-x" });
      mockDb.returning.mockResolvedValueOnce([{ id: "ws-1" }]);

      const res = await putAsOwner({ memoryEmbeddingProviderId: "provider-1" });

      expect(res.status).toBe(200);
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ memoryEmbeddingProviderId: "provider-1" }),
      );
    });

    it("lets an org admin set delegation flags", async () => {
      mockSession({ id: "user-1", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-2", organizationId: "org-1" },
      ]); // requireWorkspaceAccess (admin, not owner)
      mockDb.returning.mockResolvedValueOnce([
        { id: "ws-1", name: "My Workspace" },
      ]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1", {
        method: "PUT",
        body: JSON.stringify({ name: "My Workspace", mcpSelfManagement: true }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      const setArg = mockDb.set.mock.calls.at(-1)?.[0];
      expect(setArg).toMatchObject({ mcpSelfManagement: true });
    });
  });

  describe("DELETE /organizations/:orgId/workspaces/:workspaceId", () => {
    it("should delete workspace if owner", async () => {
      mockSession({ id: "user-1", role: "user" });

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // Mock requireWorkspaceAccess: workspace owned by user
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);

      // Mock delete — order: orgAccess where (chained) → workspaceAccess where
      // (chained) → destroyWorkspaceSandboxes select-where (resolves []) →
      // Agent avatar select-where (resolves []) → workspace delete where
      // (resolves) → provider delete where (resolves).
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Workspace deleted" });
      // The route must delete Workspace-scoped Providers itself (issue #661):
      // `provider.workspaceId` carries no FK, so nothing cascades this away.
      expect(mockDb.delete).toHaveBeenCalledWith(providerTable);
      const deleteCalls = mockDb.delete.mock.calls.map((call) => call[0]);
      const workspaceDeleteIndex = deleteCalls.indexOf(workspaceTable);
      const providerDeleteIndex = deleteCalls.indexOf(providerTable);
      expect(workspaceDeleteIndex).toBeGreaterThanOrEqual(0);
      expect(providerDeleteIndex).toBeGreaterThan(workspaceDeleteIndex);
    });

    describe("stored files", () => {
      useTempDiskStorage();

      const inside = [
        "org-1/ws-1/chat-1/msg-1/0-aaaaaaaa.png",
        "org-1/ws-1/chat-2/msg-1/0-bbbbbbbb.png",
      ];
      const avatar = "agents/agent-1/avatar-a.webp";
      const outside = [
        "org-1/ws-10/chat-3/msg-1/0-cccccccc.png",
        "agents/agent-2/avatar-b.webp",
      ];

      const seed = () =>
        seedDb({
          organization_member: [
            {
              id: "m1",
              userId: "user-1",
              organizationId: "org-1",
              role: "member",
            },
          ],
          workspace: [
            { id: "ws-1", organizationId: "org-1", ownerId: "user-1" },
            { id: "ws-10", organizationId: "org-1", ownerId: "user-1" },
          ],
          agent: [
            { id: "agent-1", workspaceId: "ws-1", avatarKey: avatar },
            { id: "agent-2", workspaceId: "ws-10", avatarKey: outside[1] },
            { id: "agent-3", workspaceId: "ws-1", avatarKey: null },
          ],
        });

      it("removes the Workspace's files and its Agents' avatars, and nothing else", async () => {
        mockSession({ id: "user-1", role: "user" });
        seed();
        await putStoredFiles([...inside, avatar, ...outside]);

        const res = await app.request("/organizations/org-1/workspaces/ws-1", {
          method: "DELETE",
        });

        expect(res.status).toBe(200);
        for (const key of [...inside, avatar]) {
          expect(await isStored(key)).toBe(false);
        }
        for (const key of outside) {
          expect(await isStored(key)).toBe(true);
        }
      });

      it("leaves storage untouched when the DB delete fails", async () => {
        mockSession({ id: "user-1", role: "user" });
        const fake = seed();
        await putStoredFiles([...inside, avatar]);
        vi.spyOn(
          fake.handle as { transaction: () => Promise<never> },
          "transaction",
        ).mockRejectedValue(new Error("db down"));

        const res = await app.request("/organizations/org-1/workspaces/ws-1", {
          method: "DELETE",
        });

        expect(res.status).toBe(500);
        for (const key of [...inside, avatar]) {
          expect(await isStored(key)).toBe(true);
        }
      });

      it("still succeeds, and logs, when storage fails after the DB delete", async () => {
        mockSession({ id: "user-1", role: "user" });
        const fake = seed();
        vi.spyOn(getStorage(), "deletePrefix").mockRejectedValue(
          new Error("storage down"),
        );

        const res = await app.request("/organizations/org-1/workspaces/ws-1", {
          method: "DELETE",
        });

        expect(res.status).toBe(200);
        expect(fake.tables.workspace.map((row) => row.id)).toEqual(["ws-10"]);
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({ prefix: "org-1/ws-1/" }),
          "Failed to delete files from storage",
        );
      });
    });
  });
});
