import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

describe("Invitation Link Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    mockDb.innerJoin.mockReturnValue(mockDb);
  });

  const baseUrl = "/invitation-links";
  const INVALID_LINK_BODY = { error: "This invitation link is not valid" };

  const futureDate = () => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString();
  };

  const pastDate = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString();
  };

  describe("GET /:token", () => {
    it("resolves a valid, pending, unexpired token to the invited email and org name", async () => {
      mockDb.limit.mockResolvedValueOnce([
        {
          email: "user@example.com",
          status: "pending",
          expiresAt: futureDate(),
          organizationName: "Acme",
        },
      ]);

      const res = await app.request(`${baseUrl}/tok_valid`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        email: "user@example.com",
        organizationName: "Acme",
      });
    });

    it("404s with the generic message for a token that does not exist", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/tok_unknown`);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(INVALID_LINK_BODY);
    });

    it("404s with the same generic message for an invitation that is no longer pending", async () => {
      mockDb.limit.mockResolvedValueOnce([
        {
          email: "user@example.com",
          status: "accepted",
          expiresAt: futureDate(),
          organizationName: "Acme",
        },
      ]);

      const res = await app.request(`${baseUrl}/tok_accepted`);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(INVALID_LINK_BODY);
    });

    it("404s with the same generic message for an expired invitation", async () => {
      mockDb.limit.mockResolvedValueOnce([
        {
          email: "user@example.com",
          status: "pending",
          expiresAt: pastDate(),
          organizationName: "Acme",
        },
      ]);

      const res = await app.request(`${baseUrl}/tok_expired`);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(INVALID_LINK_BODY);
    });

    // The oracle-safety property itself: an unknown token, a non-pending
    // invitation, and an expired one must be byte-identical to a caller —
    // otherwise the endpoint lets an attacker enumerate which unredeemed
    // tokens are still live.
    it("responds identically for an unknown token, a non-pending invitation, and an expired one", async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      const unknown = await app.request(`${baseUrl}/tok_a`);

      mockDb.limit.mockResolvedValueOnce([
        {
          email: "user@example.com",
          status: "declined",
          expiresAt: futureDate(),
          organizationName: "Acme",
        },
      ]);
      const notPending = await app.request(`${baseUrl}/tok_b`);

      mockDb.limit.mockResolvedValueOnce([
        {
          email: "user@example.com",
          status: "pending",
          expiresAt: pastDate(),
          organizationName: "Acme",
        },
      ]);
      const expired = await app.request(`${baseUrl}/tok_c`);

      const unknownBody = (await unknown.json()) as { error: string };
      const notPendingBody = (await notPending.json()) as { error: string };
      const expiredBody = (await expired.json()) as { error: string };

      expect(unknown.status).toBe(404);
      expect(notPending.status).toBe(404);
      expect(expired.status).toBe(404);
      expect(unknownBody).toEqual(INVALID_LINK_BODY);
      expect(notPendingBody).toEqual(INVALID_LINK_BODY);
      expect(expiredBody).toEqual(INVALID_LINK_BODY);
    });
  });
});
