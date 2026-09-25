import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DiskStorage } from "./disk.ts";
import { ValidationError } from "../errors.ts";
import { mockLogger } from "../test-setup.ts";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("DiskStorage", () => {
  let tempDir: string;
  let storage: DiskStorage;

  const exists = (key: string) =>
    fs.access(path.join(tempDir, key)).then(
      () => true,
      () => false,
    );

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "disk-storage-test-"));
    storage = new DiskStorage(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("put", () => {
    it("writes the object and a content-type sidecar, creating nested directories", async () => {
      const key = "org-1/ws-1/chat-1/msg-1/0-abc12345.png";

      await storage.put(key, Buffer.from("test file content"), "image/png");

      const filePath = path.join(tempDir, key);
      expect((await fs.readFile(filePath)).toString()).toBe(
        "test file content",
      );
      expect(
        JSON.parse(await fs.readFile(`${filePath}.meta`, "utf-8")),
      ).toEqual({ contentType: "image/png" });
    });

    it("overwrites an existing object", async () => {
      await storage.put("k.txt", Buffer.from("initial"), "text/plain");
      await storage.put("k.txt", Buffer.from("updated"), "text/markdown");

      const result = await storage.get("k.txt");
      expect(result!.data.toString()).toBe("updated");
      expect(result!.contentType).toBe("text/markdown");
    });
  });

  describe("get", () => {
    it("round-trips every byte value and the content type", async () => {
      const data = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

      await storage.put("binary.bin", data, "application/octet-stream");

      expect(await storage.get("binary.bin")).toEqual({
        data,
        contentType: "application/octet-stream",
      });
    });

    it("returns null for a missing object", async () => {
      expect(await storage.get("non-existent-file")).toBeNull();
    });

    it("rethrows a read failure other than a missing file", async () => {
      await storage.put("dir/file.txt", Buffer.from("x"), "text/plain");
      await fs.writeFile(path.join(tempDir, "dir.meta"), "{}");

      // `dir` is a directory, so reading it fails with EISDIR, not ENOENT.
      await expect(storage.get("dir")).rejects.toMatchObject({
        code: "EISDIR",
      });
    });
  });

  describe("delete", () => {
    it("removes the object and its sidecar", async () => {
      await storage.put(
        "to-delete.txt",
        Buffer.from("delete me"),
        "text/plain",
      );

      await storage.delete("to-delete.txt");

      expect(await exists("to-delete.txt")).toBe(false);
      expect(await exists("to-delete.txt.meta")).toBe(false);
    });

    it("resolves quietly for a missing object", async () => {
      await expect(storage.delete("non-existent")).resolves.toBeUndefined();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("logs, rather than throws, an unlink failure other than a missing file", async () => {
      // Both paths are directories, so each unlink fails with something other
      // than ENOENT.
      await fs.mkdir(path.join(tempDir, "k"));
      await fs.mkdir(path.join(tempDir, "k.meta"));

      await expect(storage.delete("k")).resolves.toBeUndefined();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ key: "k" }),
        "Error deleting file from disk",
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ key: "k" }),
        "Error deleting meta file from disk",
      );
    });
  });

  // The Agent avatar path composes its own key without the `keys.ts` gate, so
  // this is the only containment guard on the disk backend.
  describe("containment", () => {
    const escapes = () => [
      "../outside.txt",
      "a/../../outside.txt",
      path.join("..", `${path.basename(tempDir)}_secret`, "x.txt"),
      path.join(os.tmpdir(), "absolute.txt"),
      "a/..",
      "",
    ];

    it("refuses every operation on a key that resolves outside the root", async () => {
      for (const key of escapes()) {
        await expect(
          storage.put(key, Buffer.from("x"), "text/plain"),
        ).rejects.toThrow(ValidationError);
        await expect(storage.get(key)).rejects.toThrow(ValidationError);
        await expect(storage.delete(key)).rejects.toThrow(ValidationError);
      }
      expect(await fs.readdir(tempDir)).toEqual([]);
    });
  });

  describe("deletePrefix", () => {
    it("removes every object and sidecar under the prefix and nothing beside it", async () => {
      const inside = ["o/w/c1/m1/0-a.png", "o/w/c2/m1/0-b.png"];
      const outside = ["o/w2/c1/m1/0-c.png", "o/w-other/c1/m1/0-d.png"];
      for (const key of [...inside, ...outside]) {
        await storage.put(key, Buffer.from(key), "image/png");
      }

      await storage.deletePrefix("o/w/");

      for (const key of inside) {
        expect(await exists(key)).toBe(false);
        expect(await exists(`${key}.meta`)).toBe(false);
      }
      expect(await exists("o/w")).toBe(false);
      for (const key of outside) {
        expect(await exists(key)).toBe(true);
        expect(await exists(`${key}.meta`)).toBe(true);
      }
    });

    it("succeeds when the prefix directory does not exist", async () => {
      await expect(storage.deletePrefix("o/missing/")).resolves.toBeUndefined();
    });

    it.each(["", "/", "o/w", "o/../x/"])(
      "rejects %j without touching the filesystem",
      async (prefix) => {
        await storage.put("o/w/c/m/0-a.png", Buffer.from("x"), "image/png");

        await expect(storage.deletePrefix(prefix)).rejects.toThrow(
          ValidationError,
        );
        expect(await exists("o/w/c/m/0-a.png")).toBe(true);
      },
    );
  });
});
