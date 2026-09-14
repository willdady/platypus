import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PlatypusUIMessage } from "../types.ts";
import {
  extractFiles,
  inlineFileUrls,
  rewriteStorageUrls,
} from "../storage/utils.ts";
import { resetStorage } from "../storage/index.ts";
import { assertFilePartsSupported, normalizeFileParts } from "./file-gate.ts";
import { resetExtractedTextCache } from "./file-extraction.ts";
import {
  buildTestDocx,
  buildTestPdf,
} from "./file-extraction.test-fixtures.ts";

/**
 * The whole production path for one attachment, against real (disk) storage:
 * gate → persist (`extractFiles`, data: URL becomes a storage:// key) →
 * next turn's inline (`inlineFileUrls`) → normalize. The unit tests either side
 * of this stub one half out; this one proves the halves meet — a document
 * uploaded once still extracts on a later turn, when all the message carries is
 * a storage reference.
 */

const PDF_TYPE = "application/pdf";
const DOCX_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const origin = "http://localhost:4000";

const attachment = (
  filename: string,
  mediaType: string,
  content: Buffer,
): PlatypusUIMessage =>
  ({
    id: "m1",
    role: "user",
    parts: [
      { type: "text", text: "What does this say?" },
      {
        type: "file",
        filename,
        mediaType,
        url: `data:${mediaType};base64,${content.toString("base64")}`,
      },
    ],
  }) as unknown as PlatypusUIMessage;

const textOf = (message: PlatypusUIMessage, index: number) =>
  (message.parts[index] as unknown as { type: string; text: string }).text;

describe("attachment pipeline (gate → store → inline → normalize)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-gate-pipeline-"));
    process.env.STORAGE_DISK_PATH = tempDir;
    process.env.STORAGE_BACKEND = "disk";
    resetStorage();
    resetExtractedTextCache();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    delete process.env.STORAGE_DISK_PATH;
    delete process.env.STORAGE_BACKEND;
    resetStorage();
  });

  const roundTrip = async (message: PlatypusUIMessage) => {
    // 1. The pre-persist gate sees the fresh upload's bytes inline.
    await assertFilePartsSupported([message], ["image/*"]);
    // 2. Persistence swaps the data: URL for a storage:// key.
    const stored = await extractFiles([message], {
      orgId: "org-1",
      workspaceId: "ws-1",
      chatId: "chat-1",
    });
    expect((stored[0].parts[1] as unknown as { url: string }).url).toMatch(
      /^storage:\/\//,
    );
    // 3. A later turn replays history: inline, then normalize for the model.
    const inlined = await inlineFileUrls(stored, origin);
    const [normalized] = await normalizeFileParts(inlined, ["image/*"]);
    return normalized;
  };

  it("extracts a stored PDF on a later turn", async () => {
    const normalized = await roundTrip(
      attachment("report.pdf", PDF_TYPE, buildTestPdf(["Revenue is up"])),
    );
    expect(textOf(normalized, 1)).toContain("[extracted text from report.pdf]");
    expect(textOf(normalized, 1)).toContain("Revenue is up");
  });

  it("extracts a stored DOCX on a later turn", async () => {
    const normalized = await roundTrip(
      attachment("spec.docx", DOCX_TYPE, buildTestDocx(["Design goals"])),
    );
    expect(textOf(normalized, 1)).toContain("[extracted text from spec.docx]");
    expect(textOf(normalized, 1)).toContain("Design goals");
  });

  /**
   * With `STORAGE_PUBLIC_URL` set the read path hands the client
   * `{publicUrl}/{key}` instead of `{origin}/files/{key}`, and the Chat
   * resubmits that URL on every later turn (issue #839). The resolve path must
   * recognise it, or the model is told the file is unavailable from turn 2 on.
   */
  describe("with STORAGE_PUBLIC_URL set", () => {
    const publicUrl = "https://cdn.example.com";

    beforeEach(() => {
      process.env.STORAGE_PUBLIC_URL = publicUrl;
    });

    afterEach(() => {
      delete process.env.STORAGE_PUBLIC_URL;
    });

    /** Turn 1 persists; every later turn replays what the client sent back. */
    const replay = async (message: PlatypusUIMessage, turns: number) => {
      await assertFilePartsSupported([message], ["image/*"]);
      const stored = await extractFiles([message], {
        orgId: "org-1",
        workspaceId: "ws-1",
        chatId: "chat-1",
      });
      const served = rewriteStorageUrls(stored, origin);
      expect((served[0].parts[1] as unknown as { url: string }).url).toBe(
        `${publicUrl}/${(stored[0].parts[1] as unknown as { url: string }).url.slice("storage://".length)}`,
      );

      const results: PlatypusUIMessage[] = [];
      for (let turn = 0; turn < turns; turn++) {
        // The client resubmits the history it was served, verbatim.
        const inlined = await inlineFileUrls(served, origin);
        const [normalized] = await normalizeFileParts(inlined, ["image/*"]);
        results.push(normalized);
      }
      return results;
    };

    it("inlines a replayed .txt on turns 2 and 3", async () => {
      const turns = await replay(
        attachment(
          "notes.txt",
          "text/plain",
          Buffer.from("Quarterly numbers are in", "utf8"),
        ),
        2,
      );
      for (const normalized of turns) {
        expect(textOf(normalized, 1)).toContain("[file: notes.txt]");
        expect(textOf(normalized, 1)).toContain("Quarterly numbers are in");
      }
    });

    it("extracts a replayed .pdf on turns 2 and 3", async () => {
      const turns = await replay(
        attachment("report.pdf", PDF_TYPE, buildTestPdf(["Revenue is up"])),
        2,
      );
      for (const normalized of turns) {
        expect(textOf(normalized, 1)).toContain(
          "[extracted text from report.pdf]",
        );
        expect(textOf(normalized, 1)).toContain("Revenue is up");
      }
    });
  });
});
