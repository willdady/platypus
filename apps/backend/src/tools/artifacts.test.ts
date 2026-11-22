import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ARTIFACT_CONTENT_MAX_BYTES } from "@platypus/schemas";
import {
  callOkTool,
  callTool,
  resetMockDb,
  seedDb,
  type FakeDb,
} from "../test-utils.ts";
import { createArtifactTools } from "./artifacts.ts";

const workspaceId = "ws-1";
const chatId = "chat-1";

type CreatedArtifact = { id: string; title: string; version: number };

type ArtifactRow = {
  id: string;
  workspaceId: string;
  sourceChatId: string | null;
  title: string;
  type: string;
  language: string | null;
};

type VersionRow = {
  artifactId: string;
  version: number;
  content: string;
  author: string;
};

describe("createArtifactTools", () => {
  let fake: FakeDb;
  let tools: ReturnType<typeof createArtifactTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    fake = seedDb({ artifact: [], artifact_version: [] });
    tools = createArtifactTools(workspaceId, chatId);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const artifacts = () => fake.tables.artifact as ArtifactRow[];
  const versions = () => fake.tables.artifact_version as VersionRow[];

  it("contributes createArtifact only in this slice", () => {
    expect(Object.keys(tools)).toEqual(["createArtifact"]);
  });

  it("tells the model which library origins Artifacts may load from", () => {
    expect(tools.createArtifact.description).toContain(
      "https://cdnjs.cloudflare.com",
    );
  });

  it("says no external origins are allowed when the list is empty", () => {
    vi.stubEnv("ARTIFACT_SCRIPT_ORIGINS", "");

    const turnTools = createArtifactTools(workspaceId, chatId);

    expect(turnTools.createArtifact.description).toMatch(
      /no external origins are approved/i,
    );
    expect(turnTools.createArtifact.description).not.toContain(
      "https://cdnjs.cloudflare.com",
    );
  });

  it("creates the Artifact with version 1, written by the agent", async () => {
    const result = (await callOkTool(tools.createArtifact, {
      title: "Release notes",
      type: "markdown",
      content: "# 1.0\n\nFirst release.",
    })) as CreatedArtifact;

    expect(result).toMatchObject({ title: "Release notes", version: 1 });
    expect(result).not.toHaveProperty("content");

    expect(artifacts()).toEqual([
      expect.objectContaining({
        id: result.id,
        workspaceId,
        sourceChatId: chatId,
        title: "Release notes",
        type: "markdown",
        language: null,
      }),
    ]);

    expect(versions()).toEqual([
      expect.objectContaining({
        artifactId: result.id,
        version: 1,
        content: "# 1.0\n\nFirst release.",
        author: "agent",
      }),
    ]);
  });

  // A Trigger run and a Sub-Agent both reach a Tool set through the same
  // context, so the Chat id the factory is built with is the source either way.
  it.each(["trigger-run-1", "chat-1"])(
    "records the invoking session %s as the source Chat",
    async (sourceChatId) => {
      const turnTools = createArtifactTools(workspaceId, sourceChatId);

      await callOkTool(turnTools.createArtifact, {
        title: "Nightly report",
        type: "markdown",
        content: "Done",
      });

      expect(artifacts()[0].sourceChatId).toBe(sourceChatId);
    },
  );

  it("stores the language for a code Artifact, and none otherwise", async () => {
    await callOkTool(tools.createArtifact, {
      title: "Parser",
      type: "code",
      language: "typescript",
      content: "export const x = 1;",
    });
    await callOkTool(tools.createArtifact, {
      title: "Diagram",
      type: "mermaid",
      language: "typescript",
      content: "graph TD; A-->B;",
    });

    const [code, diagram] = artifacts();
    expect(code.language).toBe("typescript");
    expect(diagram.language).toBeNull();
  });

  it("refuses an empty title without writing anything", async () => {
    const result: unknown = await callTool(tools.createArtifact, {
      title: "",
      type: "markdown",
      content: "Body",
    });

    expect(result).toEqual({
      error: "Artifact title must be between 1 and 200 characters",
    });
    expect(artifacts()).toEqual([]);
  });

  it("refuses a title over its limit without truncating it", async () => {
    const result: unknown = await callTool(tools.createArtifact, {
      title: "x".repeat(201),
      type: "markdown",
      content: "Body",
    });

    expect(result).toEqual({
      error: "Artifact title must be between 1 and 200 characters",
    });
    expect(artifacts()).toEqual([]);
  });

  it("refuses content over 512 KB without writing a version", async () => {
    const result: unknown = await callTool(tools.createArtifact, {
      title: "Too big",
      type: "markdown",
      content: "x".repeat(ARTIFACT_CONTENT_MAX_BYTES + 1),
    });

    expect(result).toEqual({
      error: "Artifact content must be at most 512 KB",
    });
    expect(versions()).toEqual([]);
  });

  it("accepts content exactly at the cap", async () => {
    const result = (await callOkTool(tools.createArtifact, {
      title: "At the limit",
      type: "markdown",
      content: "x".repeat(ARTIFACT_CONTENT_MAX_BYTES),
    })) as CreatedArtifact;

    expect(result.version).toBe(1);
  });
});
