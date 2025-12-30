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
          body: "Skill body",
          workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });

    it("should return 403 if user is viewer", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "viewer" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "new-skill",
          description: "This is a long enough description for the skill.",
          body: "Skill body",
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
      mockDb.limit.mockResolvedValueOnce([{ role: "editor" }]);

      const mockSkill = {
        id: "skill-1",
        name: "new-skill",
        description: "This is a long enough description for the skill.",
        body: "Skill body",
        workspaceId,
      };
      mockDb.returning.mockResolvedValueOnce([mockSkill]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "new-skill",
          description: "This is a long enough description for the skill.",
          body: "Skill body",
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
      mockDb.limit.mockResolvedValueOnce([{ role: "editor" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "Invalid Name",
          body: "Skill body",
          workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /", () => {
    it("should list all skills in workspace", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "viewer" }]);

      const mockSkills = [{ id: "skill-1", name: "skill-1" }];
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce(mockSkills);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockSkills });
    });
  });

  describe("DELETE /:skillId", () => {
    it("should return 409 if skill is referenced by an agent", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "editor" }]);
      // check referencing agents
      mockDb.limit.mockResolvedValueOnce([{ id: "agent-1" }]);

      const res = await app.request(`${baseUrl}/skill-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        message:
          "Cannot delete skill because it is referenced by one or more agents",
      });
    });

    it("should delete skill if not referenced", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "editor" }]);
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
