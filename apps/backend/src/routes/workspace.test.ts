import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  dbError,
  mockSession,
  resetMockDb,
  seedDb,
  useTempDiskStorage,
  putStoredFiles,
  isStored,
  type Store,
} from "../test-utils.ts";
import type { FakeDbOptions } from "../fake-db.ts";
import { mockLogger } from "../test-setup.ts";
import { getStorage } from "../storage/index.ts";
import app from "../server.ts";
import { transferWorkspace } from "../services/workspace-transfer.ts";
import { ValidationError } from "../errors.ts";

// The transfer itself runs against a real Postgres in its own tests
// (`workspace-transfer.test.ts`); here only who may call it, and what it answers.
vi.mock("../services/workspace-transfer.ts", () => ({
  transferWorkspace: vi.fn(),
}));
const transferWorkspaceMock = vi.mocked(transferWorkspace);

/**
 * These tests state fixture rows rather than stubbing queries in call order:
 * `seedDb()` installs the in-memory fake from `fake-db.ts`, which evaluates the
 * `WHERE` each query builds. Every world holds a same-named Workspace, member
 * and Provider in `org-2`, so a lookup that dropped its Organization or
 * Workspace column reads a row it should not and the test fails.
 */
describe("Workspace Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    transferWorkspaceMock.mockReset();
  });

  const json = (method: string, body: unknown): RequestInit => ({
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

  /** `ws-1` as seeded: in `org-1`, owned by `user-1`, no delegation. */
  const ws1 = (over: Store[string][number] = {}) => ({
    id: "ws-1",
    name: "WS 1",
    organizationId: "org-1",
    ownerId: "user-1",
    providerSelfManagement: false,
    mcpSelfManagement: false,
    inboundTriggersAllowed: false,
    ...over,
  });

  /**
   * The baseline world: the caller (`user-1`) is a member of `org-1` at the
   * given role beside `member-2`; `outsider` is a member of `org-2` only, which
   * holds a Workspace of its own under the same name.
   */
  const world = (
    options: {
      role?: "admin" | "member";
      workspace?: Store[string][number];
      rows?: Store;
      db?: FakeDbOptions;
    } = {},
  ) => {
    const { role = "member", rows = {} } = options;
    return seedDb(
      {
        organization_member: [
          { id: "m1", userId: "user-1", organizationId: "org-1", role },
          {
            id: "m2",
            userId: "member-2",
            organizationId: "org-1",
            role: "member",
          },
          {
            id: "m3",
            userId: "outsider",
            organizationId: "org-2",
            role: "member",
          },
        ],
        workspace: [
          ws1(options.workspace),
          { id: "ws-x", name: "WS 1", organizationId: "org-2", ownerId: "u-x" },
        ],
        ...rows,
      },
      options.db,
    );
  };

  describe("POST /organizations/:orgId/workspaces", () => {
    const post = (body: unknown) =>
      app.request("/organizations/org-1/workspaces", json("POST", body));

    // ADR-0008: Workspace creation is org-admin-only.
    it("should create workspace for an org admin", async () => {
      mockSession({ id: "user-1", role: "user" });
      const fake = world({ role: "admin" });

      const res = await post({ name: "New Workspace" });

      expect(res.status).toBe(201);
      const created = fake.tables.workspace.at(-1);
      expect(await res.json()).toEqual(created);
      // Owner defaults to the calling admin when no ownerId is supplied.
      expect(created).toMatchObject({
        name: "New Workspace",
        ownerId: "user-1",
        organizationId: "org-1",
      });
    });

    // ADR-0008: a regular member can no longer self-create Workspaces.
    it("should return 403 for a regular member", async () => {
      mockSession({ id: "user-1", role: "user" });
      const fake = world({ role: "member" });

      const res = await post({ name: "New Workspace" });

      expect(res.status).toBe(403);
      expect(fake.tables.workspace).toHaveLength(2);
    });

    // ADR-0008: ownerId is admin-assignable to another org member.
    it("should let an admin assign a different owner who is a member", async () => {
      mockSession({ id: "user-1", role: "user" });
      const fake = world({ role: "admin" });

      const res = await post({ name: "Member Workspace", ownerId: "member-2" });

      expect(res.status).toBe(201);
      expect(fake.tables.workspace.at(-1)).toMatchObject({
        ownerId: "member-2",
        organizationId: "org-1",
      });
    });

    // Governance: an admin cannot hand a workspace to a non-member. `outsider`
    // is a member of org-2, so this guards the owner lookup's
    // `organizationMember.organizationId` filter.
    it("should return 400 when the assigned owner is a member of another org only", async () => {
      mockSession({ id: "user-1", role: "user" });
      const fake = world({ role: "admin" });

      const res = await post({ name: "Member Workspace", ownerId: "outsider" });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Owner must be a member of the organization",
      });
      expect(fake.tables.workspace).toHaveLength(2);
    });

    // Removing the owner meanwhile waits on this lock, then must decide the
    // new Workspace too (ADR-0035).
    it("locks the owner's membership until the Workspace is created", async () => {
      mockSession({ id: "user-1", role: "user" });
      const fake = world({ role: "admin" });

      const res = await post({ name: "Member Workspace", ownerId: "member-2" });

      expect(res.status).toBe(201);
      const lock = fake.queries.findIndex((q) => q.lock === "share");
      expect(fake.queries[lock]).toEqual({
        kind: "select",
        table: "organization_member",
        lock: "share",
      });
      expect(lock).toBeLessThan(
        fake.queries.findIndex(
          (q) => q.kind === "insert" && q.table === "workspace",
        ),
      );
    });

    it("lets a super admin with no membership create their own Workspace", async () => {
      mockSession({ id: "super-1", role: "admin" });
      const fake = world();

      const res = await post({ name: "Mine" });

      expect(res.status).toBe(201);
      expect(fake.tables.workspace.at(-1)).toMatchObject({
        ownerId: "super-1",
        organizationId: "org-1",
      });
    });

    // The organization id is a tenancy boundary. It is derived from the path
    // after requireOrgAccess, rather than accepted from the request body.
    it("binds a workspace to the authorized organization", async () => {
      mockSession({ id: "user-1", role: "user" });
      const fake = world({ role: "admin" });

      const res = await post({
        name: "Bound Workspace",
        // A stale or malicious client cannot redirect creation into org-2.
        organizationId: "org-2",
      });

      expect(res.status).toBe(201);
      expect(fake.tables.workspace.at(-1)).toMatchObject({
        organizationId: "org-1",
        ownerId: "user-1",
      });
    });
  });

  describe("POST /organizations/:orgId/workspaces with provisioned resources", () => {
    const post = (body: unknown) =>
      app.request("/organizations/org-1/workspaces", json("POST", body));

    const provider = {
      name: "OpenAI",
      providerType: "OpenAI",
      apiKey: "sk-test",
      modelIds: [{ id: "gpt-5" }],
      taskModelId: "gpt-5",
      memoryExtractionModelId: "gpt-5",
    };

    // `shared-1` is a Shared Provider of org-1; `elsewhere` one of org-2.
    const sharedProviders = {
      provider: [
        { id: "shared-1", organizationId: "org-1", workspaceId: null },
        { id: "elsewhere", organizationId: "org-2", workspaceId: null },
      ],
    };

    const provisioned = {
      name: "Ready",
      provider,
      sharedProviderIds: ["shared-1"],
      sandbox: { name: "Local", backend: "docker" },
    };

    it("creates the Workspace, its Provider, Attachments and Sandbox", async () => {
      mockSession({ id: "user-1", role: "user" });
      const fake = world({ role: "admin", rows: sharedProviders });

      const res = await post(provisioned);

      expect(res.status).toBe(201);
      const created = fake.tables.workspace.at(-1)!;
      expect(created).toMatchObject({ name: "Ready", organizationId: "org-1" });
      // The nested resources are not columns of the Workspace row.
      expect(created).not.toHaveProperty("provider");
      expect(created).not.toHaveProperty("sandbox");
      // The new Provider is scoped to the new Workspace, never the body.
      expect(fake.tables.provider.at(-1)).toMatchObject({
        name: "OpenAI",
        workspaceId: created.id,
        organizationId: null,
      });
      expect(fake.tables.attachment).toEqual([
        expect.objectContaining({
          workspaceId: created.id,
          resourceType: "provider",
          resourceId: "shared-1",
        }),
      ]);
      expect(fake.tables.sandbox).toEqual([
        expect.objectContaining({ name: "Local", workspaceId: created.id }),
      ]);
    });

    it("writes nothing when a later step of the transaction fails", async () => {
      mockSession({ id: "user-1", role: "user" });
      const fake = world({
        role: "admin",
        rows: sharedProviders,
        db: {
          onInsert: (table) => {
            if (table === "sandbox") throw dbError();
          },
        },
      });

      const res = await post(provisioned);

      expect(res.status).toBe(500);
      expect(fake.tables.workspace).toHaveLength(2);
      expect(fake.tables.provider).toHaveLength(2);
      expect(fake.tables.attachment ?? []).toEqual([]);
    });

    it("returns 404 and writes nothing when a Shared Provider is not in this org", async () => {
      mockSession({ id: "user-1", role: "user" });
      const fake = world({ role: "admin", rows: sharedProviders });

      const res = await post({
        name: "Ready",
        sharedProviderIds: ["elsewhere"],
      });

      expect(res.status).toBe(404);
      expect(fake.queries.some((q) => q.kind === "insert")).toBe(false);
    });

    it("returns 400 and writes nothing when the Sandbox is invalid", async () => {
      mockSession({ id: "user-1", role: "user" });
      const fake = world({ role: "admin" });

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
      expect(fake.queries.some((q) => q.kind === "insert")).toBe(false);
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

    // Guards the admin branch's `workspace.organizationId` filter.
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
      world();

      const res = await app.request("/organizations/org-1/workspaces/ws-1");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(ws1());
    });

    it("returns 404 for a workspace of another organization", async () => {
      mockSession({ id: "user-1", role: "user" });
      world({ role: "admin" });

      const res = await app.request("/organizations/org-1/workspaces/ws-x");
      expect(res.status).toBe(404);
    });

    it("should return 404 if workspace not found", async () => {
      mockSession({ id: "user-1", role: "user" });
      world();

      const res = await app.request("/organizations/org-1/workspaces/ws-9");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /organizations/:orgId/workspaces/:workspaceId", () => {
    const put = (body: Record<string, unknown>) =>
      app.request(
        "/organizations/org-1/workspaces/ws-1",
        json("PUT", { name: "My Workspace", ...body }),
      );

    /** A Provider of `ws-1`, with whichever memory models the test gives it. */
    const ownProvider = (over: Store[string][number] = {}) => ({
      id: "provider-1",
      organizationId: null,
      workspaceId: "ws-1",
      ...over,
    });

    /**
     * A Shared Provider of org-2 carrying both memory models: a bare id lookup
     * would accept it, so only the Scoped resource authority's Workspace/
     * Organization filter rejects it (GHSA-qg7h-g2rm-37qh).
     */
    const otherOrgProvider = {
      id: "provider-other-org",
      organizationId: "org-2",
      workspaceId: null,
      memoryExtractionModelId: "model-x",
      embeddingModelId: "embed-x",
    };

    it("should update workspace if owner", async () => {
      mockSession({ id: "user-1", role: "user" });
      const fake = world();

      const res = await put({ name: "Updated WS" });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: "ws-1",
        name: "Updated WS",
      });
      expect(fake.tables.workspace.map((w) => w.name)).toEqual([
        "Updated WS",
        "WS 1",
      ]);
    });

    // ADR-0006: delegation flags are admin-only; a non-admin owner's attempt
    // to set them is silently stripped before the update.
    it("strips delegation flags from a non-admin owner's update", async () => {
      mockSession({ id: "user-1", role: "user" });
      const fake = world();

      const res = await put({
        providerSelfManagement: true,
        mcpSelfManagement: true,
        inboundTriggersAllowed: true,
      });

      expect(res.status).toBe(200);
      expect(fake.tables.workspace[0]).toMatchObject({
        name: "My Workspace",
        providerSelfManagement: false,
        mcpSelfManagement: false,
        inboundTriggersAllowed: false,
      });
    });

    it("lets an org admin set delegation flags", async () => {
      mockSession({ id: "user-1", role: "user" });
      // An admin, not the owner.
      const fake = world({ role: "admin", workspace: { ownerId: "member-2" } });

      const res = await put({
        mcpSelfManagement: true,
        inboundTriggersAllowed: true,
      });

      expect(res.status).toBe(200);
      expect(fake.tables.workspace[0]).toMatchObject({
        mcpSelfManagement: true,
        inboundTriggersAllowed: true,
      });
    });

    it.each([
      [
        "extraction",
        "memoryExtractionProviderId",
        "Memory extraction provider not found",
      ],
      [
        "embedding",
        "memoryEmbeddingProviderId",
        "Memory embedding provider not found",
      ],
    ])(
      "rejects a memory %s provider of another organization",
      async (_kind, field, error) => {
        mockSession({ id: "user-1", role: "user" });
        const fake = world({ rows: { provider: [otherOrgProvider] } });

        const res = await put({ [field]: "provider-other-org" });

        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error });
        expect(fake.tables.workspace[0]).toEqual(ws1());
      },
    );

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
        mockSession({ id: "user-1", role: "user" });
        const fake = world({ rows: { provider: [ownProvider()] } });

        const res = await put({ [field]: "provider-1" });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error });
        expect(fake.tables.workspace[0]).toEqual(ws1());
      },
    );

    it.each([
      [
        "extraction",
        "memoryExtractionProviderId",
        { memoryExtractionModelId: "model-x" },
      ],
      [
        "embedding",
        "memoryEmbeddingProviderId",
        { embeddingModelId: "embed-x" },
      ],
    ])(
      "accepts a workspace-visible memory %s provider that has the model",
      async (_kind, field, models) => {
        mockSession({ id: "user-1", role: "user" });
        const fake = world({ rows: { provider: [ownProvider(models)] } });

        const res = await put({ [field]: "provider-1" });

        expect(res.status).toBe(200);
        expect(fake.tables.workspace[0]).toMatchObject({
          [field]: "provider-1",
        });
      },
    );
  });

  describe("DELETE /organizations/:orgId/workspaces/:workspaceId", () => {
    it("should delete workspace if owner", async () => {
      mockSession({ id: "user-1", role: "user" });
      const fake = world({
        rows: {
          provider: [
            { id: "p-own", organizationId: null, workspaceId: "ws-1" },
            { id: "p-other", organizationId: null, workspaceId: "ws-x" },
            { id: "p-shared", organizationId: "org-1", workspaceId: null },
          ],
        },
      });

      const res = await app.request("/organizations/org-1/workspaces/ws-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Workspace deleted" });
      expect(fake.tables.workspace.map((w) => w.id)).toEqual(["ws-x"]);
      // The route must delete Workspace-scoped Providers itself (issue #661):
      // `provider.workspaceId` carries no FK, so nothing cascades this away —
      // and only after the Workspace, which cascades its Agents first.
      expect(fake.tables.provider.map((p) => p.id)).toEqual([
        "p-other",
        "p-shared",
      ]);
      expect(
        fake.queries.filter((q) => q.kind === "delete").map((q) => q.table),
      ).toEqual(["workspace", "provider"]);
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

      const seed = (options?: FakeDbOptions) =>
        seedDb(
          {
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
          },
          options,
        );

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
        const fake = seed({
          onQuery: (query) => {
            if (query.kind === "delete") throw dbError();
          },
        });
        await putStoredFiles([...inside, avatar]);

        const res = await app.request("/organizations/org-1/workspaces/ws-1", {
          method: "DELETE",
        });

        expect(res.status).toBe(500);
        expect(fake.tables.workspace.map((row) => row.id)).toEqual([
          "ws-1",
          "ws-10",
        ]);
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

  describe("POST /organizations/:orgId/workspaces/:workspaceId/transfer", () => {
    const transferWorld = () =>
      seedDb({
        organization_member: [
          {
            id: "m-admin",
            userId: "admin-1",
            organizationId: "org-1",
            role: "admin",
          },
          {
            id: "m-old",
            userId: "u-old",
            organizationId: "org-1",
            role: "member",
          },
          {
            id: "m-new",
            userId: "u-new",
            organizationId: "org-1",
            role: "member",
          },
        ],
        workspace: [{ id: "ws-1", organizationId: "org-1", ownerId: "u-old" }],
      });
    const transfer = (body: unknown) =>
      app.request(
        "/organizations/org-1/workspaces/ws-1/transfer",
        json("POST", body),
      );

    it("transfers the Workspace for an Org Admin, naming them to the new Owner", async () => {
      mockSession({ id: "admin-1", name: "Ada", role: "user" });
      transferWorld();

      const res = await transfer({ newOwnerId: "u-new", keepHistory: false });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: "ws-1" });
      expect(transferWorkspaceMock).toHaveBeenCalledWith({
        orgId: "org-1",
        workspaceId: "ws-1",
        newOwnerId: "u-new",
        keepHistory: false,
        transferredBy: "Ada",
      });
    });

    it.each([
      ["the current Owner", "u-old"],
      ["another member", "u-new"],
    ])("refuses %s with 403", async (_, id) => {
      mockSession({ id, role: "user" });
      transferWorld();

      const res = await transfer({ newOwnerId: "u-new", keepHistory: true });

      expect(res.status).toBe(403);
      expect(transferWorkspaceMock).not.toHaveBeenCalled();
    });

    it("answers 400 when the recipient is refused", async () => {
      mockSession({ id: "admin-1", role: "user" });
      transferWorld();
      transferWorkspaceMock.mockRejectedValue(
        new ValidationError("New Owner must be a member of the organization"),
      );

      const res = await transfer({ newOwnerId: "u-out", keepHistory: true });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "New Owner must be a member of the organization",
      });
    });

    it("answers 400 without a history choice", async () => {
      mockSession({ id: "admin-1", role: "user" });
      transferWorld();

      const res = await transfer({ newOwnerId: "u-new" });

      expect(res.status).toBe(400);
      expect(transferWorkspaceMock).not.toHaveBeenCalled();
    });

    it("refuses the old Owner once the Workspace is someone else's", async () => {
      mockSession({ id: "u-old", role: "user" });
      const fake = transferWorld();
      fake.tables.workspace[0].ownerId = "u-new";

      const res = await app.request("/organizations/org-1/workspaces/ws-1");

      expect(res.status).toBe(403);
    });
  });
});
