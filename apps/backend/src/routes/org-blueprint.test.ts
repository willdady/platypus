import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  dbError,
  insertTimestamps,
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
  type Store,
} from "../test-utils.ts";
import type { FakeDbOptions } from "../fake-db.ts";
import app from "../server.ts";

describe("Organization Blueprint Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/blueprints`;

  const json = (method: string, body: unknown) => ({
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

  const blueprintRow = (over: Row = {}): Row => ({
    id: "bp-1",
    organizationId: orgId,
    name: "Starter kit",
    description: null,
    taskModelProviderId: null,
    memoryExtractionProviderId: null,
    memoryEmbeddingProviderId: null,
    context: null,
    ...insertTimestamps(),
    ...over,
  });

  const itemRows = (blueprintId: string, items: [string, string][]): Row[] =>
    items.map(([resourceType, resourceId], index) => ({
      id: `${blueprintId}-item-${index}`,
      blueprintId,
      resourceType,
      resourceId,
      createdAt: insertTimestamps().createdAt,
    }));

  const sharedAgent = (over: Row = {}): Row => ({
    id: "agent-1",
    organizationId: orgId,
    workspaceId: null,
    name: "Shared Agent",
    ...over,
  });

  const sharedSkill = (over: Row = {}): Row => ({
    id: "skill-1",
    organizationId: orgId,
    workspaceId: null,
    name: "Shared Skill",
    ...over,
  });

  const sharedProvider = (over: Row = {}): Row => ({
    id: "prov-1",
    organizationId: orgId,
    workspaceId: null,
    name: "Shared Provider",
    memoryExtractionModelId: "extract-model",
    embeddingModelId: "emb-model",
    ...over,
  });

  const uniqueBlueprintName = {
    name: "unique_blueprint_name_org",
    columns: ["organizationId", "name"],
  };

  const world = (
    role: "admin" | "member" = "admin",
    rows: Store = {},
    options: FakeDbOptions = {},
  ): FakeDb =>
    seedDb(
      {
        organization_member: [
          { id: "m1", userId: "user-1", organizationId: orgId, role },
        ],
        workspace: [{ id: "ws-1", organizationId: orgId, ownerId: "user-1" }],
        agent: [sharedAgent()],
        skill: [sharedSkill()],
        provider: [sharedProvider()],
        ...rows,
      },
      {
        unique: {
          blueprint: [uniqueBlueprintName],
          attachment: [
            {
              name: "unique_attachment",
              columns: ["workspaceId", "resourceType", "resourceId"],
            },
          ],
        },
        defaults: { blueprint: insertTimestamps() },
        ...options,
      },
    );

  const writes = (fake: FakeDb) =>
    fake.queries.filter((query) => query.kind !== "select");

  describe("POST /", () => {
    const body = {
      name: "Starter kit",
      description: "Provisions the core shared resources.",
      items: [{ resourceType: "agent", resourceId: "agent-1" }],
    };

    it("creates a blueprint when all items are org-scoped (admin)", async () => {
      mockSession();
      const fake = world("admin");

      const res = await app.request(baseUrl, json("POST", body));

      expect(res.status).toBe(201);
      const created = (await res.json()) as Row;
      expect(created.id).toBe(fake.tables.blueprint[0].id);
      expect(created.items).toEqual([
        { resourceType: "agent", resourceId: "agent-1" },
      ]);
      expect(fake.tables.blueprint).toEqual([
        expect.objectContaining({
          id: created.id,
          organizationId: orgId,
          name: "Starter kit",
          description: "Provisions the core shared resources.",
        }),
      ]);
      expect(fake.tables.blueprint_item).toEqual([
        expect.objectContaining({
          blueprintId: created.id,
          resourceType: "agent",
          resourceId: "agent-1",
        }),
      ]);
    });

    it("404s when an item is not an org-scoped resource", async () => {
      mockSession();
      const fake = world("admin", {
        agent: [sharedAgent({ organizationId: "org-2" })],
        blueprint: [],
      });

      const res = await app.request(baseUrl, json("POST", body));

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: "Shared resources not found in this organization: agent agent-1",
      });
      expect(fake.tables.blueprint).toEqual([]);
    });

    it("409s on a duplicate blueprint name", async () => {
      mockSession();
      const fake = world("admin", {
        blueprint: [blueprintRow({ name: "Starter kit" })],
      });

      const res = await app.request(
        baseUrl,
        json("POST", { name: "Starter kit", items: [] }),
      );

      expect(res.status).toBe(409);
      expect(fake.tables.blueprint).toEqual([
        expect.objectContaining({ id: "bp-1", name: "Starter kit" }),
      ]);
    });

    it("403s for a non-admin", async () => {
      mockSession();
      const fake = world("member", { blueprint: [] });

      const res = await app.request(baseUrl, json("POST", body));

      expect(res.status).toBe(403);
      expect(fake.tables.blueprint).toEqual([]);
      expect(writes(fake)).toEqual([]);
    });

    it("persists Tier 2 settings when the provider is also an attached item", async () => {
      mockSession();
      const fake = world("admin");

      const res = await app.request(
        baseUrl,
        json("POST", {
          name: "Starter kit",
          items: [{ resourceType: "provider", resourceId: "prov-1" }],
          taskModelProviderId: "prov-1",
          context: "Default context",
        }),
      );

      expect(res.status).toBe(201);
      const created = (await res.json()) as Row;
      expect(created.taskModelProviderId).toBe("prov-1");
      expect(created.context).toBe("Default context");
      expect(fake.tables.blueprint).toEqual([
        expect.objectContaining({
          taskModelProviderId: "prov-1",
          context: "Default context",
        }),
      ]);
    });

    it("400s, naming it, when a Tier 2 provider is not attached by the blueprint", async () => {
      mockSession();
      const fake = world("admin");

      const res = await app.request(
        baseUrl,
        json("POST", {
          name: "Starter kit",
          items: [],
          memoryEmbeddingProviderId: "prov-x",
        }),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error:
          "A blueprint's provider settings must reference providers the blueprint also attaches: prov-x",
      });
      expect(writes(fake)).toEqual([]);
    });

    it("400s, naming it, when the memory embedding provider has no embedding model", async () => {
      mockSession();
      const fake = world("admin", {
        provider: [sharedProvider({ embeddingModelId: null })],
      });

      const res = await app.request(
        baseUrl,
        json("POST", {
          name: "Starter kit",
          items: [{ resourceType: "provider", resourceId: "prov-1" }],
          memoryEmbeddingProviderId: "prov-1",
        }),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error:
          "Invalid memory provider settings: memoryEmbeddingProviderId prov-1 does not have an embedding model configured",
      });
      expect(writes(fake)).toEqual([]);
    });

    it("creates when the memory embedding provider has an embedding model", async () => {
      mockSession();
      const fake = world("admin");

      const res = await app.request(
        baseUrl,
        json("POST", {
          name: "Starter kit",
          items: [{ resourceType: "provider", resourceId: "prov-1" }],
          memoryEmbeddingProviderId: "prov-1",
        }),
      );

      expect(res.status).toBe(201);
      expect(
        ((await res.json()) as { memoryEmbeddingProviderId: string })
          .memoryEmbeddingProviderId,
      ).toBe("prov-1");
      expect(fake.tables.blueprint).toEqual([
        expect.objectContaining({ memoryEmbeddingProviderId: "prov-1" }),
      ]);
    });
  });

  describe("GET /", () => {
    it("lists blueprints with their items (admin)", async () => {
      mockSession();
      world("admin", {
        blueprint: [
          blueprintRow(),
          blueprintRow({ id: "bp-other", organizationId: "org-2" }),
        ],
        blueprint_item: [
          ...itemRows("bp-1", [
            ["agent", "agent-1"],
            ["skill", "skill-1"],
          ]),
          ...itemRows("bp-other", [["agent", "agent-other"]]),
        ],
      });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: { id: string; items: unknown[] }[];
      };
      expect(body.results.map((blueprint) => blueprint.id)).toEqual(["bp-1"]);
      expect(body.results[0].items).toHaveLength(2);
      expect(body.results[0].items).toEqual([
        { resourceType: "agent", resourceId: "agent-1" },
        { resourceType: "skill", resourceId: "skill-1" },
      ]);
    });

    it("403s for a non-admin", async () => {
      mockSession();
      world("member");

      const res = await app.request(baseUrl);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /:blueprintId", () => {
    it("returns a blueprint with its items", async () => {
      mockSession();
      world("admin", {
        blueprint: [blueprintRow()],
        blueprint_item: itemRows("bp-1", [["agent", "agent-1"]]),
      });

      const res = await app.request(`${baseUrl}/bp-1`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.id).toBe("bp-1");
      expect(json.items).toEqual([
        { resourceType: "agent", resourceId: "agent-1" },
      ]);
    });

    it("404s when the blueprint is not in this org", async () => {
      mockSession();
      world("admin", {
        blueprint: [blueprintRow({ id: "bp-other", organizationId: "org-2" })],
      });

      const res = await app.request(`${baseUrl}/bp-other`);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:blueprintId", () => {
    const body = {
      name: "Starter kit v2",
      items: [{ resourceType: "skill", resourceId: "skill-1" }],
    };

    it("replaces the item set (snapshot semantics) and returns the blueprint", async () => {
      mockSession();
      const fake = world("admin", {
        blueprint: [blueprintRow()],
        blueprint_item: itemRows("bp-1", [["agent", "agent-1"]]),
      });

      const res = await app.request(`${baseUrl}/bp-1`, json("PUT", body));

      expect(res.status).toBe(200);
      const updated = (await res.json()) as Record<string, unknown>;
      expect(updated.items).toEqual([
        { resourceType: "skill", resourceId: "skill-1" },
      ]);
      expect(
        fake.queries.some(
          (query) =>
            query.kind === "delete" && query.table === "blueprint_item",
        ),
      ).toBe(true);
      expect(fake.tables.blueprint).toEqual([
        expect.objectContaining({ id: "bp-1", name: "Starter kit v2" }),
      ]);
      expect(fake.tables.blueprint_item).toEqual([
        expect.objectContaining({
          blueprintId: "bp-1",
          resourceType: "skill",
          resourceId: "skill-1",
        }),
      ]);
    });

    it("404s when the blueprint does not exist", async () => {
      mockSession();
      world("admin");

      const res = await app.request(`${baseUrl}/missing`, json("PUT", body));
      expect(res.status).toBe(404);
    });

    it("404s when an item is not org-scoped", async () => {
      mockSession();
      const fake = world("admin", {
        blueprint: [blueprintRow()],
        blueprint_item: itemRows("bp-1", [["agent", "agent-1"]]),
        skill: [sharedSkill({ organizationId: null, workspaceId: "ws-1" })],
      });

      const res = await app.request(`${baseUrl}/bp-1`, json("PUT", body));

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: "Shared resources not found in this organization: skill skill-1",
      });
      expect(fake.tables.blueprint).toEqual([
        expect.objectContaining({ name: "Starter kit" }),
      ]);
      expect(fake.queries.some((query) => query.kind === "delete")).toBe(false);
    });

    it("409s when renamed to another blueprint's name", async () => {
      mockSession();
      world(
        "admin",
        {
          blueprint: [
            blueprintRow(),
            blueprintRow({ id: "bp-2", name: "Taken" }),
          ],
        },
        {
          onQuery: (query) => {
            if (query.kind === "update" && query.table === "blueprint") {
              throw dbError("23505");
            }
          },
        },
      );

      const res = await app.request(
        `${baseUrl}/bp-1`,
        json("PUT", { name: "Taken", items: [] }),
      );
      expect(res.status).toBe(409);
    });

    it("400s, naming it, when a Tier 2 provider is not attached by the blueprint", async () => {
      mockSession();
      const fake = world("admin", { blueprint: [blueprintRow()] });

      const res = await app.request(
        `${baseUrl}/bp-1`,
        json("PUT", {
          name: "Starter kit v2",
          items: [],
          taskModelProviderId: "prov-1",
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error:
          "A blueprint's provider settings must reference providers the blueprint also attaches: prov-1",
      });
      expect(writes(fake)).toEqual([]);
    });

    it("403s for a non-admin", async () => {
      mockSession();
      const fake = world("member");

      const res = await app.request(`${baseUrl}/bp-1`, json("PUT", body));
      expect(res.status).toBe(403);
      expect(writes(fake)).toEqual([]);
    });
  });

  describe("DELETE /:blueprintId", () => {
    const liveInvitation = (
      expiresAt: Date,
      over: Row = {},
    ): { invitation: Row[]; invitation_blueprint: Row[] } => ({
      invitation: [
        {
          id: "inv-1",
          email: "invitee@example.com",
          organizationId: orgId,
          status: "pending",
          token: "tok-1",
          expiresAt,
          ...over,
        },
        {
          id: "inv-2",
          email: "other@example.com",
          organizationId: orgId,
          status: "pending",
          token: "tok-2",
          expiresAt,
        },
      ],
      invitation_blueprint: [
        { id: "ib-1", invitationId: "inv-1", blueprintId: "bp-1", position: 0 },
        { id: "ib-2", invitationId: "inv-2", blueprintId: "bp-2", position: 0 },
      ],
    });

    it("deletes a blueprint (admin) when no live invitation references it", async () => {
      mockSession();
      const fake = world("admin", { blueprint: [blueprintRow()] });

      const res = await app.request(`${baseUrl}/bp-1`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Blueprint deleted" });
      expect(fake.tables.blueprint).toEqual([]);
      expect(
        fake.queries.some(
          (query) => query.kind === "delete" && query.table === "blueprint",
        ),
      ).toBe(true);
    });

    it("404s when the blueprint does not exist", async () => {
      mockSession();
      world("admin");

      const res = await app.request(`${baseUrl}/missing`, { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("409s when a live pending invitation references the blueprint", async () => {
      mockSession();
      const future = new Date();
      future.setDate(future.getDate() + 7);
      const fake = world("admin", {
        blueprint: [blueprintRow()],
        ...liveInvitation(future),
      });

      const res = await app.request(`${baseUrl}/bp-1`, { method: "DELETE" });
      expect(res.status).toBe(409);
      expect(fake.tables.blueprint).toEqual([
        expect.objectContaining({ id: "bp-1" }),
      ]);
      expect(fake.queries.some((query) => query.kind === "delete")).toBe(false);
    });

    it("allows deletion when the only referencing invitation is lazily-expired", async () => {
      mockSession();
      const past = new Date();
      past.setDate(past.getDate() - 1);
      const fake = world("admin", {
        blueprint: [blueprintRow()],
        ...liveInvitation(past),
      });

      const res = await app.request(`${baseUrl}/bp-1`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Blueprint deleted" });
      expect(fake.tables.blueprint).toEqual([]);
    });

    it("403s for a non-admin", async () => {
      mockSession();
      const fake = world("member", { blueprint: [blueprintRow()] });

      const res = await app.request(`${baseUrl}/bp-1`, { method: "DELETE" });
      expect(res.status).toBe(403);
      expect(fake.tables.blueprint).toEqual([
        expect.objectContaining({ id: "bp-1" }),
      ]);
    });
  });

  describe("POST /:blueprintId/apply", () => {
    const applyUrl = `${baseUrl}/bp-1/apply`;
    const body = { workspaceId: "ws-1" };
    const items = itemRows("bp-1", [
      ["agent", "agent-1"],
      ["skill", "skill-1"],
    ]);
    const tier2Blueprint = (over: Row = {}): Row =>
      blueprintRow({
        taskModelProviderId: "prov-1",
        memoryExtractionProviderId: null,
        memoryEmbeddingProviderId: null,
        context: "Default context",
        ...over,
      });

    it("creates the attachments and stamps Tier 2 settings", async () => {
      mockSession();
      const fake = world("admin", {
        blueprint: [tier2Blueprint()],
        blueprint_item: items,
      });

      const res = await app.request(applyUrl, json("POST", body));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        workspaceId: "ws-1",
        attached: 2,
        skipped: 0,
        total: 2,
      });
      expect(fake.tables.attachment).toEqual([
        expect.objectContaining({
          workspaceId: "ws-1",
          resourceType: "agent",
          resourceId: "agent-1",
        }),
        expect.objectContaining({
          workspaceId: "ws-1",
          resourceType: "skill",
          resourceId: "skill-1",
        }),
      ]);
      expect(fake.tables.workspace).toEqual([
        expect.objectContaining({
          id: "ws-1",
          taskModelProviderId: "prov-1",
          context: "Default context",
        }),
      ]);
    });

    it("is idempotent: a re-apply where everything is attached is a no-op", async () => {
      mockSession();
      const fake = world("admin", {
        blueprint: [tier2Blueprint()],
        blueprint_item: items,
        attachment: [
          {
            id: "att-1",
            workspaceId: "ws-1",
            resourceType: "agent",
            resourceId: "agent-1",
          },
          {
            id: "att-2",
            workspaceId: "ws-1",
            resourceType: "skill",
            resourceId: "skill-1",
          },
        ],
      });

      const res = await app.request(applyUrl, json("POST", body));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        workspaceId: "ws-1",
        attached: 0,
        skipped: 2,
        total: 2,
      });
      expect(fake.tables.attachment.map((a) => a.id)).toEqual([
        "att-1",
        "att-2",
      ]);
    });

    it("handles an empty blueprint without inserting attachments", async () => {
      mockSession();
      const fake = world("admin", {
        blueprint: [
          tier2Blueprint({
            taskModelProviderId: null,
            context: null,
          }),
        ],
        blueprint_item: [],
      });

      const res = await app.request(applyUrl, json("POST", body));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        workspaceId: "ws-1",
        attached: 0,
        skipped: 0,
        total: 0,
      });
      expect(writes(fake)).toEqual([]);
      expect(fake.tables.workspace).toEqual([
        expect.not.objectContaining({ taskModelProviderId: "prov-1" }),
      ]);
    });

    it("404s when the blueprint is not in this org", async () => {
      mockSession();
      const fake = world("admin", {
        blueprint: [blueprintRow({ organizationId: "org-2" })],
        blueprint_item: items,
        attachment: [],
      });

      const res = await app.request(applyUrl, json("POST", body));
      expect(res.status).toBe(404);
      expect(fake.tables.attachment).toEqual([]);
    });

    it("404s when the workspace is not in this org", async () => {
      mockSession();
      const fake = world("admin", {
        workspace: [{ id: "ws-1", organizationId: "org-2", ownerId: "user-1" }],
        blueprint: [tier2Blueprint()],
        blueprint_item: items,
        attachment: [],
      });

      const res = await app.request(applyUrl, json("POST", body));
      expect(res.status).toBe(404);
      expect(fake.tables.attachment).toEqual([]);
    });

    it("403s for a non-admin", async () => {
      mockSession();
      const fake = world("member");

      const res = await app.request(applyUrl, json("POST", body));
      expect(res.status).toBe(403);
      expect(writes(fake)).toEqual([]);
    });
  });
});
