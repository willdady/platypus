import { describe, it, expect, vi } from "vitest";
import type { z } from "zod";
import { createArtifactTools } from "./artifacts.ts";

vi.mock("@platypus/schemas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@platypus/schemas")>()),
  ARTIFACT_TITLE_MIN_LENGTH: 3,
  ARTIFACT_TITLE_MAX_LENGTH: 40,
  ARTIFACT_CONTENT_MAX_BYTES: 8 * 1024,
}));

describe("the Artifact tools' limit text", () => {
  const { createArtifact } = createArtifactTools("ws-1", "chat-1");
  const fields = (
    createArtifact.inputSchema as z.ZodObject<{
      title: z.ZodString;
      content: z.ZodString;
    }>
  ).shape;

  it("states the title and content limits the constants hold", () => {
    expect(createArtifact.description).toContain(
      "The title is 3 to 40 characters; the content is at most 8 KB.",
    );
  });

  it("states the title limits on the title field", () => {
    expect(fields.title.description).toBe(
      "A short name for the Artifact, 3 to 40 characters",
    );
  });

  it("states the content limit on the content field", () => {
    expect(fields.content.description).toBe("The full content, at most 8 KB");
  });
});
