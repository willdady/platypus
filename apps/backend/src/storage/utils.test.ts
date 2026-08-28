import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  extractFiles,
  rewriteStorageUrls,
  extractStorageKeys,
  deleteFiles,
  inlineFileUrls,
  STORAGE_URL_PREFIX,
} from "./utils.ts";
import type { PlatypusUIMessage } from "../types.ts";
import type { FileUIPart } from "ai";
import { resetStorage } from "./index.ts";
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
      { type: "file", url: dataUrl, mediaType: "image/png" },
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

// Count stored object files (excluding .meta sidecars) under the given root.
async function countPngFiles(root: string): Promise<number> {
  const files = await fs.readdir(root, { recursive: true });
  const all = files.flat();
  return all.filter((f) => String(f).endsWith(".png")).length;
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
      expect((filePart as FileUIPart).url).toMatch(/^storage:\/\//);

      // Verify the key format
      const key = (filePart as FileUIPart).url.slice(STORAGE_URL_PREFIX.length);
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
      expect((filePart as FileUIPart).url).toBe(httpUrl);
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
          parts: [{ type: "file", url: storageUrl, mediaType: "image/png" }],
        },
      ];

      const result = rewriteStorageUrls(messages, "http://localhost:4000");

      const filePart = result[0].parts[0];
      expect((filePart as FileUIPart).url).toBe(
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
          parts: [{ type: "file", url: storageUrl, mediaType: "image/png" }],
        },
      ];

      const result = rewriteStorageUrls(messages, "http://localhost:4000");

      const filePart = result[0].parts[0];
      expect((filePart as FileUIPart).url).toBe(
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
          parts: [{ type: "file", url: httpUrl, mediaType: "image/png" }],
        },
      ];

      const result = rewriteStorageUrls(messages, "http://localhost:4000");

      const filePart = result[0].parts[0];
      expect((filePart as FileUIPart).url).toBe(httpUrl);
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
              mediaType: "image/png",
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
              mediaType: "image/jpeg",
            },
          ],
        },
      ];

      const keys = extractStorageKeys(messages);

      expect(keys).toHaveLength(2);
      expect(keys).toContain("org-1/ws-1/chat-1/msg-1/1-abc12345.png");
      expect(keys).toContain("org-1/ws-1/chat-1/msg-2/0-def67890.jpg");
    });

    // The point of this test (issue #715): a test using only `storage://`
    // fixtures would pass even while HTTP-form URLs — what the client actually
    // returns on the second and later turns — leak on deletion.
    it("should extract keys from HTTP-form URLs returned on later turns", () => {
      const messages: PlatypusUIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [
            {
              type: "file",
              url: "http://localhost:4000/files/org-1/ws-1/chat-1/msg-1/1-abc12345.png",
              mediaType: "image/png",
            },
          ],
        },
        {
          id: "msg-2",
          role: "user",
          parts: [
            {
              type: "file",
              url: "https://example.com/some/path/files/org-1/ws-1/chat-1/msg-2/0-def67890.jpg",
              mediaType: "image/jpeg",
            },
          ],
        },
      ];

      const keys = extractStorageKeys(messages);

      expect(keys).toHaveLength(2);
      expect(keys).toContain("org-1/ws-1/chat-1/msg-1/1-abc12345.png");
      expect(keys).toContain("org-1/ws-1/chat-1/msg-2/0-def67890.jpg");
    });

    it("should extract keys from STORAGE_PUBLIC_URL URLs", () => {
      process.env.STORAGE_PUBLIC_URL = "https://my-bucket.s3.amazonaws.com";

      const messages: PlatypusUIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [
            {
              type: "file",
              url: "https://my-bucket.s3.amazonaws.com/org-1/ws-1/chat-1/msg-1/0-abc12345.png",
              mediaType: "image/png",
            },
          ],
        },
      ];

      const keys = extractStorageKeys(messages);

      expect(keys).toContain("org-1/ws-1/chat-1/msg-1/0-abc12345.png");

      delete process.env.STORAGE_PUBLIC_URL;
    });

    it("should extract a mix of storage and HTTP forms from the same chat", () => {
      const messages: PlatypusUIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [
            {
              type: "file",
              url: "storage://org-1/ws-1/chat-1/msg-1/0-abc12345.png",
              mediaType: "image/png",
            },
          ],
        },
        {
          id: "msg-2",
          role: "user",
          parts: [
            {
              type: "file",
              url: "http://localhost:4000/files/org-1/ws-1/chat-1/msg-2/1-def67890.jpg",
              mediaType: "image/jpeg",
            },
          ],
        },
      ];

      const keys = extractStorageKeys(messages);

      expect(keys).toHaveLength(2);
      expect(keys).toContain("org-1/ws-1/chat-1/msg-1/0-abc12345.png");
      expect(keys).toContain("org-1/ws-1/chat-1/msg-2/1-def67890.jpg");
    });

    it("should ignore data URLs and external URLs", () => {
      const messages: PlatypusUIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [
            {
              type: "file",
              url: createPngDataUrl(),
              mediaType: "image/png",
            },
            {
              type: "file",
              url: "https://example.com/image.png",
              mediaType: "image/png",
            },
            { type: "text", text: "Hello" },
          ],
        },
      ];

      const keys = extractStorageKeys(messages);
      expect(keys).toHaveLength(0);
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
      await deleteFiles(storedMessages, context);

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
      await expect(
        deleteFiles(messages, {
          orgId: "org-1",
          workspaceId: "ws-1",
          chatId: "chat-1",
        }),
      ).resolves.not.toThrow();
    });

    // Issue #715: a file attached on the second turn onward is stored in the
    // row as the HTTP form the client returned. Deleting the chat must still
    // remove it from object storage. This exercises the full store → HTTP
    // rewrite → delete cycle, so a regression to `extractStorageKeys` (failing
    // to recognise the HTTP form) leaves a real file on disk.
    it("should delete files whose stored URL is the HTTP form", async () => {
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

      // Simulate the second-turn read → write cycle: the client fetches the
      // chat (storage:// → HTTP), then resubmits it on the next turn.
      const httpMessages = rewriteStorageUrls(
        storedMessages,
        "http://localhost:4000",
      );

      const pngBefore = await countPngFiles(tempDir);
      expect(pngBefore).toBe(1);

      await deleteFiles(httpMessages, context);

      expect(await countPngFiles(tempDir)).toBe(0);
    });

    // A client can put any URL on a file part, and `extractFiles` stores a
    // non-`data:` URL verbatim. Without an ownership filter, planting another
    // tenant's key in a Chat you own and deleting that Chat destroys their
    // file — and reading any Chat reveals such a key, because
    // `rewriteStorageUrls` puts it in the URL it hands every reader.
    it("does not delete a file belonging to another Chat", async () => {
      const victim = {
        orgId: "org-victim",
        workspaceId: "ws-victim",
        chatId: "chat-victim",
      };
      const attacker = {
        orgId: "org-attacker",
        workspaceId: "ws-attacker",
        chatId: "chat-attacker",
      };

      // The victim's file, stored the ordinary way.
      const victimMessages = await extractFiles(
        [createMessageWithFile("msg-victim", createPngDataUrl())],
        victim,
      );
      const victimKey = extractStorageKeys(victimMessages)[0];
      expect(victimKey).toBeDefined();
      expect(await countPngFiles(tempDir)).toBe(1);

      // The attacker's own Chat, carrying a part that points at the victim's
      // key in both reachable forms.
      const plantedMessages: PlatypusUIMessage[] = [
        createMessageWithFile("msg-1", `storage://${victimKey}`),
        createMessageWithFile(
          "msg-2",
          `https://attacker.example.com/files/${victimKey}`,
        ),
      ];

      await deleteFiles(plantedMessages, attacker);

      expect(await countPngFiles(tempDir)).toBe(1);
    });
  });

  describe("inlineFileUrls", () => {
    const backendOrigin = "http://localhost:4000";

    it("should inline storage:// URLs as data URLs", async () => {
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

      // Now inline the storage:// URLs back to data URLs
      const inlined = await inlineFileUrls(storedMessages, backendOrigin);

      const filePart = inlined[0].parts[1];
      expect((filePart as FileUIPart).url).toMatch(/^data:image\/png;base64,/);
    });

    it("should inline /files/ HTTP URLs as data URLs", async () => {
      // Store a file first
      const dataUrl = createPngDataUrl();
      const storeMessages: PlatypusUIMessage[] = [
        createMessageWithFile("msg-1", dataUrl),
      ];

      const context = {
        orgId: "org-1",
        workspaceId: "ws-1",
        chatId: "chat-1",
      };

      const storedMessages = await extractFiles(storeMessages, context);

      // Rewrite to HTTP URLs
      const httpMessages = rewriteStorageUrls(storedMessages, backendOrigin);

      // Now inline them back
      const inlined = await inlineFileUrls(httpMessages, backendOrigin);

      const filePart = inlined[0].parts[1];
      expect((filePart as FileUIPart).url).toMatch(/^data:image\/png;base64,/);
    });

    it("should leave existing data URLs unchanged", async () => {
      const dataUrl = createPngDataUrl();
      const messages: PlatypusUIMessage[] = [
        createMessageWithFile("msg-1", dataUrl),
      ];

      const inlined = await inlineFileUrls(messages, backendOrigin);

      const filePart = inlined[0].parts[1];
      expect((filePart as FileUIPart).url).toBe(dataUrl);
    });

    it("should leave unrecognized URLs unchanged", async () => {
      const externalUrl = "https://example.com/image.png";
      const messages: PlatypusUIMessage[] = [
        createMessageWithFile("msg-1", externalUrl),
      ];

      const inlined = await inlineFileUrls(messages, backendOrigin);

      const filePart = inlined[0].parts[1];
      expect((filePart as FileUIPart).url).toBe(externalUrl);
    });

    it("should handle messages without parts", async () => {
      const messages: PlatypusUIMessage[] = [
        { id: "msg-1", role: "user", parts: [] },
      ];

      const inlined = await inlineFileUrls(messages, backendOrigin);
      expect(inlined).toHaveLength(1);
      expect(inlined[0].parts).toHaveLength(0);
    });

    it("should leave part unchanged when file is not found in storage", async () => {
      const storageUrl = "storage://org-1/ws-1/chat-1/msg-1/0-nonexist.png";
      const messages: PlatypusUIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [{ type: "file", url: storageUrl, mediaType: "image/png" }],
        },
      ];

      const inlined = await inlineFileUrls(messages, backendOrigin);

      const filePart = inlined[0].parts[0];
      expect((filePart as FileUIPart).url).toBe(storageUrl);
    });

    // A File part's key round-trips through the client, so a Chat turn can
    // carry a key Platypus never generated. Before validation, a traversal key
    // read a host file and inlined its bytes into the System prompt.
    it("should not inline a file reached by traversing out of the storage root", async () => {
      const secretPath = path.join(tempDir, "..", "outside-secret.txt");
      await fs.writeFile(secretPath, "SUPER_SECRET_VALUE");
      await fs.writeFile(
        `${secretPath}.meta`,
        JSON.stringify({ contentType: "text/plain" }),
      );

      const traversalUrl = "storage://../outside-secret.txt";
      const messages: PlatypusUIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [{ type: "file", url: traversalUrl, mediaType: "text/plain" }],
        },
      ];

      const inlined = await inlineFileUrls(messages, backendOrigin);

      const filePart = inlined[0].parts[0] as FileUIPart;
      expect(filePart.url).toBe(traversalUrl);
      expect(filePart.url).not.toContain("data:");
    });

    it("should not inline a traversal key arriving in the HTTP URL form", async () => {
      const secretPath = path.join(tempDir, "..", "outside-secret-http.txt");
      await fs.writeFile(secretPath, "SUPER_SECRET_VALUE");
      await fs.writeFile(
        `${secretPath}.meta`,
        JSON.stringify({ contentType: "text/plain" }),
      );

      const traversalUrl = `${backendOrigin}/files/../outside-secret-http.txt`;
      const messages: PlatypusUIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [{ type: "file", url: traversalUrl, mediaType: "text/plain" }],
        },
      ];

      const inlined = await inlineFileUrls(messages, backendOrigin);

      expect((inlined[0].parts[0] as FileUIPart).url).toBe(traversalUrl);
    });
  });

  describe("extractFiles - untrusted message id", () => {
    // `message.id` is the client's, and it lands mid-key. Before validation a
    // message id of `../../x` filed the file outside its own Chat and
    // Workspace prefix — the prefix `/files/*` parses back to authorize.
    it("should not store a file under a key escaping its chat prefix", async () => {
      const messages: PlatypusUIMessage[] = [
        {
          id: "../../pwned",
          role: "user",
          parts: [
            { type: "file", url: createPngDataUrl(), mediaType: "image/png" },
          ],
        },
      ];

      const processed = await extractFiles(messages, {
        orgId: "org-1",
        workspaceId: "ws-1",
        chatId: "chat-1",
      });

      // The data URL is left in place, exactly as for any other store failure.
      expect((processed[0].parts[0] as FileUIPart).url).toBe(
        createPngDataUrl(),
      );
      expect(await countPngFiles(tempDir)).toBe(0);
    });

    it("should store a file under a well-formed message id", async () => {
      const messages: PlatypusUIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [
            { type: "file", url: createPngDataUrl(), mediaType: "image/png" },
          ],
        },
      ];

      const processed = await extractFiles(messages, {
        orgId: "org-1",
        workspaceId: "ws-1",
        chatId: "chat-1",
      });

      expect((processed[0].parts[0] as FileUIPart).url).toMatch(
        /^storage:\/\/org-1\/ws-1\/chat-1\/msg-1\/0-[0-9a-f]{8}\.png$/,
      );
    });
  });

  describe("extractStorageKeys - untrusted keys", () => {
    it("should skip a traversal key so deletion never leaves the root", () => {
      const messages: PlatypusUIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [
            {
              type: "file",
              url: "storage://../../etc/passwd",
              mediaType: "text/plain",
            },
            {
              type: "file",
              url: "storage://org-1/ws-1/chat-1/msg-1/0-abc12345.png",
              mediaType: "image/png",
            },
          ],
        },
      ];

      expect(extractStorageKeys(messages)).toEqual([
        "org-1/ws-1/chat-1/msg-1/0-abc12345.png",
      ]);
    });
  });
});
