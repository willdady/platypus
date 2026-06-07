import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import {
  isResourceListedInBlueprint,
  isBlueprintReferencedByLiveInvitation,
} from "./blueprint-guard.ts";

describe("blueprint-guard", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    mockDb.innerJoin.mockReturnValue(mockDb);
  });

  describe("isResourceListedInBlueprint", () => {
    it("is true when a blueprint_item references the resource", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "item-1" }]);
      expect(await isResourceListedInBlueprint("provider", "prov-1")).toBe(
        true,
      );
    });

    it("is false when no blueprint lists the resource", async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      expect(await isResourceListedInBlueprint("agent", "agent-1")).toBe(false);
    });
  });

  describe("isBlueprintReferencedByLiveInvitation", () => {
    const future = () => {
      const d = new Date();
      d.setDate(d.getDate() + 7);
      return d.toISOString();
    };
    const past = () => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return d.toISOString();
    };

    it("is true when a referencing pending invitation is still live", async () => {
      mockDb.where.mockResolvedValueOnce([{ expiresAt: future() }]);
      expect(await isBlueprintReferencedByLiveInvitation("bp-1")).toBe(true);
    });

    // Expiry is lazy with write-back, so a row past expiresAt may still read
    // 'pending'. The guard must exclude it in app code.
    it("is false when the only referencing pending invite is lazily-expired", async () => {
      mockDb.where.mockResolvedValueOnce([{ expiresAt: past() }]);
      expect(await isBlueprintReferencedByLiveInvitation("bp-1")).toBe(false);
    });

    it("is false when no pending invitation references the blueprint", async () => {
      mockDb.where.mockResolvedValueOnce([]);
      expect(await isBlueprintReferencedByLiveInvitation("bp-1")).toBe(false);
    });

    it("is true when at least one of several invites is still live", async () => {
      mockDb.where.mockResolvedValueOnce([
        { expiresAt: past() },
        { expiresAt: future() },
      ]);
      expect(await isBlueprintReferencedByLiveInvitation("bp-1")).toBe(true);
    });
  });
});
