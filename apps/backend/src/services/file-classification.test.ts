import { describe, it, expect } from "vitest";
import {
  mediaTypeMatches,
  isTextLikeExtension,
  looksBinary,
  classifyFilePart,
} from "./file-classification.ts";

describe("mediaTypeMatches", () => {
  it("matches an exact media type", () => {
    expect(mediaTypeMatches("application/pdf", ["application/pdf"])).toBe(true);
    expect(mediaTypeMatches("application/pdf", ["image/png"])).toBe(false);
  });

  it("matches a type/* wildcard", () => {
    expect(mediaTypeMatches("image/png", ["image/*"])).toBe(true);
    expect(mediaTypeMatches("image/jpeg", ["image/*"])).toBe(true);
    expect(mediaTypeMatches("application/pdf", ["image/*"])).toBe(false);
  });

  it("matches the */* wildcard", () => {
    expect(mediaTypeMatches("anything/here", ["*/*"])).toBe(true);
  });

  it("is case-insensitive and tolerates parameters", () => {
    expect(mediaTypeMatches("IMAGE/PNG", ["image/*"])).toBe(true);
    expect(mediaTypeMatches("text/plain; charset=utf-8", ["text/plain"])).toBe(
      true,
    );
  });

  it("returns false for an empty pattern list or missing type", () => {
    expect(mediaTypeMatches("image/png", [])).toBe(false);
    expect(mediaTypeMatches(undefined, ["image/*"])).toBe(false);
  });
});

describe("isTextLikeExtension", () => {
  it("recognizes code and text extensions regardless of case", () => {
    for (const name of ["notes.md", "data.JSON", "run.sh", "a.py", "x.csv"]) {
      expect(isTextLikeExtension(name)).toBe(true);
    }
  });

  it("rejects binary document and unknown extensions", () => {
    for (const name of ["report.pdf", "sheet.xlsx", "slides.pptx", "a.bin"]) {
      expect(isTextLikeExtension(name)).toBe(false);
    }
  });

  it("returns false when there is no filename or extension", () => {
    expect(isTextLikeExtension(undefined)).toBe(false);
    expect(isTextLikeExtension("Makefile")).toBe(false);
  });
});

describe("looksBinary", () => {
  it("flags content containing a NUL byte", () => {
    expect(looksBinary(new Uint8Array([104, 105, 0, 116]))).toBe(true);
  });

  it("treats NUL-free content as text", () => {
    expect(looksBinary(new TextEncoder().encode("hello world"))).toBe(false);
  });

  it("treats empty content as text", () => {
    expect(looksBinary(new Uint8Array([]))).toBe(false);
  });
});

describe("classifyFilePart", () => {
  const chatPassthrough = ["image/*"];
  const nativePassthrough = ["image/*", "application/pdf"];

  it("passes through a file whose media type the model accepts natively", () => {
    expect(
      classifyFilePart(
        { mediaType: "image/png", filename: "a.png" },
        chatPassthrough,
      ),
    ).toBe("passthrough");
    expect(
      classifyFilePart(
        { mediaType: "application/pdf", filename: "a.pdf" },
        nativePassthrough,
      ),
    ).toBe("passthrough");
  });

  it("inlines a text-like file the model can't take natively", () => {
    // .md mis-tagged as octet-stream by the OS is still text by extension.
    expect(
      classifyFilePart(
        { mediaType: "application/octet-stream", filename: "notes.md" },
        chatPassthrough,
      ),
    ).toBe("text");
  });

  it("rejects a binary document the model can't take natively", () => {
    expect(
      classifyFilePart(
        { mediaType: "application/pdf", filename: "report.pdf" },
        chatPassthrough,
      ),
    ).toBe("reject");
  });

  it("uses byte-sniffing to override a text extension that is actually binary", () => {
    expect(
      classifyFilePart(
        { mediaType: "application/octet-stream", filename: "notes.md" },
        chatPassthrough,
        new Uint8Array([0, 1, 2]),
      ),
    ).toBe("reject");
  });

  it("does not let byte-sniffing affect the native passthrough decision", () => {
    // Passthrough wins before any text/binary consideration.
    expect(
      classifyFilePart(
        { mediaType: "image/png", filename: "a.png" },
        chatPassthrough,
        new Uint8Array([0, 1, 2]),
      ),
    ).toBe("passthrough");
  });
});
