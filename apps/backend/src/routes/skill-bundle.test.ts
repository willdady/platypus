import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockSession, resetMockDb, seedDb } from "../test-utils.ts";
import app from "../server.ts";
import { getStorage } from "../storage/index.ts";

vi.mock("../storage/index.ts", () => ({ getStorage: vi.fn() }));

/**
 * The HTTP edges of Skill bundles (ADR-0036): the zip upload limit, how a
 * bundled file is sent, and that `/files/*` never serves one.
 */
const storageGet = vi.fn();
const storagePut = vi.fn();

const orgId = "org-1";
const workspaceId = "ws-1";
const skillKey = `${orgId}/skills/skill-1/upload-1/file-1`;

beforeEach(() => {
  resetMockDb();
  vi.clearAllMocks();
  vi.mocked(getStorage).mockReturnValue({
    get: storageGet,
    put: storagePut,
    delete: vi.fn(),
    deletePrefix: vi.fn(),
  });
  seedDb({
    organization_member: [
      { id: "m1", userId: "user-1", organizationId: orgId, role: "admin" },
    ],
    workspace: [{ id: workspaceId, organizationId: orgId, ownerId: "user-1" }],
    skill: [
      {
        id: "skill-1",
        workspaceId,
        organizationId: null,
        name: "web",
        description: "d",
        body: "b",
        disableModelInvocation: false,
        argumentHint: null,
        frontmatter: {},
      },
    ],
    skill_file: [
      {
        id: "file-1",
        skillId: "skill-1",
        path: "pages/index.html",
        size: 20,
        sha256: "x",
        isText: true,
        storageKey: skillKey,
      },
    ],
  });
});

const skillsUrl = `/organizations/${orgId}/workspaces/${workspaceId}/skills`;

describe("Skill file download", () => {
  it("sends a bundled .html file as an octet-stream attachment", async () => {
    mockSession();
    storageGet.mockResolvedValueOnce({
      data: Buffer.from("<script>alert(1)</script>"),
      contentType: "application/octet-stream",
    });

    const res = await app.request(`${skillsUrl}/skill-1/files/file-1`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''index.html",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(storageGet).toHaveBeenCalledWith(skillKey);
  });

  it("does not serve another Skill's file id", async () => {
    mockSession();
    const res = await app.request(`${skillsUrl}/skill-1/files/other`);
    expect(res.status).toBe(404);
    expect(storageGet).not.toHaveBeenCalled();
  });
});

describe("GET /files/*", () => {
  it.each([
    ["an Org Admin", { id: "user-1", email: "a@example.com" }],
    ["a super admin", { id: "user-1", email: "a@example.com", role: "admin" }],
  ])("refuses a Skill key for %s", async (_label, user) => {
    mockSession(user);
    const res = await app.request(`/files/${skillKey}`);
    expect(res.status).toBe(403);
    expect(storageGet).not.toHaveBeenCalled();
  });

  // The disk backend can be case-insensitive, so `SKILLS` reaches the same file.
  it("refuses a Skill key whatever its case", async () => {
    mockSession({ id: "user-1", email: "a@example.com", role: "admin" });
    const res = await app.request(
      `/files/${skillKey.replace("skills", "SKILLS")}`,
    );
    expect(res.status).toBe(403);
    expect(storageGet).not.toHaveBeenCalled();
  });
});

describe("POST /skills/import", () => {
  it("rejects a zip over 10 MiB with a 400 naming the limit", async () => {
    mockSession();
    const res = await app.request(`${skillsUrl}/import`, {
      method: "POST",
      body: new Uint8Array(10 * 1024 * 1024 + 1),
      headers: { "Content-Type": "application/zip" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Zip is larger than 10 MiB",
    });
    expect(storagePut).not.toHaveBeenCalled();
  });

  it("rejects an invalid zip with a 400 naming the rule", async () => {
    mockSession();
    const res = await app.request(`${skillsUrl}/import`, {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
      headers: { "Content-Type": "application/zip" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "File is not a valid zip archive",
    });
    expect(storagePut).not.toHaveBeenCalled();
  });
});
