import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockSession,
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
 * Fixture rows, not stubbed query results: `seedDb()` evaluates the `WHERE`
 * each query builds, so a lookup or write that dropped the Shared predicate —
 * `organizationId` plus `workspaceId IS NULL` (ADR-0007) — reaches a row it
 * should not and the test fails.
 */
describe("Organization Agent Routes", () => {
  let fake: FakeDb;

  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/agents`;

  /** An Agent row; Shared in `org-1` unless overridden. */
  const agentRow = (id: string, over: Store[string][number] = {}) => ({
    id,
    name: id,
    description: "An agent",
    providerId: "p1",
    modelId: "m1",
    organizationId: orgId,
    workspaceId: null,
    avatarKey: null,
    subAgentIds: [],
    ...over,
  });

  /**
   * The caller (`user-1`) is a member of `org-1` at `role`. `agent-1` is a
   * Shared Agent of `org-1`; `ws-agent` belongs to `ws-1` while also carrying
   * `org-1`; `foreign` is Shared in `org-2`. `p1` is a Shared Provider and
   * `ws-p` a Workspace-private one.
   */
  const world = (
    options: { role?: "admin" | "member"; rows?: Store } = {},
  ): FakeDb => {
    const { role = "admin", rows = {} } = options;
    return seedDb({
      organization_member: [
        { id: "m1", userId: "user-1", organizationId: orgId, role },
      ],
      agent: [
        agentRow("agent-1", { name: "Shared Agent", avatarKey: "old" }),
        agentRow("ws-agent", { workspaceId: "ws-1" }),
        agentRow("foreign", { organizationId: "org-2" }),
      ],
      provider: [
        {
          id: "p1",
          name: "Shared Provider",
          organizationId: orgId,
          workspaceId: null,
        },
        {
          id: "ws-p",
          name: "WS Provider",
          organizationId: null,
          workspaceId: "ws-1",
        },
      ],
      ...rows,
    });
  };

  const find = (id: string) => fake.tables.agent.find((a) => a.id === id);

  describe("GET /", () => {
    it("lists only this Organization's Shared agents, for any member", async () => {
      mockSession();
      fake = world({ role: "member" });

      const res = await app.request(baseUrl);

      expect(res.status).toBe(200);
      // Guards `sharedWhere`: `ws-agent` carries org-1 but sits in a Workspace,
      // and `foreign` is another Organization's.
      expect(await res.json()).toEqual({
        results: [
          expect.objectContaining({ id: "agent-1", name: "Shared Agent" }),
        ],
      });
    });
  });

  describe("GET /:agentId", () => {
    it("returns an org agent", async () => {
      mockSession();
      fake = world({ role: "member" });

      const res = await app.request(`${baseUrl}/agent-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({ id: "agent-1", organizationId: orgId }),
      );
    });

    it.each(["missing", "foreign", "ws-agent"])(
      "returns 404 for %s, which is not a Shared agent here",
      async (id) => {
        // Guards `orgScopedWhere`'s organizationId and workspaceId columns.
        mockSession();
        fake = world({ role: "member" });

        const res = await app.request(`${baseUrl}/${id}`);
        expect(res.status).toBe(404);
      },
    );
  });

  describe("PUT /:agentId", () => {
    const put = (id: string, over: Record<string, unknown> = {}) =>
      app.request(`${baseUrl}/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Renamed",
          description: "A shared agent",
          providerId: "p1",
          modelId: "m1",
          ...over,
        }),
        headers: { "Content-Type": "application/json" },
      });

    it("updates an org agent if org admin and references stay shared", async () => {
      mockSession();
      fake = world();

      const res = await put("agent-1");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({ id: "agent-1", name: "Renamed" }),
      );
      expect(find("agent-1")).toMatchObject({
        name: "Renamed",
        description: "A shared agent",
      });
    });

    it("blocks an update that references a workspace-private resource", async () => {
      mockSession();
      fake = world();

      const res = await put("agent-1", { providerId: "ws-p" });

      // Not Shared reads as not found here (api-conventions), and the message
      // names what couldn't be used.
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error:
          "A shared agent may only reference other shared (organization-scoped) resources: WS Provider (provider)",
      });
      expect(find("agent-1")).toMatchObject({ name: "Shared Agent" });
    });

    it.each(["missing", "foreign", "ws-agent"])(
      "returns 404 and writes nothing for %s, which is not visible here",
      async (id) => {
        // A row carrying both scope columns belongs to its Workspace and must
        // not be editable from the Organization surface (ADR-0007).
        mockSession();
        fake = world();

        const res = await put(id);

        expect(res.status).toBe(404);
        expect(fake.tables.agent.map((a) => a.name)).not.toContain("Renamed");
      },
    );

    it("rejects a self-assigned sub-agent", async () => {
      mockSession();
      fake = world();

      const res = await put("agent-1", { subAgentIds: ["agent-1"] });

      expect(res.status).toBe(400);
      expect(find("agent-1")).toMatchObject({ name: "Shared Agent" });
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      fake = world({ role: "member" });

      const res = await put("agent-1");

      expect(res.status).toBe(403);
      expect(find("agent-1")).toMatchObject({ name: "Shared Agent" });
    });
  });

  describe("DELETE /:agentId", () => {
    const del = (id: string) =>
      app.request(`${baseUrl}/${id}`, { method: "DELETE" });

    it("deletes an unattached org agent, scrubs references and removes its avatar", async () => {
      mockSession();
      fake = world({
        rows: {
          agent: [
            agentRow("agent-1", { avatarKey: "agents/agent-1/avatar-x.webp" }),
            agentRow("parent", { subAgentIds: ["agent-1", "other"] }),
          ],
        },
      });

      const res = await del("agent-1");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Agent deleted" });
      expect(find("agent-1")).toBeUndefined();
      expect(find("parent")?.subAgentIds).toEqual(["other"]);
      expect(deleteAvatar).toHaveBeenCalledWith("agents/agent-1/avatar-x.webp");
    });

    it.each(["foreign", "ws-agent"])(
      "returns 404 and keeps %s, which is not a Shared agent here",
      async (id) => {
        // Guards `orgScopedWhere` on the DELETE: the attachment/blueprint
        // guards do not check existence, so the write's own predicate is all
        // that keeps another scope's row.
        mockSession();
        fake = world();

        const res = await del(id);

        expect(res.status).toBe(404);
        expect(find(id)).toBeDefined();
      },
    );

    it("returns 409 when the agent is attached to a workspace", async () => {
      mockSession();
      fake = world({
        rows: {
          attachment: [
            {
              id: "att-1",
              workspaceId: "ws-1",
              resourceType: "agent",
              resourceId: "agent-1",
            },
          ],
        },
      });

      const res = await del("agent-1");
      expect(res.status).toBe(409);
      expect(find("agent-1")).toBeDefined();
    });

    it("returns 409 when the agent is listed in a blueprint", async () => {
      mockSession();
      fake = world({
        rows: {
          blueprint_item: [
            { id: "bpi-1", resourceType: "agent", resourceId: "agent-1" },
          ],
        },
      });

      const res = await del("agent-1");
      expect(res.status).toBe(409);
      expect(find("agent-1")).toBeDefined();
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      fake = world({ role: "member" });

      const res = await del("agent-1");
      expect(res.status).toBe(403);
      expect(find("agent-1")).toBeDefined();
    });
  });

  describe("avatar routes", () => {
    it("POST avatar rejects a body over the limit before reading it", async () => {
      mockSession();
      fake = world();
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

    const upload = (id = "agent-1") => {
      const form = new FormData();
      form.append("file", new File(["x"], "a.png", { type: "image/png" }));
      return app.request(`${baseUrl}/${id}/avatar`, {
        method: "POST",
        body: form,
      });
    };

    it("POST avatar returns 403 for a non-admin", async () => {
      mockSession();
      fake = world({ role: "member" });

      const res = await app.request(`${baseUrl}/agent-1/avatar`, {
        method: "POST",
      });
      expect(res.status).toBe(403);
    });

    it("POST avatar stores the upload and persists its key on the Shared agent", async () => {
      mockSession();
      fake = world();
      vi.mocked(storeAvatar).mockResolvedValue({ ok: true, key: "new" });

      const res = await upload();

      expect(res.status).toBe(200);
      expect(storeAvatar).toHaveBeenCalledWith(
        expect.any(File),
        "agent-1",
        "old",
      );
      expect(find("agent-1")?.avatarKey).toBe("new");
    });

    it("POST avatar returns 400 when the upload is rejected", async () => {
      mockSession();
      fake = world();
      vi.mocked(storeAvatar).mockResolvedValue({
        ok: false,
        error: "Invalid file type",
      });

      const res = await upload();

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid file type" });
      expect(find("agent-1")?.avatarKey).toBe("old");
    });

    it.each(["missing", "ws-agent"])(
      "POST avatar 404s for %s, which is not a Shared agent here",
      async (id) => {
        mockSession();
        fake = world();

        const res = await upload(id);

        expect(res.status).toBe(404);
        expect(storeAvatar).not.toHaveBeenCalled();
      },
    );

    it("DELETE avatar clears the avatar for an org admin", async () => {
      mockSession();
      fake = world();

      const res = await app.request(`${baseUrl}/agent-1/avatar`, {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(deleteAvatar).toHaveBeenCalledWith("old");
      expect(find("agent-1")?.avatarKey).toBeNull();
    });

    it("DELETE avatar 404s when the org agent does not exist", async () => {
      mockSession();
      fake = world();

      const res = await app.request(`${baseUrl}/missing/avatar`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
      expect(deleteAvatar).not.toHaveBeenCalled();
    });
  });
});
