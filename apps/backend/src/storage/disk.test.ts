import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DiskStorage } from "./disk.ts";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("DiskStorage", () => {
  let tempDir: string;
  let storage: DiskStorage;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "disk-storage-test-"));
    storage = new DiskStorage(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("put", () => {
    it("should store a file with metadata", async () => {
      const key = "org-1/ws-1/chat-1/msg-1/0-abc12345.png";
      const data = Buffer.from("test file content");
      const contentType = "image/png";

      await storage.put(key, data, contentType);

      // Verify file exists
      const filePath = path.join(tempDir, key);
      const metaPath = `${filePath}.meta`;

      const fileContent = await fs.readFile(filePath);
      expect(fileContent.toString()).toBe("test file content");

      const metaContent = await fs.readFile(metaPath, "utf-8");
      const meta = JSON.parse(metaContent);
      expect(meta.contentType).toBe("image/png");
    });

    it("should create nested directories", async () => {
      const key = "deeply/nested/path/file.txt";
      const data = Buffer.from("nested content");

      await storage.put(key, data, "text/plain");

      const filePath = path.join(tempDir, key);
      const fileContent = await fs.readFile(filePath);
      expect(fileContent.toString()).toBe("nested content");
    });
  });

  describe("get", () => {
    it("should retrieve a stored file", async () => {
      const key = "test-file.bin";
      const data = Buffer.from([0, 1, 2, 3, 4, 5]);
      const contentType = "application/octet-stream";

      await storage.put(key, data, contentType);
      const result = await storage.get(key);

      expect(result).not.toBeNull();
      expect(result!.data).toEqual(data);
      expect(result!.contentType).toBe(contentType);
    });

    it("should return null for non-existent file", async () => {
      const result = await storage.get("non-existent-file");
      expect(result).toBeNull();
    });

    it("should handle binary content correctly", async () => {
      const key = "binary.bin";
      // Create a buffer with all byte values
      const data = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) {
        data[i] = i;
      }

      await storage.put(key, data, "application/octet-stream");
      const result = await storage.get(key);

      expect(result!.data).toEqual(data);
    });
  });

  describe("delete", () => {
    it("should delete a stored file and its metadata", async () => {
      const key = "to-delete.txt";
      const data = Buffer.from("delete me");

      await storage.put(key, data, "text/plain");
      await storage.delete(key);

      const result = await storage.get(key);
      expect(result).toBeNull();
    });

    it("should not throw for non-existent file", async () => {
      // Should not throw
      await expect(storage.delete("non-existent")).resolves.not.toThrow();
    });
  });

  describe("integration", () => {
    it("should support full CRUD cycle", async () => {
      const key = "crud-test/file.txt";
      const data1 = Buffer.from("initial content");
      const data2 = Buffer.from("updated content");

      // Create
      await storage.put(key, data1, "text/plain");
      let result = await storage.get(key);
      expect(result!.data.toString()).toBe("initial content");

      // Update (put overwrites)
      await storage.put(key, data2, "text/plain");
      result = await storage.get(key);
      expect(result!.data.toString()).toBe("updated content");

      // Delete
      await storage.delete(key);
      result = await storage.get(key);
      expect(result).toBeNull();
    });
  });
});
