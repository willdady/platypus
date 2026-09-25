import { describe, it, expect, beforeEach } from "vitest";
import { resetMockDb, seedDb, type Row } from "../test-utils.ts";
import {
  isResourceListedInBlueprint,
  isBlueprintReferencedByLiveInvitation,
} from "./blueprint-guard.ts";

const DAY = 24 * 60 * 60 * 1000;
const future = () => new Date(Date.now() + 7 * DAY).toISOString();
const past = () => new Date(Date.now() - DAY).toISOString();

describe("blueprint-guard", () => {
  beforeEach(() => {
    resetMockDb();
  });

  describe("isResourceListedInBlueprint", () => {
    beforeEach(() => {
      seedDb({
        blueprint_item: [
          { id: "item-1", resourceType: "provider", resourceId: "prov-1" },
        ],
      });
    });

    it("is true when a blueprint_item references the resource", async () => {
      expect(await isResourceListedInBlueprint("provider", "prov-1")).toBe(
        true,
      );
    });

    it.each([
      ["another id", "provider", "prov-2"],
      ["the same id under another type", "agent", "prov-1"],
    ] as const)("is false for %s", async (_label, type, id) => {
      expect(await isResourceListedInBlueprint(type, id)).toBe(false);
    });
  });

  describe("isBlueprintReferencedByLiveInvitation", () => {
    const invitation = (
      id: string,
      status: string,
      expiresAt: string,
    ): Row => ({
      id,
      status,
      expiresAt,
    });

    /** Seeds invitations, each linked to `bp-1` unless it names another blueprint. */
    const seed = (invitations: Row[], blueprintId = "bp-1") =>
      seedDb({
        invitation: invitations,
        invitation_blueprint: invitations.map((inv) => ({
          invitationId: inv.id,
          blueprintId,
        })),
      });

    it("is true when a referencing pending invitation is still live", async () => {
      seed([invitation("inv-1", "pending", future())]);
      expect(await isBlueprintReferencedByLiveInvitation("bp-1")).toBe(true);
    });

    // Expiry is lazy with write-back, so a row past expiresAt may still read
    // 'pending'. The guard must exclude it in app code.
    it("is false when the only referencing pending invite is lazily-expired", async () => {
      seed([invitation("inv-1", "pending", past())]);
      expect(await isBlueprintReferencedByLiveInvitation("bp-1")).toBe(false);
    });

    it("is false when the only live invite is no longer pending", async () => {
      seed([invitation("inv-1", "accepted", future())]);
      expect(await isBlueprintReferencedByLiveInvitation("bp-1")).toBe(false);
    });

    it("is false when the live pending invite references another blueprint", async () => {
      seed([invitation("inv-1", "pending", future())], "bp-2");
      expect(await isBlueprintReferencedByLiveInvitation("bp-1")).toBe(false);
    });

    it("is true when at least one of several invites is still live", async () => {
      seed([
        invitation("inv-1", "pending", past()),
        invitation("inv-2", "pending", future()),
      ]);
      expect(await isBlueprintReferencedByLiveInvitation("bp-1")).toBe(true);
    });
  });
});
