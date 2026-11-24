import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
} from "../test-utils.ts";
import { webhookEventSchema } from "@platypus/schemas";
import app from "../server.ts";

vi.mock("node:crypto", async () => {
  const actual =
    await vi.importActual<typeof import("node:crypto")>("node:crypto");
  const actualDefault: typeof import("node:crypto") = (
    actual as unknown as { default: typeof import("node:crypto") }
  ).default;
  return {
    ...actual,
    default: {
      ...actualDefault,
      randomBytes: vi.fn().mockReturnValue(Buffer.from("a".repeat(32))),
    },
  };
});

const mockCheckEgress = vi.hoisted(() => vi.fn());
vi.mock("../utils/egress-guard.ts", () => ({ checkEgress: mockCheckEgress }));

const blocked = {
  allowed: false,
  reason: "'internal.example' resolves to 127.0.0.1 (loopback)",
};

describe("Webhook Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockCheckEgress.mockResolvedValue({ allowed: true });
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/webhooks`;

  const webhookRow = (over: Row = {}): Row => ({
    id: "wh-1",
    workspaceId,
    name: "My Webhook",
    url: "https://example.com/webhook",
    signingSecret: "secret",
    headers: { Authorization: "Bearer real-token" },
    enabled: true,
    events: ["notification.created"],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  });

  const world = (rows: { webhook?: Row[] } = {}): FakeDb =>
    seedDb({
      organization_member: [
        { id: "m1", userId: "user-1", organizationId: orgId, role: "member" },
      ],
      workspace: [
        {
          id: workspaceId,
          name: "Support",
          organizationId: orgId,
          ownerId: "user-1",
        },
        { id: "ws-2", name: "Billing", organizationId: orgId, ownerId: "u-2" },
      ],
      webhook: rows.webhook ?? [
        webhookRow(),
        webhookRow({
          id: "wh-2",
          name: "Second Webhook",
          url: "https://example.com/webhook2",
          signingSecret: "secret2",
          headers: null,
          enabled: false,
          events: ["notification.created", "notification.updated"],
        }),
        webhookRow({ id: "wh-elsewhere", workspaceId: "ws-2" }),
      ],
    });

  const idsOf = (fake: FakeDb) => fake.tables.webhook.map((w) => w.id);

  describe("GET /", () => {
    it("should return list of webhooks", async () => {
      mockSession();
      world();

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { results: { name: string }[] };
      expect(data.results).toHaveLength(2);
      expect(data.results[0].name).toBe("My Webhook");
      expect(data.results[1].name).toBe("Second Webhook");
    });

    it("should return empty results when no webhooks exist", async () => {
      mockSession();
      world({ webhook: [] });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { results: unknown[] };
      expect(data.results).toHaveLength(0);
    });
  });

  describe("POST /", () => {
    it("should create webhook and return 201", async () => {
      mockSession();
      const fake = world();

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "My Webhook",
          url: "https://example.com/webhook",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as { url: string; name: string };
      expect(data.url).toBe("https://example.com/webhook");
      expect(data.name).toBe("My Webhook");
      expect(fake.tables.webhook.at(-1)).toMatchObject({
        workspaceId,
        name: "My Webhook",
        url: "https://example.com/webhook",
        enabled: true,
      });
    });

    it("subscribes to every event when events is omitted", async () => {
      mockSession();
      const fake = world();

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "My Webhook",
          url: "https://example.com/webhook",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(fake.tables.webhook.at(-1)?.events).toEqual(
        webhookEventSchema.options,
      );
    });

    it("should reject a URL the network policy blocks", async () => {
      mockSession();
      const fake = world();
      mockCheckEgress.mockResolvedValue(blocked);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "My Webhook",
          url: "https://internal.example/webhook",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe(
        "This URL can't be reached from this deployment, or isn't permitted by its network policy.",
      );
      expect(fake.queries.some((q) => q.kind === "insert")).toBe(false);
    });
  });

  describe("GET /:webhookId", () => {
    it("should return a single webhook", async () => {
      mockSession();
      world();

      const res = await app.request(`${baseUrl}/wh-1`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        name: string;
        headers: Record<string, string>;
      };
      expect(data.name).toBe("My Webhook");
      expect(data.headers).toEqual({ Authorization: "Bearer real-token" });
    });

    it("should return 404 for non-existent webhook", async () => {
      mockSession();
      world();

      const res = await app.request(`${baseUrl}/nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /:webhookId", () => {
    it("should update webhook", async () => {
      mockSession();
      const fake = world();

      const res = await app.request(`${baseUrl}/wh-1`, {
        method: "PATCH",
        body: JSON.stringify({
          name: "Updated Webhook",
          url: "https://new-url.com/webhook",
          enabled: false,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { name: string; url: string };
      expect(data.name).toBe("Updated Webhook");
      expect(data.url).toBe("https://new-url.com/webhook");
      expect(fake.tables.webhook[0]).toMatchObject({
        name: "Updated Webhook",
        url: "https://new-url.com/webhook",
        enabled: false,
      });
      expect(fake.tables.webhook[1].name).toBe("Second Webhook");
    });

    it("should return 404 for non-existent webhook", async () => {
      mockSession();
      const fake = world();

      const res = await app.request(`${baseUrl}/nonexistent`, {
        method: "PATCH",
        body: JSON.stringify({
          url: "https://new-url.com/webhook",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
      expect(idsOf(fake)).toEqual(["wh-1", "wh-2", "wh-elsewhere"]);
    });

    it("should reject a URL the network policy blocks", async () => {
      mockSession();
      const fake = world();
      mockCheckEgress.mockResolvedValue(blocked);

      const res = await app.request(`${baseUrl}/wh-1`, {
        method: "PATCH",
        body: JSON.stringify({ url: "https://internal.example/webhook" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      expect(fake.queries.some((q) => q.kind === "update")).toBe(false);
      expect(fake.tables.webhook[0].url).toBe("https://example.com/webhook");
    });
  });

  describe("DELETE /:webhookId", () => {
    it("should delete webhook", async () => {
      mockSession();
      const fake = world();

      const res = await app.request(`${baseUrl}/wh-1`, {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Webhook deleted" });
      expect(idsOf(fake)).toEqual(["wh-2", "wh-elsewhere"]);
    });

    it("should return 404 for non-existent webhook", async () => {
      mockSession();
      const fake = world();

      const res = await app.request(`${baseUrl}/nonexistent`, {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
      expect(idsOf(fake)).toEqual(["wh-1", "wh-2", "wh-elsewhere"]);
    });
  });

  describe("POST /:webhookId/regenerate-secret", () => {
    it("should regenerate signing secret and return full record", async () => {
      mockSession();
      const fake = world();
      const regenerated = Buffer.from("a".repeat(32)).toString("hex");

      const res = await app.request(`${baseUrl}/wh-1/regenerate-secret`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { signingSecret: string };
      expect(data.signingSecret).toBe(regenerated);
      expect(fake.tables.webhook[0].signingSecret).toBe(regenerated);
      expect(fake.tables.webhook[1].signingSecret).toBe("secret2");
    });

    it("should return 404 for non-existent webhook", async () => {
      mockSession();
      const fake = world();

      const res = await app.request(
        `${baseUrl}/nonexistent/regenerate-secret`,
        {
          method: "POST",
        },
      );

      expect(res.status).toBe(404);
      expect(fake.tables.webhook[0].signingSecret).toBe("secret");
    });
  });
});
