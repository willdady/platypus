import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  mockNoSession,
  resetMockDb,
} from "../test-utils.ts";
import app from "../server.ts";

describe("Skill Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/skills`;

  describe("POST /", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "new-skill",
          description: "This is a long enough description for the skill.",
          body: "This is a long enough body for the skill to pass the validation requirements.",
          workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });

    it("should return 403 if user is not workspace owner", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess: workspace owned by someone else
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "other-user" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "new-skill",
          description: "This is a long enough description for the skill.",
          body: "This is a long enough body for the skill to pass the validation requirements.",
          workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
    });

    it("should create skill if user is editor", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

      const mockSkill = {
        id: "skill-1",
        name: "new-skill",
        description: "This is a long enough description for the skill.",
        body: "This is a long enough body for the skill to pass the validation requirements.",
        workspaceId,
      };
      mockDb.returning.mockResolvedValueOnce([mockSkill]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "new-skill",
          description: "This is a long enough description for the skill.",
          body: "This is a long enough body for the skill to pass the validation requirements.",
          workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockSkill);
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("should return 400 if name is not kebab-case", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "Invalid Name",
          body: "This is a long enough body for the skill to pass the validation requirements.",
          workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /", () => {
    it("should list workspace and attached org skills tagged with scope", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

      const workspaceSkills = [{ id: "skill-1", name: "skill-1" }];
      // The attached org-scoped Skills come back from an inner join, shaped
      // { skill: {...} }.
      const attachedOrgRows = [
        { skill: { id: "org-skill-1", name: "org-skill-1" } },
      ];
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // requireWorkspaceAccess
        .mockResolvedValueOnce(workspaceSkills) // workspace-scoped query
        .mockResolvedValueOnce(attachedOrgRows); // attached org-scoped query

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        results: [
          { id: "org-skill-1", name: "org-skill-1", scope: "organization" },
          { id: "skill-1", name: "skill-1", scope: "workspace" },
        ],
      });
    });
  });

  describe("POST /:skillId/promote", () => {
    const promoteUrl = `${baseUrl}/skill-1/promote`;

    it("returns 403 if not org admin", async () => {
      mockSession();
      // requireOrgAccess(["admin"]) → member rejected
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await app.request(promoteUrl, { method: "POST" });
      expect(res.status).toBe(403);
    });

    it("returns 404 if the workspace skill does not exist", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // skill lookup → not found

      const res = await app.request(promoteUrl, { method: "POST" });
      expect(res.status).toBe(404);
    });

    it("re-scopes the skill to org and auto-attaches the origin workspace", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([
        { id: "skill-1", workspaceId, name: "my-skill" },
      ]); // skill lookup
      // transaction: update ... returning, then insert attachment
      mockDb.returning.mockResolvedValueOnce([
        { id: "skill-1", organizationId: orgId, workspaceId: null },
      ]);

      const res = await app.request(promoteUrl, { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: "skill-1",
        organizationId: orgId,
        workspaceId: null,
        scope: "organization",
      });
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.onConflictDoNothing).toHaveBeenCalled();
    });

    it("returns 404 (no orphan attachment) when a concurrent promote already re-scoped the skill", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([
        { id: "skill-1", workspaceId, name: "my-skill" },
      ]); // skill lookup (pre-transaction)
      // Transaction update matches no row (skill already re-scoped) → rollback
      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(promoteUrl, { method: "POST" });
      expect(res.status).toBe(404);
      // The auto-attach insert must never run when the update found nothing.
      expect(mockDb.onConflictDoNothing).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /:skillId", () => {
    it("should return 409 if skill is referenced by an agent", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      // check referencing agents
      mockDb.limit.mockResolvedValueOnce([{ id: "agent-1" }]);

      const res = await app.request(`${baseUrl}/skill-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error:
          "Cannot delete skill because it is referenced by one or more agents",
      });
    });

    it("should delete skill if not referenced", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      // check referencing agents (none)
      mockDb.limit.mockResolvedValueOnce([]);
      // delete skill
      mockDb.returning.mockResolvedValueOnce([{ id: "skill-1" }]);

      const res = await app.request(`${baseUrl}/skill-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Skill deleted" });
    });
  });
});
