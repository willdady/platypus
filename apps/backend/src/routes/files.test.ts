import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  mockNoSession,
  resetMockDb,
} from "../test-utils.ts";
import app from "../server.ts";
import { getStorage } from "../storage/index.ts";

vi.mock("../storage/index.ts", () => ({
  getStorage: vi.fn(),
}));

const mockStorageGet = vi.fn();
const mockStorage = {
  get: mockStorageGet,
  put: vi.fn(),
  delete: vi.fn(),
};

describe("Files Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    (getStorage as ReturnType<typeof vi.fn>).mockReturnValue(mockStorage);
    mockStorageGet.mockReset();
  });

  const fileKey = "org-1/ws-1/chat-1/msg-1/0-abc12345.png";
  const baseUrl = `/files/${fileKey}`;

  describe("GET /files/*", () => {
    it("should return 401 when not authenticated", async () => {
      mockNoSession();
      const res = await app.request(baseUrl);
      expect(res.status).toBe(401);
    });

    it("should return 400 when key is empty", async () => {
      mockSession();
      const res = await app.request("/files/");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("File key required");
    });

    it("should return 400 for invalid key format with less than 2 segments", async () => {
      mockSession();
      const res = await app.request("/files/just-one-segment");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid file key format");
    });

    it("should bypass access checks and serve file for super admin", async () => {
      mockSession({ id: "user-1", email: "admin@example.com", role: "admin" });
      mockStorageGet.mockResolvedValueOnce({
        data: Buffer.from("test image data"),
        contentType: "image/png",
      });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      // Super admin should not query DB for membership
      expect(mockDb.limit).not.toHaveBeenCalled();
    });

    it("should return 403 when user is not org member", async () => {
      mockSession();
      // Membership check returns empty array
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Access denied");
    });

    it("should serve file when user is org admin", async () => {
      mockSession();
      // Membership check returns org admin role
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockStorageGet.mockResolvedValueOnce({
        data: Buffer.from("test image data"),
        contentType: "image/png",
      });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
    });

    it("should return 404 when workspace not found for org member", async () => {
      mockSession();
      // Membership check returns member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // Workspace lookup returns empty array
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Workspace not found");
    });

    it("should return 403 when member does not own workspace", async () => {
      mockSession({ id: "user-1", email: "test@example.com", role: "user" });
      // Membership check returns member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // Workspace lookup returns workspace owned by different user
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "other-user" }]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Access denied");
    });

    it("should serve file when member owns workspace", async () => {
      mockSession({ id: "user-1", email: "test@example.com", role: "user" });
      // Membership check returns member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // Workspace lookup returns workspace owned by user-1
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      mockStorageGet.mockResolvedValueOnce({
        data: Buffer.from("test image data"),
        contentType: "image/png",
      });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
    });

    it("should return 404 when storage returns null", async () => {
      mockSession({ id: "user-1", email: "test@example.com", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      mockStorageGet.mockResolvedValueOnce(null);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("File not found");
    });

    it("should return correct Content-Type header", async () => {
      mockSession({ id: "user-1", email: "test@example.com", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      mockStorageGet.mockResolvedValueOnce({
        data: Buffer.from("test image data"),
        contentType: "image/png",
      });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
    });

    it("should return immutable Cache-Control header", async () => {
      mockSession({ id: "user-1", email: "test@example.com", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      mockStorageGet.mockResolvedValueOnce({
        data: Buffer.from("test image data"),
        contentType: "image/png",
      });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe(
        "private, max-age=31536000, immutable",
      );
    });
  });
});
