import { describe, it, expect } from "vitest";
import {
  artifactFileExtension,
  artifactFileName,
  isAllowedArtifactImageSource,
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
  });
});
