import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  extractFiles,
  rewriteStorageUrls,
  extractStorageKeys,
  deleteFiles,
  STORAGE_URL_PREFIX,
} from "./utils.ts";
import type { PlatypusUIMessage } from "../types.ts";
import { resetStorage } from "./index.ts";
import { DiskStorage } from "./disk.ts";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Helper to create a test message with a file part
function createMessageWithFile(
  messageId: string,
  dataUrl: string,
): PlatypusUIMessage {
  return {
    id: messageId,
    role: "user",
    parts: [
      { type: "text", text: "Here's an image:" },
      { type: "file", url: dataUrl, mimeType: "image/png" },
    ],
  };
}

// Helper to create a small PNG data URL (1x1 red pixel)
function createPngDataUrl(): string {
  // 1x1 red PNG (base64 encoded)
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  return `data:image/png;base64,${base64}`;
}

describe("Storage Utils", () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create a temp directory for disk storage
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-test-"));
    // Set env var for disk storage path
    process.env.STORAGE_DISK_PATH = tempDir;
    process.env.STORAGE_BACKEND = "disk";
    // Reset the singleton
    resetStorage();
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
    delete process.env.STORAGE_DISK_PATH;
    delete process.env.STORAGE_BACKEND;
    resetStorage();
  });

  describe("extractFiles", () => {
    it("should extract data URLs and replace with storage URLs", async () => {
      const dataUrl = createPngDataUrl();
      const messages: PlatypusUIMessage[] = [
        createMessageWithFile("msg-1", dataUrl),
      ];

      const context = {
        orgId: "org-1",
        workspaceId: "ws-1",
        chatId: "chat-1",
      };

      const result = await extractFiles(messages, context);

      expect(result).toHaveLength(1);
      expect(result[0].parts).toHaveLength(2);
      expect(result[0].parts[0].type).toBe("text");

      const filePart = result[0].parts[1];
      expect(filePart.type).toBe("file");
      expect((filePart as any).url).toMatch(/^storage:\/\//);

      // Verify the key format
      const key = (filePart as any).url.slice(STORAGE_URL_PREFIX.length);
      expect(key).toMatch(/^org-1\/ws-1\/chat-1\/msg-1\/1-[a-f0-9]{8}\.png$/);
    });

    it("should leave non-data URLs unchanged", async () => {
      const httpUrl = "https://example.com/image.png";
      const messages: PlatypusUIMessage[] = [
        createMessageWithFile("msg-1", httpUrl),
      ];

      const context = {
        orgId: "org-1",
        workspaceId: "ws-1",
        chatId: "chat-1",
      };

      const result = await extractFiles(messages, context);

      const filePart = result[0].parts[1];
      expect((filePart as any).url).toBe(httpUrl);
    });

    it("should handle messages without parts", async () => {
      const messages: PlatypusUIMessage[] = [
        { id: "msg-1", role: "user", parts: [] },
      ];

      const context = {
        orgId: "org-1",
        workspaceId: "ws-1",
        chatId: "chat-1",
      };

      const result = await extractFiles(messages, context);
      expect(result).toHaveLength(1);
      expect(result[0].parts).toHaveLength(0);
    });

    it("should store files on disk", async () => {
      const dataUrl = createPngDataUrl();
      const messages: PlatypusUIMessage[] = [
        createMessageWithFile("msg-1", dataUrl),
      ];

      const context = {
        orgId: "org-1",
        workspaceId: "ws-1",
        chatId: "chat-1",
      };

      await extractFiles(messages, context);

      // Check that files were created in temp dir
      const files = await fs.readdir(tempDir, { recursive: true });
      expect(files.length).toBeGreaterThan(0);

      // Should have both .png and .meta files
      const allFiles = files.flat();
      const pngFiles = allFiles.filter((f) => String(f).endsWith(".png"));
      const metaFiles = allFiles.filter((f) => String(f).endsWith(".meta"));
      expect(pngFiles.length).toBe(1);
      expect(metaFiles.length).toBe(1);
    });
  });

  describe("rewriteStorageUrls", () => {
    it("should rewrite storage URLs to HTTP URLs", () => {
      const storageUrl = "storage://org-1/ws-1/chat-1/msg-1/1-abc12345.png";
      const messages: PlatypusUIMessage[] = [
        {
          id: "msg-1",
          role: "assistant",
          parts: [{ type: "file", url: storageUrl, mimeType: "image/png" }],
        },
      ];

      const result = rewriteStorageUrls(messages, "http://localhost:4000");

      const filePart = result[0].parts[0];
      expect((filePart as any).url).toBe(
        "http://localhost:4000/files/org-1/ws-1/chat-1/msg-1/1-abc12345.png",
      );
    });

    it("should use STORAGE_PUBLIC_URL when set", () => {
      process.env.STORAGE_PUBLIC_URL = "https://my-bucket.s3.amazonaws.com";

      const storageUrl = "storage://org-1/ws-1/chat-1/msg-1/1-abc12345.png";
      const messages: PlatypusUIMessage[] = [
        {
          id: "msg-1",
          role: "assistant",
          parts: [{ type: "file", url: storageUrl, mimeType: "image/png" }],
        },
      ];

      const result = rewriteStorageUrls(messages, "http://localhost:4000");

      const filePart = result[0].parts[0];
      expect((filePart as any).url).toBe(
        "https://my-bucket.s3.amazonaws.com/org-1/ws-1/chat-1/msg-1/1-abc12345.png",
      );

      delete process.env.STORAGE_PUBLIC_URL;
    });

    it("should leave non-storage URLs unchanged", () => {
      const httpUrl = "https://example.com/image.png";
      const messages: PlatypusUIMessage[] = [
        {
          id: "msg-1",
          role: "assistant",
          parts: [{ type: "file", url: httpUrl, mimeType: "image/png" }],
        },
      ];

      const result = rewriteStorageUrls(messages, "http://localhost:4000");

      const filePart = result[0].parts[0];
      expect((filePart as any).url).toBe(httpUrl);
    });
  });

  describe("extractStorageKeys", () => {
    it("should extract all storage keys from messages", () => {
      const messages: PlatypusUIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [
            {
              type: "file",
              url: "storage://org-1/ws-1/chat-1/msg-1/1-abc12345.png",
              mimeType: "image/png",
            },
          ],
        },
        {
          id: "msg-2",
          role: "user",
          parts: [
            {
              type: "file",
              url: "storage://org-1/ws-1/chat-1/msg-2/0-def67890.jpg",
              mimeType: "image/jpeg",
            },
          ],
        },
      ];

      const keys = extractStorageKeys(messages);

      expect(keys).toHaveLength(2);
      expect(keys).toContain("org-1/ws-1/chat-1/msg-1/1-abc12345.png");
      expect(keys).toContain("org-1/ws-1/chat-1/msg-2/0-def67890.jpg");
    });

    it("should return empty array for messages without storage URLs", () => {
      const messages: PlatypusUIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }],
        },
      ];

      const keys = extractStorageKeys(messages);
      expect(keys).toHaveLength(0);
    });
  });

  describe("deleteFiles", () => {
    it("should delete files from storage", async () => {
      // First store a file
      const dataUrl = createPngDataUrl();
      const messages: PlatypusUIMessage[] = [
        createMessageWithFile("msg-1", dataUrl),
      ];

      const context = {
        orgId: "org-1",
        workspaceId: "ws-1",
        chatId: "chat-1",
      };

      const storedMessages = await extractFiles(messages, context);

      // Verify file exists
      const filesBeforeDelete = await fs.readdir(tempDir, { recursive: true });
      const allFilesBefore = filesBeforeDelete.flat();
      const pngFilesBefore = allFilesBefore.filter((f) =>
        String(f).endsWith(".png"),
      );
      const metaFilesBefore = allFilesBefore.filter((f) =>
        String(f).endsWith(".meta"),
      );
      expect(pngFilesBefore.length).toBe(1);
      expect(metaFilesBefore.length).toBe(1);

      // Delete files
      await deleteFiles(storedMessages);

      // Verify files are deleted (directories may remain)
      const filesAfterDelete = await fs.readdir(tempDir, { recursive: true });
      const allFilesAfter = filesAfterDelete.flat();
      const pngFilesAfter = allFilesAfter.filter((f) =>
        String(f).endsWith(".png"),
      );
      const metaFilesAfter = allFilesAfter.filter((f) =>
        String(f).endsWith(".meta"),
      );
      expect(pngFilesAfter.length).toBe(0);
      expect(metaFilesAfter.length).toBe(0);
    });

    it("should handle messages without storage URLs", async () => {
      const messages: PlatypusUIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }],
        },
      ];

      // Should not throw
      await expect(deleteFiles(messages)).resolves.not.toThrow();
    });
  });
});
