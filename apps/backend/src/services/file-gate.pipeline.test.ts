import { describe, it, expect, beforeEach } from "vitest";
import { DEFAULT_MAX_EXTRACTED_TEXT_CHARS } from "@platypus/schemas";
import type { PlatypusUIMessage } from "../types.ts";
import {
  extractFiles,
  inlineFileUrls,
  rewriteStorageUrls,
} from "../storage/utils.ts";
import { assertFilePartsSupported, normalizeFileParts } from "./file-gate.ts";
import { resetExtractedTextCache } from "./file-extraction.ts";
import {
  buildTestDocx,
  buildTestPdf,
} from "./file-extraction.test-fixtures.ts";
import { useTempDiskStorage } from "../storage/temp-disk.test-fixtures.ts";

const PDF_TYPE = "application/pdf";
const DOCX_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const origin = "http://localhost:4000";
const chat = { orgId: "org-1", workspaceId: "ws-1", chatId: "chat-1" };

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

const cap = { maxExtractedTextChars: DEFAULT_MAX_EXTRACTED_TEXT_CHARS };

describe("attachment pipeline (gate → store → inline → normalize)", () => {
  useTempDiskStorage();

  beforeEach(() => {
    resetExtractedTextCache();
  });

  const roundTrip = async (message: PlatypusUIMessage) => {
    await assertFilePartsSupported([message], ["image/*"]);
    const stored = await extractFiles([message], chat);
    expect((stored[0].parts[1] as unknown as { url: string }).url).toMatch(
      /^storage:\/\//,
    );
    const inlined = await inlineFileUrls(stored, origin, chat);
    const [normalized] = await normalizeFileParts(inlined, ["image/*"], cap);
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

  describe("with STORAGE_PUBLIC_URL set", () => {
    const publicUrl = "https://cdn.example.com";

    beforeEach(() => {
      process.env.STORAGE_PUBLIC_URL = publicUrl;
    });

    afterEach(() => {
      delete process.env.STORAGE_PUBLIC_URL;
    });

    const replay = async (message: PlatypusUIMessage, turns: number) => {
      await assertFilePartsSupported([message], ["image/*"]);
      const stored = await extractFiles([message], chat);
      const served = rewriteStorageUrls(stored, origin);
      expect((served[0].parts[1] as unknown as { url: string }).url).toBe(
        `${publicUrl}/${(stored[0].parts[1] as unknown as { url: string }).url.slice("storage://".length)}`,
      );

      const results: PlatypusUIMessage[] = [];
      for (let turn = 0; turn < turns; turn++) {
        const inlined = await inlineFileUrls(served, origin, chat);
        const [normalized] = await normalizeFileParts(
          inlined,
          ["image/*"],
          cap,
        );
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
