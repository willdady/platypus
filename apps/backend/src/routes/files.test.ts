import { Readable } from "node:stream";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockSession,
  mockNoSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
} from "../test-utils.ts";
import app from "../server.ts";
import { getStorage } from "../storage/index.ts";

vi.mock("../storage/index.ts", () => ({
  getStorage: vi.fn(),
}));

const mockStorageGet = vi.fn();
const mockStorageGetStream = vi.fn();
const mockStorage = {
  get: mockStorageGet,
  getStream: mockStorageGetStream,
  put: vi.fn(),
  delete: vi.fn(),
};

const streamed = (data: Buffer, contentType: string) => ({
  stream: Readable.from([data]),
  contentType,
  contentLength: data.length,
});

describe("Files Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    (getStorage as ReturnType<typeof vi.fn>).mockReturnValue(mockStorage);
    mockStorageGet.mockReset();
    mockStorageGetStream.mockReset();
  });

  const fileKey = "org-1/ws-1/chat-1/msg-1/0-abc12345.png";
  const baseUrl = `/files/${fileKey}`;

  const world = (
    options: {
      role?: "admin" | "member" | null;
      workspace?: Row | null;
    } = {},
  ): FakeDb => {
    const { role = "member", workspace } = options;
    return seedDb({
      organization_member: [
        ...(role === null
          ? []
          : [
              {
                id: "m1",
                userId: "user-1",
                organizationId: "org-1",
                role,
              },
            ]),
        {
          id: "m-other-org",
          userId: "user-1",
          organizationId: "org-2",
          role: "admin",
        },
      ],
      workspace:
        workspace === null
          ? []
          : [
              workspace ?? {
                id: "ws-1",
                organizationId: "org-1",
                ownerId: "user-1",
              },
            ],
    });
  };

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
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("File key required");
    });

    it.each([
      [
        "percent-encoded traversal",
        "/files/org-1/ws-1/..%2f..%2f..%2fetc%2fpasswd",
      ],
      ["percent-encoded dots", "/files/org-1/ws-1/%2e%2e%2fsecret"],
      ["backslash traversal", "/files/org-1/ws-1/..%5c..%5cwindows%5cwin.ini"],
      ["single-segment encoded traversal", "/files/..%2f..%2fetc%2fpasswd"],
    ])("should return 400 for a %s key", async (_label, url) => {
      mockSession();
      const res = await app.request(url);
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("Invalid file key");
      expect(mockStorageGetStream).not.toHaveBeenCalled();
    });

    it("should return 400 for invalid key format with less than 2 segments", async () => {
      mockSession();
      const res = await app.request("/files/just-one-segment");
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("Invalid file key format");
    });

    it("should bypass access checks and serve file for super admin", async () => {
      mockSession({ id: "user-1", email: "admin@example.com", role: "admin" });
      const fake = world();
      mockStorageGetStream.mockResolvedValue(
        streamed(Buffer.from("test image data"), "image/png"),
      );

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      expect(fake.queries).toEqual([]);
    });

    it.each(["org-1/skills/s-1/u-1/f-1", "org-1/SKILLS/s-1/u-1/f-1"])(
      "should refuse the Skill file %s even to a super admin",
      async (key) => {
        mockSession({
          id: "user-1",
          email: "admin@example.com",
          role: "admin",
        });

        const res = await app.request(`/files/${key}`);

        expect(res.status).toBe(403);
        expect(mockStorageGetStream).not.toHaveBeenCalled();
      },
    );

    it("should return 403 when user is not org member", async () => {
      mockSession();
      world({ role: null });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("Access denied");
    });

    it("should serve file when user is org admin", async () => {
      mockSession();
      world({ role: "admin" });
      mockStorageGetStream.mockResolvedValue(
        streamed(Buffer.from("test image data"), "image/png"),
      );

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
    });

    it("should return 404 when workspace not found for org member", async () => {
      mockSession();
      world({ workspace: null });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("Workspace not found");
    });

    it("should return 403 when member does not own workspace", async () => {
      mockSession({ id: "user-1", email: "test@example.com", role: "user" });
      world({
        workspace: {
          id: "ws-1",
          organizationId: "org-1",
          ownerId: "other-user",
        },
      });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("Access denied");
    });

    it("should serve file when member owns workspace", async () => {
      mockSession({ id: "user-1", email: "test@example.com", role: "user" });
      world();
      mockStorageGetStream.mockResolvedValue(
        streamed(Buffer.from("test image data"), "image/png"),
      );

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
    });

    it("should serve the body from getStream, never get", async () => {
      mockSession({ id: "user-1", email: "admin@example.com", role: "admin" });
      world();
      mockStorageGetStream.mockResolvedValue(
        streamed(Buffer.from("test image data"), "image/png"),
      );

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Length")).toBe("15");
      expect(await res.text()).toBe("test image data");
      expect(mockStorageGet).not.toHaveBeenCalled();
    });

    it("should return 404 when storage returns null", async () => {
      mockSession({ id: "user-1", email: "test@example.com", role: "user" });
      world();
      mockStorageGetStream.mockResolvedValue(null);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("File not found");
    });

    it("should return correct Content-Type header", async () => {
      mockSession({ id: "user-1", email: "test@example.com", role: "user" });
      world();
      mockStorageGetStream.mockResolvedValue(
        streamed(Buffer.from("test image data"), "image/png"),
      );

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
    });

    it("should return immutable Cache-Control header", async () => {
      mockSession({ id: "user-1", email: "test@example.com", role: "user" });
      world();
      mockStorageGetStream.mockResolvedValue(
        streamed(Buffer.from("test image data"), "image/png"),
      );

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe(
        "private, max-age=31536000, immutable",
      );
    });

    it("should tell the browser not to sniff a type from the bytes", async () => {
      mockSession({ id: "user-1", email: "test@example.com", role: "user" });
      world();
      mockStorageGetStream.mockResolvedValue(
        streamed(Buffer.from("test image data"), "image/png"),
      );

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });

    describe("protective headers", () => {
      const serve = async (key: string, contentType: string, body: string) => {
        mockSession({ id: "user-1", email: "test@example.com", role: "user" });
        world();
        mockStorageGetStream.mockResolvedValue(
          streamed(Buffer.from(body), contentType),
        );
        const res = await app.request(`/files/org-1/ws-1/chat-1/msg-1/${key}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
        return res;
      };

      it("should serve an SVG as a sandboxed download", async () => {
        const res = await serve(
          "0-abc12345.svg",
          "image/svg+xml",
          '<svg xmlns="http://www.w3.org/2000/svg"/>',
        );
        expect(res.headers.get("Content-Disposition")).toBe("attachment");
        expect(res.headers.get("Content-Security-Policy")).toBe(
          "sandbox; default-src 'none'",
        );
      });

      it("should sandbox an image without forcing a download", async () => {
        const res = await serve("0-abc12345.png", "image/png", "png bytes");
        expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
        expect(res.headers.get("Content-Disposition")).toBeNull();
      });

      it("should not sandbox a PDF", async () => {
        const res = await serve("0-abc12345.pdf", "application/pdf", "%PDF-");
        expect(res.headers.get("Content-Security-Policy")).toBeNull();
        expect(res.headers.get("Content-Disposition")).toBeNull();
      });
    });
  });
});
