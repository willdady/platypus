import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetMockDb, seedDb, type Row } from "../test-utils.ts";

vi.mock("./notification.ts", () => ({
  createNotification: vi.fn(() => Promise.resolve({ id: "notification-1" })),
}));

import { createNotification } from "./notification.ts";
import {
  resetA2aTokenTouches,
  sendA2aTokenReminders,
  touchA2aToken,
} from "./a2a-token.ts";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const token = (over: Row = {}): Row => ({
  id: "tok-1",
  endpointId: "ep-1",
  name: "Hermes",
  tokenHash: "h",
  tokenCreatedAt: new Date(NOW.getTime() - 70 * DAY),
  tokenExpiresAt: new Date(NOW.getTime() + 20 * DAY),
  tokenNotice: null,
  lastUsedAt: null,
  lastRejectedAt: null,
  createdAt: new Date(NOW.getTime() - 70 * DAY),
  ...over,
});

const seed = (tokens: Row[] = [token()]) =>
  seedDb({
    workspace: [{ id: "ws-1", organizationId: "org-1", ownerId: "owner-1" }],
    a2a_endpoint: [
      {
        id: "ep-1",
        workspaceId: "ws-1",
        agentId: "agent-1",
        name: "Acme helpdesk",
        description: "Ask about your Acme order",
        enabled: true,
      },
    ],
    a2a_token: tokens,
  });

describe("A2A tokens", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    resetA2aTokenTouches();
  });

  describe("expiry reminders", () => {
    it("sends the 30-day then the 7-day reminder, each once, recorded on the token", async () => {
      const fake = seed();

      await sendA2aTokenReminders(NOW);
      await sendA2aTokenReminders(NOW);
      expect(createNotification).toHaveBeenCalledTimes(1);
      expect(createNotification).toHaveBeenCalledWith(
        expect.anything(),
        { orgId: "org-1", workspaceId: "ws-1", agentId: "agent-1" },
        expect.objectContaining({ title: "A2A token expires soon" }),
      );
      expect(fake.tables.a2a_token[0].tokenNotice).toBe("expiring_30");

      await sendA2aTokenReminders(new Date(NOW.getTime() + 14 * DAY));
      expect(createNotification).toHaveBeenCalledTimes(2);
      expect(fake.tables.a2a_token[0].tokenNotice).toBe("expiring_7");
    });

    it("skips a reminder that would fall before the token was created", async () => {
      // A 30-day token: its 30-day reminder would be the moment of issue.
      const fake = seed([
        token({
          tokenCreatedAt: new Date(NOW.getTime() - DAY),
          tokenExpiresAt: new Date(NOW.getTime() + 29 * DAY),
        }),
      ]);

      await sendA2aTokenReminders(NOW);

      expect(createNotification).not.toHaveBeenCalled();
      expect(fake.tables.a2a_token[0].tokenNotice).toBeNull();
    });

    it("sends nothing for a token far from expiry, or already expired", async () => {
      seed([
        token({
          id: "far",
          tokenExpiresAt: new Date(NOW.getTime() + 60 * DAY),
        }),
        token({ id: "gone", tokenExpiresAt: new Date(NOW.getTime() - DAY) }),
      ]);

      await sendA2aTokenReminders(NOW);

      expect(createNotification).not.toHaveBeenCalled();
    });

    it("sends a reminder again on the next sweep when its Notification could not be posted", async () => {
      const fake = seed();
      vi.mocked(createNotification).mockRejectedValueOnce(new Error("db down"));

      await sendA2aTokenReminders(NOW);
      expect(fake.tables.a2a_token[0].tokenNotice).toBeNull();

      await sendA2aTokenReminders(NOW);
      expect(createNotification).toHaveBeenCalledTimes(2);
      expect(fake.tables.a2a_token[0].tokenNotice).toBe("expiring_30");
    });
  });

  describe("last used and last rejected", () => {
    it("are each written at most once a minute per token", async () => {
      const fake = seed([token(), token({ id: "tok-2" })]);
      const later = new Date(NOW.getTime() + 30_000);
      const nextMinute = new Date(NOW.getTime() + 61_000);

      await touchA2aToken("tok-1", "lastUsedAt", NOW);
      await touchA2aToken("tok-1", "lastUsedAt", later);
      await touchA2aToken("tok-1", "lastRejectedAt", later);
      await touchA2aToken("tok-2", "lastUsedAt", later);
      expect(fake.tables.a2a_token[0].lastUsedAt).toEqual(NOW);
      expect(fake.tables.a2a_token[0].lastRejectedAt).toEqual(later);
      expect(fake.tables.a2a_token[1].lastUsedAt).toEqual(later);

      await touchA2aToken("tok-1", "lastUsedAt", nextMinute);
      expect(fake.tables.a2a_token[0].lastUsedAt).toEqual(nextMinute);
    });

    it("holds the limit across instances: a recent stamp in the row wins", async () => {
      const fake = seed([token({ lastUsedAt: NOW })]);

      // A fresh process (no memory of the stamp) 30s later.
      await touchA2aToken(
        "tok-1",
        "lastUsedAt",
        new Date(NOW.getTime() + 30_000),
      );

      expect(fake.tables.a2a_token[0].lastUsedAt).toEqual(NOW);
    });
  });
});
