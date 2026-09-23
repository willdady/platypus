import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { extractFiles, rewriteStorageUrls, inlineFileUrls } from "./utils.ts";
import { canonicalStorageKeyFromUrl } from "./file-reference.ts";
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
      const key = canonicalStorageKeyFromUrl((filePart as FileUIPart).url);
      expect(key).toMatch(/^org-1\/ws-1\/chat-1\/msg-1\/1-[a-f0-9]{8}\.png$/);
    });

    /**
     * The gate and persistence read data URLs with one parser (issue #839).
     * Each of these shapes was admitted by the gate and refused by the second,
     * stricter parser, leaving base64 inline in the stored row.
     */
    it.each([
      [
        "a URL-encoded body",
        "data:text/plain,hello%20world",
        /\.txt$/,
        "hello world",
      ],
      ["an omitted media type", "data:;base64,aGVsbG8=", /\.bin$/, "hello"],
      [
        "a body split across lines",
        "data:text/plain;base64,aGVs\nbG8=",
        /\.txt$/,
        "hello",
      ],
    ])(
      "should persist a data URL carrying %s",
      async (_label, dataUrl, keyPattern, content) => {
        const [result] = await extractFiles(
          [createMessageWithFile("msg-1", dataUrl)],
          { orgId: "org-1", workspaceId: "ws-1", chatId: "chat-1" },
        );

        const url = (result.parts[1] as FileUIPart).url;
        expect(url).toMatch(/^storage:\/\//);
        const key = canonicalStorageKeyFromUrl(url)!;
        expect(key).toMatch(keyPattern);
        expect(await fs.readFile(path.join(tempDir, key), "utf8")).toBe(
          content,
        );
      },
    );

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

    // A client can put any URL on a part, so a `/files/` path under a host this
    // deployment does not serve names nothing it stored. It stays the external
    // URL it claims to be rather than becoming a read of our own store.
    it("should not inline a /files/ URL under a foreign host", async () => {
      const messages: PlatypusUIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [
            { type: "file", url: createPngDataUrl(), mediaType: "image/png" },
          ],
        },
      ];
      const stored = await extractFiles(messages, {
        orgId: "org-1",
        workspaceId: "ws-1",
        chatId: "chat-1",
      });
      const key = canonicalStorageKeyFromUrl(
        (stored[0].parts[0] as FileUIPart).url,
      )!;
      const foreignUrl = `https://attacker.example.com/x/files/${key}`;

      const inlined = await inlineFileUrls(
        [
          {
            id: "msg-2",
            role: "user",
            parts: [{ type: "file", url: foreignUrl, mediaType: "image/png" }],
          },
        ],
        backendOrigin,
      );

      expect((inlined[0].parts[0] as FileUIPart).url).toBe(foreignUrl);
    });
  });

  describe("extractFiles - untrusted media type", () => {
    // The media type comes out of the client's data URL and is stored, then
    // sent straight back by `/files/*`. A type Platypus never expects — HTML
    // above all — is a page served from the backend's own origin, so the part
    // is refused at store time rather than filed under a `.bin` key.
    it("should not store a file whose media type is outside the expected set", async () => {
      const htmlDataUrl = `data:text/html;base64,${Buffer.from(
        "<script>alert(1)</script>",
      ).toString("base64")}`;
      const messages: PlatypusUIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [{ type: "file", url: htmlDataUrl, mediaType: "text/html" }],
        },
      ];

      const processed = await extractFiles(messages, {
        orgId: "org-1",
        workspaceId: "ws-1",
        chatId: "chat-1",
      });

      // The data URL is left in place, exactly as for any other store failure.
      expect((processed[0].parts[0] as FileUIPart).url).toBe(htmlDataUrl);
      const stored = (await fs.readdir(tempDir, { recursive: true })).flat();
      expect(stored.filter((f) => !String(f).endsWith(".meta"))).toHaveLength(
        0,
      );
    });

    it("should store a file whose media type is expected", async () => {
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
        /^storage:\/\/org-1\/ws-1\/chat-1\/msg-1\/0-[a-f0-9]{8}\.png$/,
      );
      expect(await countPngFiles(tempDir)).toBe(1);
    });

    // A file pasted from a buffer, or picked on an OS that declines to name a
    // type, arrives as `application/octet-stream` — the file gate admits those
    // on the filename, so the allowlist has to as well. The only `.bin` key.
    it("should store an unnamed binary type as .bin", async () => {
      const dataUrl = `data:application/octet-stream;base64,${Buffer.from(
        "binary",
      ).toString("base64")}`;
      const messages: PlatypusUIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [
            {
              type: "file",
              url: dataUrl,
              mediaType: "application/octet-stream",
              filename: "report.pdf",
            },
          ],
        },
      ];

      const processed = await extractFiles(messages, {
        orgId: "org-1",
        workspaceId: "ws-1",
        chatId: "chat-1",
      });

      expect((processed[0].parts[0] as FileUIPart).url).toMatch(
        /^storage:\/\/org-1\/ws-1\/chat-1\/msg-1\/0-[a-f0-9]{8}\.bin$/,
      );
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
});
