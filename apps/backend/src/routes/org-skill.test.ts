import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

describe("Organization Skill Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/skills`;

  const createBody = {
    name: "org-skill",
    description: "This is a long enough description for the skill.",
    body: "This is a long enough body for the skill to pass the validation requirements.",
    organizationId: orgId,
  };

  describe("POST /", () => {
    it("creates an org skill if org admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess

      const mockSkill = {
        id: "skill-1",
        name: "org-skill",
        organizationId: orgId,
        workspaceId: null,
      };
      mockDb.returning.mockResolvedValueOnce([mockSkill]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(createBody),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockSkill);
    });

    it("returns 403 if not org admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(createBody),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(403);
    });

    it("returns 409 if a skill name already exists in the org", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess

      const err = new Error("DrizzleQueryError");
      (err as any).cause = {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "unique_skill_name_org"',
      };
      mockDb.returning.mockRejectedValueOnce(err);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(createBody),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(409);
    });
  });

  describe("GET /", () => {
    it("lists org skills for any member", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      const skills = [{ id: "skill-1", name: "org-skill" }];
      mockDb.where.mockReturnValueOnce(mockDb).mockResolvedValueOnce(skills);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: skills });
    });
  });

  describe("GET /:skillId", () => {
    it("returns an org skill", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      const skill = { id: "skill-1", name: "org-skill", organizationId: orgId };
      mockDb.limit.mockResolvedValueOnce([skill]);

      const res = await app.request(`${baseUrl}/skill-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(skill);
    });

    it("returns 404 if not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/missing`);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:skillId", () => {
    it("updates an org skill if org admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      const updated = {
        id: "skill-1",
        name: "org-skill",
        organizationId: orgId,
      };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const res = await app.request(`${baseUrl}/skill-1`, {
        method: "PUT",
        body: JSON.stringify({
          name: "org-skill",
          description: "This is a long enough description for the skill.",
          body: "This is a long enough body for the skill to pass the validation requirements.",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(updated);
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const res = await app.request(`${baseUrl}/skill-1`, {
        method: "PUT",
        body: JSON.stringify({
          name: "org-skill",
          description: "This is a long enough description for the skill.",
          body: "This is a long enough body for the skill to pass the validation requirements.",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /:skillId", () => {
    it("deletes an org skill if org admin and not attached", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([]) // attachment guard: none
        .mockResolvedValueOnce([]); // blueprint guard: none
      mockDb.returning.mockResolvedValueOnce([{ id: "skill-1" }]);

      const res = await app.request(`${baseUrl}/skill-1`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Skill deleted" });
      // The dead skill id is scrubbed from referencing agents in the same tx.
      expect(mockDb.update).toHaveBeenCalled();
    });

    it("returns 409 when the skill is attached to a workspace", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([{ id: "att-1" }]); // attachment guard: attached

      const res = await app.request(`${baseUrl}/skill-1`, { method: "DELETE" });
      expect(res.status).toBe(409);
    });

    it("returns 409 when the skill is listed in a blueprint", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([]) // attachment guard: none
        .mockResolvedValueOnce([{ id: "bpi-1" }]); // blueprint guard: listed

      const res = await app.request(`${baseUrl}/skill-1`, { method: "DELETE" });
      expect(res.status).toBe(409);
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const res = await app.request(`${baseUrl}/skill-1`, { method: "DELETE" });
      expect(res.status).toBe(403);
    });
  });
});
