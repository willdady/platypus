import { describe, it, expect } from "vitest";
import {
  artifactFileExtension,
  artifactFileName,
  artifactUploadFromFileName,
  decodeArtifactText,
  isAllowedArtifactImageSource,
  resolveArtifactImageSource,
} from "./artifact-file";

describe("artifactFileExtension", () => {
  it.each([
    ["markdown", undefined, "md"],
    ["mermaid", undefined, "mmd"],
    ["html", undefined, "html"],
    ["svg", undefined, "svg"],
    ["code", "typescript", "ts"],
    ["code", "python", "py"],
    ["code", "ts", "ts"],
  ] as const)("%s (%s) downloads as .%s", (type, language, expected) => {
    expect(artifactFileExtension(type, language)).toBe(expected);
  });

  it("falls back to .txt for an unknown code language", () => {
    expect(artifactFileExtension("code", "brainfuck")).toBe("txt");
    expect(artifactFileExtension("code", undefined)).toBe("txt");
  });
});

describe("artifactFileName", () => {
  it("makes the title safe and appends the type's extension", () => {
    expect(artifactFileName("Q3 / Plan: draft?", "markdown")).toBe(
      "Q3 - Plan- draft-.md",
    );
  });

  it("never returns an empty name", () => {
    expect(artifactFileName("///", "svg")).toBe("artifact.svg");
  });

  it("does not append an extension the title already ends with", () => {
    expect(artifactFileName("notes.md", "markdown")).toBe("notes.md");
    expect(artifactFileName("README.MD", "markdown")).toBe("README.MD");
    expect(artifactFileName("notes.txt", "markdown")).toBe("notes.txt.md");
  });
});

describe("artifactUploadFromFileName", () => {
  it.each([
    ["notes.md", "markdown", undefined],
    ["page.html", "html", undefined],
    ["diagram.mmd", "mermaid", undefined],
    ["logo.svg", "svg", undefined],
    ["script.ts", "code", "ts"],
    ["Makefile", "code", undefined],
    [".env", "code", undefined],
  ] as const)("%s uploads as %s", (fileName, type, language) => {
    const upload = artifactUploadFromFileName(fileName);
    expect(typeof upload.title).toBe("string");
    expect(upload.type).toBe(type);
    expect(upload.language).toBe(language);
  });

  it("takes the title from the file name, extension and all", () => {
    expect(artifactUploadFromFileName("Q3 plan.md").title).toBe("Q3 plan.md");
    expect(artifactUploadFromFileName("a.b.py").title).toBe("a.b.py");
    expect(artifactUploadFromFileName("Makefile").title).toBe("Makefile");
    expect(artifactUploadFromFileName(".env").title).toBe(".env");
  });

  it("reads the extension case-insensitively", () => {
    expect(artifactUploadFromFileName("PAGE.HTML").type).toBe("html");
    expect(artifactUploadFromFileName("SCRIPT.TS")).toMatchObject({
      type: "code",
      language: "ts",
    });
  });
});

describe("decodeArtifactText", () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  it("decodes UTF-8 text", () => {
    expect(decodeArtifactText(encode("héllo — 世界"))).toBe("héllo — 世界");
    expect(decodeArtifactText(new Uint8Array())).toBe("");
  });

  it("refuses bytes that are not UTF-8", () => {
    expect(decodeArtifactText(new Uint8Array([0xff, 0xfe, 0x00]))).toBe(
      undefined,
    );
    expect(decodeArtifactText(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(
      undefined,
    );
  });

  it("refuses bytes holding a NUL, which no text file uses", () => {
    expect(decodeArtifactText(encode("before\u0000after"))).toBe(undefined);
  });

  it("keeps a replacement character, which is ordinary text", () => {
    expect(decodeArtifactText(encode("before\uFFFDafter"))).toBe(
      "before\uFFFDafter",
    );
  });
});

describe("isAllowedArtifactImageSource", () => {
  const backend = "https://app.example.com";

  it("allows inline content and this deployment's stored files", () => {
    expect(
      isAllowedArtifactImageSource("data:image/png;base64,abc", backend),
    ).toBe(true);
    expect(
      isAllowedArtifactImageSource(
        "https://app.example.com/files/org/ws/chat/msg/0-a.png",
        backend,
      ),
    ).toBe(true);
    expect(
      isAllowedArtifactImageSource("/files/org/ws/chat/msg/0-a.png", backend),
    ).toBe(true);
  });

  it("refuses another host, even one under a lookalike path", () => {
    expect(
      isAllowedArtifactImageSource(
        "https://elsewhere.test/files/org/ws/chat/msg/0-a.png",
        backend,
      ),
    ).toBe(false);
    expect(
      isAllowedArtifactImageSource(
        "https://app.example.com/api/secret.png",
        backend,
      ),
    ).toBe(false);
    expect(
      isAllowedArtifactImageSource("//elsewhere.test/x.png", backend),
    ).toBe(false);
    expect(
      isAllowedArtifactImageSource("//elsewhere.test/files/x.png", backend),
    ).toBe(false);
  });

  it.each([
    "/files/../auth/x",
    "/files/a/../../auth/x",
    "/files/%2e%2e/auth/x",
    "/files/%2E%2E/auth/x",
    "/files/..%2fauth/x",
    "/files/%252e%252e/auth/x",
    "https://app.example.com/files/../auth/x",
  ])("refuses a stored-file path that escapes /files/: %s", (src) => {
    expect(isAllowedArtifactImageSource(src, backend)).toBe(false);
    expect(resolveArtifactImageSource(src, backend)).toBeUndefined();
  });

  it("resolves a stored-file path to the absolute backend URL", () => {
    expect(
      resolveArtifactImageSource("/files/org/ws/chat/msg/0-a.png", backend),
    ).toBe("https://app.example.com/files/org/ws/chat/msg/0-a.png");
    expect(
      resolveArtifactImageSource(
        "https://app.example.com/files/org/ws/chat/msg/0-a.png",
        backend,
      ),
    ).toBe("https://app.example.com/files/org/ws/chat/msg/0-a.png");
  });
});

describe("isAllowedArtifactImageSource with a storage base", () => {
  const backend = "https://app.example.com";
  const storage = "https://cdn.example.com";

  it("allows a file under the storage base", () => {
    expect(
      isAllowedArtifactImageSource(
        "https://cdn.example.com/org/ws/chat/msg/0-a.png",
        backend,
        storage,
      ),
    ).toBe(true);
    expect(
      resolveArtifactImageSource(
        "https://cdn.example.com/org/ws/chat/msg/0-a.png",
        backend,
        storage,
      ),
    ).toBe("https://cdn.example.com/org/ws/chat/msg/0-a.png");
  });

  it("still allows this deployment's own /files route beside the base", () => {
    expect(
      resolveArtifactImageSource(
        "/files/org/ws/chat/msg/0-a.png",
        backend,
        storage,
      ),
    ).toBe("https://app.example.com/files/org/ws/chat/msg/0-a.png");
  });

  it("allows a file under the path a shared host mounts the bucket on", () => {
    expect(
      isAllowedArtifactImageSource(
        "https://cdn.example.com/bucket/org/ws/0-a.png",
        backend,
        "https://cdn.example.com/bucket",
      ),
    ).toBe(true);
    expect(
      isAllowedArtifactImageSource(
        "https://cdn.example.com/bucket/org/ws/0-a.png",
        backend,
        "https://cdn.example.com/bucket/",
      ),
    ).toBe(true);
  });

  it("matches an encoded base path against the encoded request", () => {
    expect(
      resolveArtifactImageSource(
        "https://cdn.example.com/my%20bucket/org/ws/0-a.png",
        backend,
        "https://cdn.example.com/my%20bucket",
      ),
    ).toBe("https://cdn.example.com/my%20bucket/org/ws/0-a.png");
  });

  it("refuses a sibling path on the base's host", () => {
    expect(
      isAllowedArtifactImageSource(
        "https://cdn.example.com/bucket-other/0-a.png",
        backend,
        "https://cdn.example.com/bucket",
      ),
    ).toBe(false);
    expect(
      isAllowedArtifactImageSource(
        "https://cdn.example.com/elsewhere/0-a.png",
        backend,
        "https://cdn.example.com/bucket",
      ),
    ).toBe(false);
  });

  it("refuses a look-alike host", () => {
    expect(
      isAllowedArtifactImageSource(
        "https://cdn.example.com.evil.test/bucket/0-a.png",
        backend,
        "https://cdn.example.com/bucket",
      ),
    ).toBe(false);
    expect(
      isAllowedArtifactImageSource(
        "https://cdn.example.com@evil.test/bucket/0-a.png",
        backend,
        "https://cdn.example.com/bucket",
      ),
    ).toBe(false);
  });

  it.each([
    "https://cdn.example.com/bucket/../secret.png",
    "https://cdn.example.com/bucket/%2e%2e/secret.png",
    "https://cdn.example.com/bucket/%2E%2E/secret.png",
    "https://cdn.example.com/bucket/..%2fsecret.png",
    "https://cdn.example.com/bucket/%252e%252e/secret.png",
    "https://cdn.example.com/bucket/%25252e%25252e/secret.png",
  ])("refuses a path that climbs out of the base: %s", (src) => {
    expect(
      isAllowedArtifactImageSource(
        src,
        backend,
        "https://cdn.example.com/bucket",
      ),
    ).toBe(false);
    expect(
      resolveArtifactImageSource(
        src,
        backend,
        "https://cdn.example.com/bucket",
      ),
    ).toBeUndefined();
  });

  it("still refuses every other host", () => {
    expect(
      isAllowedArtifactImageSource(
        "https://elsewhere.test/org/ws/0-a.png",
        backend,
        storage,
      ),
    ).toBe(false);
  });

  it("leaves the rule unchanged when no storage base is configured", () => {
    expect(
      isAllowedArtifactImageSource(
        "https://cdn.example.com/org/ws/0-a.png",
        backend,
        undefined,
      ),
    ).toBe(false);
    expect(
      isAllowedArtifactImageSource(
        "data:image/png;base64,abc",
        backend,
        undefined,
      ),
    ).toBe(true);
  });
});
