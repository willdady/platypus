import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockSession,
  mockNoSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Store,
} from "../test-utils.ts";
import app from "../server.ts";
import { deleteAvatar, storeAvatar } from "../services/avatar.ts";

vi.mock("../services/avatar.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/avatar.ts")>()),
  storeAvatar: vi.fn(),
  deleteAvatar: vi.fn(),
}));

/**
 * These tests state fixture rows rather than stubbing queries in call order:
 * `seedDb()` installs the in-memory fake from `fake-db.ts`, which evaluates
 * the `WHERE` each query builds, so a lookup that dropped its Workspace scope
 * reads `ws-2`'s Agent and the test fails.
 */
describe("Agent Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/agents`;

  /** This Workspace's own Agent. */
  const workspaceAgent = (over: Store[string][number] = {}) => ({
    id: "agent-1",
    name: "Agent 1",
    workspaceId,
    organizationId: null,
    providerId: "p1",
    modelId: "m1",
    skillIds: [],
    subAgentIds: [],
    toolSetIds: [],
    ...over,
  });

  /** A Shared Agent of this Organization — org-scoped, at no Workspace. */
  const sharedAgent = (over: Store[string][number] = {}) =>
    workspaceAgent({
      id: "shared-1",
      name: "Shared",
      workspaceId: null,
      organizationId: orgId,
      ...over,
    });

  /** An Agent private to `ws-2`, another Workspace of the same Organization. */
  const otherWorkspaceAgent = () =>
    workspaceAgent({ id: "agent-2", name: "Elsewhere", workspaceId: "ws-2" });

  const attachedHere = (resourceId: string) => ({
    id: `att-${resourceId}`,
    workspaceId,
    resourceType: "agent",
    resourceId,
  });

  /**
   * The caller (`user-1`) is a member of `org-1` at `role`; `owner` owns
   * `ws-1` and `ws-2`.
   */
  const world = ({
    role = "member",
    owner = "user-1",
    rows = {},
  }: {
    role?: "admin" | "member";
    owner?: string;
    rows?: Store;
  } = {}): FakeDb =>
    seedDb({
      organization_member: [
        { id: "m1", userId: "user-1", organizationId: orgId, role },
      ],
      workspace: [
        { id: workspaceId, organizationId: orgId, ownerId: owner },
        { id: "ws-2", organizationId: orgId, ownerId: owner },
      ],
      ...rows,
    });

  const agentOf = (fake: FakeDb, id: string) =>
    fake.tables.agent.find((a) => a.id === id);

  const send = (method: "POST" | "PUT", url: string, payload: unknown) =>
    app.request(url, {
      method,
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    });

  describe("POST /", () => {
    const createBody = {
      name: "New Agent",
      description: "A test agent",
      providerId: "p1",
      modelId: "m1",
    };

    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await send("POST", baseUrl, createBody);
      expect(res.status).toBe(401);
    });

    it("should return 403 if user has no workspace access", async () => {
      mockSession();
      const fake = world({ owner: "other-user" });

      const res = await send("POST", baseUrl, createBody);
      expect(res.status).toBe(403);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a table no test seeded or wrote is absent
      expect(fake.tables.agent ?? []).toEqual([]);
    });

    it("should create a workspace-scoped agent, ignoring any scope in the body", async () => {
      mockSession();
      const fake = world();

      const res = await send("POST", baseUrl, {
        ...createBody,
        workspaceId: "ws-2",
        organizationId: orgId,
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      expect(body).toEqual(
        expect.objectContaining({ name: "New Agent", workspaceId }),
      );
      expect(fake.tables.agent).toEqual([
        expect.objectContaining({
          id: body.id,
          workspaceId,
          organizationId: null,
        }),
      ]);
    });

    it("creates an agent that references an attached Shared agent as a sub-agent", async () => {
      mockSession();
      const fake = world({
        rows: {
          agent: [sharedAgent()],
          attachment: [attachedHere("shared-1")],
        },
      });

      const res = await send("POST", baseUrl, {
        ...createBody,
        subAgentIds: ["shared-1"],
      });

      expect(res.status).toBe(201);
      expect(fake.tables.agent).toContainEqual(
        expect.objectContaining({
          name: "New Agent",
          subAgentIds: ["shared-1"],
        }),
      );
    });

    it("should return 400 if description is too long", async () => {
      mockSession();
      world();

      const res = await send("POST", baseUrl, {
        ...createBody,
        description: "a".repeat(129),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; path: string[] }[];
      };
      expect(Object.keys(body)).toEqual(["error"]);
      expect(Array.isArray(body.error)).toBe(true);
      expect(body.error[0].code).toBe("too_big");
      expect(body.error[0].path).toContain("description");
    });

    it.each([
      [1, 201],
      [1.5, 400],
    ])("creating with topP %s returns %s", async (topP, status) => {
      mockSession();
      world();

      const res = await send("POST", baseUrl, { ...createBody, topP });

      expect(res.status).toBe(status);
    });
  });

  describe("GET /", () => {
    it("should list workspace and attached org agents tagged with scope", async () => {
      // Drop the Workspace filter from `listScoped` and `ws-2`'s Agent is
      // listed; drop the Attachment join and the unattached Shared one is.
      mockSession();
      world({
        rows: {
          agent: [
            workspaceAgent(),
            sharedAgent(),
            sharedAgent({ id: "shared-2", name: "Unattached" }),
            otherWorkspaceAgent(),
          ],
          attachment: [attachedHere("shared-1")],
          workspace_agent_pin: [{ workspaceId, agentId: "shared-1" }],
        },
      });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      // listScoped returns Workspace rows first, then attached org rows; the
      // frontend regroups by scope, so order is not observable behaviour.
      expect(await res.json()).toEqual({
        results: [
          expect.objectContaining({
            id: "agent-1",
            scope: "workspace",
            isPinned: false,
          }),
          expect.objectContaining({
            id: "shared-1",
            scope: "organization",
            isPinned: true,
          }),
        ],
      });
    });
  });

  describe("GET /:agentId", () => {
    const rows = {
      agent: [
        workspaceAgent(),
        sharedAgent(),
        sharedAgent({ id: "shared-2", name: "Unattached" }),
        otherWorkspaceAgent(),
      ],
      attachment: [attachedHere("shared-1")],
    };

    it("should return a workspace agent tagged scope workspace", async () => {
      mockSession();
      world({ rows });

      const res = await app.request(`${baseUrl}/agent-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({
          id: "agent-1",
          name: "Agent 1",
          workspaceId,
          scope: "workspace",
        }),
      );
    });

    it("should return an attached org agent tagged scope organization", async () => {
      mockSession();
      world({ rows });

      const res = await app.request(`${baseUrl}/shared-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({
          id: "shared-1",
          name: "Shared",
          organizationId: orgId,
          scope: "organization",
        }),
      );
    });

    // `agent-2` exists, but in `ws-2`: only the lookup's Workspace filter
    // keeps it out, and only the Attachment check keeps `shared-2` out.
    it.each([
      ["a missing agent", "nope"],
      ["an org agent that is not attached here", "shared-2"],
      ["another workspace's agent", "agent-2"],
    ])("should 404 %s", async (_label, id) => {
      mockSession();
      world({ rows });

      const res = await app.request(`${baseUrl}/${id}`);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:agentId", () => {
    const updateBody = {
      name: "Updated Agent",
      description: "An updated agent",
      providerId: "p1",
      modelId: "m1",
    };

    const put = (id: string, payload: unknown = updateBody) =>
      send("PUT", `${baseUrl}/${id}`, payload);

    const rows = (agents: Store[string] = []) => ({
      agent: [
        workspaceAgent(),
        sharedAgent(),
        otherWorkspaceAgent(),
        ...agents,
      ],
      attachment: [attachedHere("shared-1")],
    });

    it("should update a workspace agent if user is editor", async () => {
      mockSession();
      const fake = world({ rows: rows() });

      const res = await put("agent-1");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({ id: "agent-1", name: "Updated Agent" }),
      );
      expect(agentOf(fake, "agent-1")).toMatchObject({ name: "Updated Agent" });
      expect(agentOf(fake, "agent-2")).toMatchObject({ name: "Elsewhere" });
    });

    it.each([
      [1, 200],
      [1.5, 400],
    ])("updating with topP %s returns %s", async (topP, status) => {
      mockSession();
      world({ rows: rows() });

      const res = await put("agent-1", { ...updateBody, topP });

      expect(res.status).toBe(status);
    });

    it("persists a cleared temperature as null instead of keeping the old value (#263)", async () => {
      mockSession();
      const fake = world({
        rows: { agent: [workspaceAgent({ temperature: 0.7 })] },
      });

      const res = await put("agent-1", { ...updateBody, temperature: null });

      expect(res.status).toBe(200);
      expect(agentOf(fake, "agent-1")?.temperature).toBeNull();
    });

    it("accepts an attached Shared agent as a sub-agent, so a Promoted sub-Agent keeps its parent savable", async () => {
      mockSession();
      const fake = world({ rows: rows() });

      const res = await put("agent-1", {
        ...updateBody,
        subAgentIds: ["shared-1"],
      });

      expect(res.status).toBe(200);
      expect(agentOf(fake, "agent-1")?.subAgentIds).toEqual(["shared-1"]);
    });

    // `agent-2` exists in `ws-2`, and `shared-2` is Shared but unattached:
    // the sub-agent lookup's Workspace filter and Attachment join reject them.
    it.each([
      ["another workspace's agent", "agent-2"],
      ["an unattached Shared agent", "shared-2"],
    ])(
      "rejects a sub-agent that is not visible in this workspace: %s",
      async (_label, subId) => {
        mockSession();
        const fake = world({
          rows: rows([sharedAgent({ id: "shared-2", name: "Unattached" })]),
        });

        const res = await put("agent-1", {
          ...updateBody,
          subAgentIds: [subId],
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: "One or more sub-agents are not available in this workspace",
        });
        expect(agentOf(fake, "agent-1")).toMatchObject({
          name: "Agent 1",
          subAgentIds: [],
        });
      },
    );

    // Shared agents are edited only on the Organization surface (ADR-0007),
    // even by an Org Admin.
    it.each(["member", "admin"] as const)(
      "should lock an attached shared agent for a %s",
      async (role) => {
        mockSession();
        const fake = world({ role, rows: rows() });

        const res = await put("shared-1");

        expect(res.status).toBe(403);
        expect(agentOf(fake, "shared-1")).toMatchObject({ name: "Shared" });
      },
    );

    it("should 404 another workspace's agent and leave it unchanged", async () => {
      mockSession();
      const fake = world({ rows: rows() });

      const res = await put("agent-2");

      expect(res.status).toBe(404);
      expect(agentOf(fake, "agent-2")).toMatchObject({ name: "Elsewhere" });
    });
  });

  describe("DELETE /:agentId", () => {
    const rows = {
      agent: [
        workspaceAgent({ avatarKey: "avatar-1" }),
        sharedAgent(),
        sharedAgent({ id: "shared-2", name: "Unattached" }),
        // Another Workspace's Agent, holding `agent-1` as a sub-agent.
        workspaceAgent({
          id: "agent-2",
          name: "Elsewhere",
          workspaceId: "ws-2",
          subAgentIds: ["agent-1", "shared-1"],
        }),
      ],
      attachment: [attachedHere("shared-1")],
    };

    const remove = (id: string) =>
      app.request(`${baseUrl}/${id}`, { method: "DELETE" });

    it("should delete a workspace agent, its avatar, and references to it", async () => {
      mockSession();
      const fake = world({ rows });

      const res = await remove("agent-1");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Agent deleted" });
      expect(agentOf(fake, "agent-1")).toBeUndefined();
      expect(agentOf(fake, "agent-2")?.subAgentIds).toEqual(["shared-1"]);
      expect(deleteAvatar).toHaveBeenCalledWith("avatar-1");
    });

    it.each([
      ["a shared agent not attached here", "shared-2", 404],
      // Shared agents are deleted only on the Organization surface (ADR-0007).
      ["an attached shared agent (locked)", "shared-1", 403],
      ["another workspace's agent", "agent-2", 404],
    ])("refuses %s", async (_label, id, status) => {
      mockSession();
      const fake = world({ role: "admin", rows });

      const res = await remove(id);

      expect(res.status).toBe(status);
      expect(fake.tables.agent).toHaveLength(4);
      expect(deleteAvatar).not.toHaveBeenCalled();
    });
  });

  describe("avatar routes", () => {
    /**
     * `agent-1` is this Workspace's own Agent; `shared-1` is a Shared Agent
     * attached here (visible, but locked on this surface); `agent-2` belongs to
     * another Workspace of the same org.
     */
    const avatarWorld = (): FakeDb =>
      world({
        rows: {
          agent: [
            workspaceAgent({ avatarKey: "old" }),
            workspaceAgent({
              id: "agent-2",
              workspaceId: "ws-2",
              avatarKey: "theirs",
            }),
            sharedAgent(),
          ],
          attachment: [attachedHere("shared-1")],
        },
      });

    const upload = (agentId: string) => {
      const form = new FormData();
      form.append("file", new File(["x"], "a.png", { type: "image/png" }));
      return app.request(`${baseUrl}/${agentId}/avatar`, {
        method: "POST",
        body: form,
      });
    };

    const keyOf = (fake: FakeDb, id: string) => agentOf(fake, id)?.avatarKey;

    it("stores the upload and persists its key on the agent", async () => {
      mockSession();
      const fake = avatarWorld();
      vi.mocked(storeAvatar).mockResolvedValue({ ok: true, key: "new" });

      const res = await upload("agent-1");

      expect(res.status).toBe(200);
      expect(storeAvatar).toHaveBeenCalledWith(
        expect.any(File),
        "agent-1",
        "old",
      );
      expect(keyOf(fake, "agent-1")).toBe("new");
      // The avatar write's `workspaceScopedWhere` keeps every other row out.
      expect(keyOf(fake, "agent-2")).toBe("theirs");
      expect(keyOf(fake, "shared-1")).toBeUndefined();
    });

    it("returns 400 with the rejection when the upload is invalid", async () => {
      mockSession();
      const fake = avatarWorld();
      vi.mocked(storeAvatar).mockResolvedValue({
        ok: false,
        error: "Invalid file type",
      });

      const res = await upload("agent-1");

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid file type" });
      expect(keyOf(fake, "agent-1")).toBe("old");
    });

    it("404s when the agent is deleted mid-request", async () => {
      mockSession();
      const fake = world();
      vi.mocked(storeAvatar).mockImplementationOnce(() => {
        fake.tables.agent = fake.tables.agent.filter((a) => a.id !== "agent-1");
        return Promise.resolve({ ok: true, key: "new" });
      });

      const res = await upload("agent-1");

      expect(res.status).toBe(404);
    });

    it("rejects a body over the limit before reading it", async () => {
      mockSession();
      world();
      const form = new FormData();
      form.append(
        "file",
        new File([new Uint8Array(6 * 1024 * 1024)], "a.png", {
          type: "image/png",
        }),
      );

      const res = await app.request(`${baseUrl}/agent-1/avatar`, {
        method: "POST",
        body: form,
      });

      expect(res.status).toBe(400);
      expect(storeAvatar).not.toHaveBeenCalled();
    });

    it.each([
      ["locks an attached Shared agent", "shared-1", 403],
      ["404s another workspace's agent", "agent-2", 404],
    ])("POST %s", async (_label, id, status) => {
      mockSession();
      avatarWorld();

      const res = await upload(id);

      expect(res.status).toBe(status);
      expect(storeAvatar).not.toHaveBeenCalled();
    });

    it("DELETE removes the stored avatar and clears the key", async () => {
      mockSession();
      const fake = avatarWorld();

      const res = await app.request(`${baseUrl}/agent-1/avatar`, {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(deleteAvatar).toHaveBeenCalledWith("old");
      expect(keyOf(fake, "agent-1")).toBeNull();
      expect(keyOf(fake, "agent-2")).toBe("theirs");
    });

    it.each([
      ["locks an attached Shared agent", "shared-1", 403],
      ["404s another workspace's agent", "agent-2", 404],
    ])("DELETE %s", async (_label, id, status) => {
      mockSession();
      avatarWorld();

      const res = await app.request(`${baseUrl}/${id}/avatar`, {
        method: "DELETE",
      });

      expect(res.status).toBe(status);
      expect(deleteAvatar).not.toHaveBeenCalled();
    });
  });

  describe("pin routes", () => {
    /**
     * `agent-1` is this Workspace's own Agent; `shared-1` is a Shared Agent
     * attached here and in `ws-2`; `shared-2` is a Shared Agent attached
     * nowhere; `agent-2` belongs to `ws-2`. `owner` owns both Workspaces.
     */
    const pinWorld = ({
      owner = "user-1",
      role = "member",
      pins = [],
    }: {
      owner?: string;
      role?: "admin" | "member";
      pins?: { workspaceId: string; agentId: string }[];
    } = {}): FakeDb =>
      world({
        owner,
        role,
        rows: {
          agent: [
            workspaceAgent({ name: "Mine" }),
            otherWorkspaceAgent(),
            sharedAgent(),
            sharedAgent({ id: "shared-2", name: "Unattached" }),
          ],
          attachment: [
            attachedHere("shared-1"),
            { ...attachedHere("shared-1"), id: "att-2", workspaceId: "ws-2" },
          ],
          workspace_agent_pin: pins,
        },
      });

    const pin = (agentId: string, method: "PUT" | "DELETE", ws = workspaceId) =>
      app.request(
        `/organizations/${orgId}/workspaces/${ws}/agents/${agentId}/pin`,
        { method },
      );

    const pinned = (fake: FakeDb) =>
      fake.tables.workspace_agent_pin.map((p) => [p.workspaceId, p.agentId]);

    const listed = async (ws = workspaceId) => {
      const res = await app.request(
        `/organizations/${orgId}/workspaces/${ws}/agents`,
      );
      const { results } = (await res.json()) as {
        results: { id: string; isPinned: boolean }[];
      };
      return Object.fromEntries(results.map((a) => [a.id, a.isPinned]));
    };

    it.each([
      ["a Workspace Agent", "agent-1"],
      ["an attached Shared Agent", "shared-1"],
    ])("the Owner pins and unpins %s", async (_label, id) => {
      mockSession();
      const fake = pinWorld();

      expect((await pin(id, "PUT")).status).toBe(200);
      expect(pinned(fake)).toEqual([[workspaceId, id]]);
      expect((await listed())[id]).toBe(true);

      expect((await pin(id, "DELETE")).status).toBe(200);
      expect(pinned(fake)).toEqual([]);
      expect((await listed())[id]).toBe(false);
    });

    it("lists every visible Agent unpinned when nothing is pinned", async () => {
      mockSession();
      pinWorld();

      expect(await listed()).toEqual({ "agent-1": false, "shared-1": false });
    });

    it("pins and unpins idempotently", async () => {
      mockSession();
      const fake = pinWorld();

      expect((await pin("agent-1", "PUT")).status).toBe(200);
      expect((await pin("agent-1", "PUT")).status).toBe(200);
      expect(pinned(fake)).toEqual([[workspaceId, "agent-1"]]);

      expect((await pin("agent-1", "DELETE")).status).toBe(200);
      expect((await pin("agent-1", "DELETE")).status).toBe(200);
      expect(pinned(fake)).toEqual([]);
    });

    it("pins a Shared Agent in this Workspace only", async () => {
      mockSession();
      pinWorld();

      await pin("shared-1", "PUT");

      expect((await listed())["shared-1"]).toBe(true);
      expect((await listed("ws-2"))["shared-1"]).toBe(false);
    });

    it.each([
      ["another Workspace's Agent", "agent-2"],
      ["an unattached Shared Agent", "shared-2"],
      ["a missing Agent", "nope"],
    ])("404s pinning %s", async (_label, id) => {
      mockSession();
      const fake = pinWorld();

      expect((await pin(id, "PUT")).status).toBe(404);
      expect(pinned(fake)).toEqual([]);
    });

    // An Org Admin reaches every Workspace, but a pin is the Owner's call.
    it.each(["PUT", "DELETE"] as const)(
      "refuses %s from a non-Owner",
      async (method) => {
        mockSession();
        const fake = pinWorld({
          owner: "someone-else",
          role: "admin",
          pins: [{ workspaceId, agentId: "agent-1" }],
        });

        expect((await pin("agent-1", method)).status).toBe(403);
        expect(pinned(fake)).toEqual([[workspaceId, "agent-1"]]);
      },
    );
  });

  describe("POST /:agentId/promote", () => {
    const promote = (id = "agent-1") =>
      app.request(`${baseUrl}/${id}/promote`, { method: "POST" });

    /** A Shared Provider `p1`, and a Skill `s1` private to this Workspace. */
    const references = {
      provider: [
        {
          id: "p1",
          name: "Shared Provider",
          organizationId: orgId,
          workspaceId: null,
        },
      ],
      skill: [
        { id: "s1", name: "ws-skill", organizationId: null, workspaceId },
      ],
    };

    it("returns 403 if not org admin", async () => {
      mockSession();
      const fake = world({ rows: { agent: [workspaceAgent()] } });

      const res = await promote();
      expect(res.status).toBe(403);
      expect(agentOf(fake, "agent-1")).toMatchObject({ workspaceId });
    });

    // `agent-2` exists, but in `ws-2`: the promote lookup's Workspace filter
    // is all that keeps it from being re-scoped from here.
    it.each([
      ["does not exist", "nope"],
      ["belongs to another workspace", "agent-2"],
    ])("returns 404 if the agent %s", async (_label, id) => {
      mockSession();
      const fake = world({
        role: "admin",
        rows: { ...references, agent: [otherWorkspaceAgent()] },
      });

      const res = await promote(id);
      expect(res.status).toBe(404);
      expect(agentOf(fake, "agent-2")).toMatchObject({
        workspaceId: "ws-2",
        organizationId: null,
      });
    });

    it("blocks promotion and lists workspace-private references (no-cascade)", async () => {
      mockSession();
      const fake = world({
        role: "admin",
        rows: { ...references, agent: [workspaceAgent({ skillIds: ["s1"] })] },
      });

      const res = await promote();
      expect(res.status).toBe(422);
      const body = (await res.json()) as { blockers: unknown[] };
      expect(body.blockers).toEqual([
        { type: "skill", id: "s1", name: "ws-skill" },
      ]);
      expect(agentOf(fake, "agent-1")).toMatchObject({
        workspaceId,
        organizationId: null,
      });
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a table no test seeded or wrote is absent
      expect(fake.tables.attachment ?? []).toEqual([]);
    });

    it("re-scopes the agent to org and auto-attaches the origin workspace", async () => {
      mockSession();
      const fake = world({
        role: "admin",
        rows: { ...references, agent: [workspaceAgent()] },
      });

      const res = await promote();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({
          id: "agent-1",
          organizationId: orgId,
          workspaceId: null,
          scope: "organization",
        }),
      );
      expect(agentOf(fake, "agent-1")).toMatchObject({
        organizationId: orgId,
        workspaceId: null,
      });
      expect(fake.tables.attachment).toEqual([
        expect.objectContaining({
          workspaceId,
          resourceType: "agent",
          resourceId: "agent-1",
        }),
      ]);
    });
  });
});
