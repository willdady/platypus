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

const day = (n: number) => new Date(Date.UTC(2026, 0, n));

type CreatedArtifact = { id: string; title: string; version: number };
type ReadArtifact = {
  title: string;
  type: string;
  version: number;
  content: string;
};

type ArtifactRow = {
  id: string;
  workspaceId: string;
  sourceChatId: string | null;
  title: string;
  type: string;
  language: string | null;
  updatedAt: Date;
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
  const ownVersions = () =>
    versions().filter(({ artifactId }) => artifactId === "artifact-1");

  const seedExisting = ({
    content = "# Notes\n\nHello world.",
    title = "Notes",
    author = "agent",
    type = "markdown",
  }: {
    content?: string;
    title?: string;
    author?: string;
    type?: string;
  } = {}) => {
    fake = seedDb({
      artifact: [
        {
          id: "artifact-1",
          workspaceId,
          sourceChatId: chatId,
          title,
          type,
          language: type === "code" ? "ts" : null,
          createdAt: day(1),
          updatedAt: day(1),
        },
        {
          id: "artifact-theirs",
          workspaceId: "ws-2",
          sourceChatId: "chat-2",
          title: "Theirs",
          type: "markdown",
          language: null,
          createdAt: day(1),
          updatedAt: day(1),
        },
      ],
      artifact_version: [
        {
          id: "v1",
          artifactId: "artifact-1",
          version: 1,
          content,
          author,
          createdAt: day(1),
        },
        {
          id: "v-theirs",
          artifactId: "artifact-theirs",
          version: 1,
          content: "Their secret",
          author: "agent",
          createdAt: day(1),
        },
      ],
    });
    return fake;
  };

  it("contributes four tools: create, update, read and list", () => {
    expect(Object.keys(tools)).toEqual([
      "createArtifact",
      "updateArtifact",
      "readArtifact",
      "listArtifacts",
    ]);
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

  describe("createArtifact with an id (whole rewrite)", () => {
    it("writes the whole content as the next version, with the new title", async () => {
      seedExisting();

      const result = (await callOkTool(tools.createArtifact, {
        id: "artifact-1",
        title: "Notes, revised",
        type: "markdown",
        content: "# Rewritten",
      })) as CreatedArtifact;

      expect(result).toEqual({
        id: "artifact-1",
        title: "Notes, revised",
        version: 2,
      });
      expect(ownVersions()).toHaveLength(2);
      expect(ownVersions()).toContainEqual(
        expect.objectContaining({
          artifactId: "artifact-1",
          version: 2,
          content: "# Rewritten",
          author: "agent",
        }),
      );
      expect(artifacts()[0]).toMatchObject({
        id: "artifact-1",
        title: "Notes, revised",
        type: "markdown",
      });
      expect(artifacts()[0].updatedAt.getTime()).toBeGreaterThan(
        day(1).getTime(),
      );
    });

    it("refuses a type change loudly and writes nothing", async () => {
      seedExisting();

      const result: unknown = await callTool(tools.createArtifact, {
        id: "artifact-1",
        title: "Notes",
        type: "code",
        content: "const x = 1;",
      });

      expect(result).toEqual({
        error: "Artifact type cannot change from markdown to code",
      });
      expect(ownVersions()).toHaveLength(1);
      expect(artifacts()[0].type).toBe("markdown");
    });

    it("refuses a rewrite that would exceed the limits", async () => {
      seedExisting();

      const overContent: unknown = await callTool(tools.createArtifact, {
        id: "artifact-1",
        title: "Notes",
        type: "markdown",
        content: "x".repeat(ARTIFACT_CONTENT_MAX_BYTES + 1),
      });
      const overTitle: unknown = await callTool(tools.createArtifact, {
        id: "artifact-1",
        title: "x".repeat(201),
        type: "markdown",
        content: "Body",
      });

      expect(overContent).toEqual({
        error: "Artifact content must be at most 512 KB",
      });
      expect(overTitle).toEqual({
        error: "Artifact title must be between 1 and 200 characters",
      });
      expect(ownVersions()).toHaveLength(1);
    });

    it("does not find an Artifact from another Workspace", async () => {
      seedExisting();

      const result: unknown = await callTool(tools.createArtifact, {
        id: "artifact-theirs",
        title: "Mine now",
        type: "markdown",
        content: "Overwritten?",
      });

      expect(result).toEqual({ error: "Artifact not found" });
      expect(ownVersions()).toHaveLength(1);
    });
  });

  describe("updateArtifact", () => {
    it("applies several edits in order as one new version", async () => {
      seedExisting({ content: "# Notes\n\nHello world.\n\nOld line." });

      const result = (await callOkTool(tools.updateArtifact, {
        id: "artifact-1",
        edits: [
          { old: "Hello world.", new: "Hello there." },
          { old: "Old line.", new: "New line." },
        ],
      })) as CreatedArtifact;

      expect(result).toEqual({
        id: "artifact-1",
        title: "Notes",
        version: 2,
      });
      expect(ownVersions()).toHaveLength(2);
      expect(ownVersions()[1]).toMatchObject({
        version: 2,
        content: "# Notes\n\nHello there.\n\nNew line.",
        author: "agent",
      });
    });

    it("applies each edit to the text the previous one produced", async () => {
      seedExisting({ content: "alpha" });

      const result = (await callOkTool(tools.updateArtifact, {
        id: "artifact-1",
        edits: [
          { old: "alpha", new: "beta" },
          { old: "beta", new: "gamma" },
        ],
      })) as CreatedArtifact;

      expect(result).toMatchObject({ version: 2 });
      expect(ownVersions()[1].content).toBe("gamma");
    });

    it("numbers successive writes without a gap", async () => {
      seedExisting({ content: "first" });

      await callOkTool(tools.updateArtifact, {
        id: "artifact-1",
        edits: [{ old: "first", new: "second" }],
      });
      await callOkTool(tools.updateArtifact, {
        id: "artifact-1",
        edits: [{ old: "second", new: "third" }],
      });

      expect(ownVersions().map(({ version }) => version)).toEqual([1, 2, 3]);
      expect(ownVersions()[2].content).toBe("third");
    });

    it("locks the Artifact row before choosing the next version", async () => {
      seedExisting();
      fake.queries.length = 0;

      await callOkTool(tools.updateArtifact, {
        id: "artifact-1",
        edits: [{ old: "Hello world.", new: "Hello there." }],
      });

      expect(fake.queries).toContainEqual({
        kind: "select",
        table: "artifact",
        lock: "update",
      });
    });

    it("names a zero-match edit and writes no version", async () => {
      seedExisting();

      const result = (await callTool(tools.updateArtifact, {
        id: "artifact-1",
        edits: [{ old: "Goodbye world.", new: "Hello there." }],
      })) as { error: string };

      expect(result.error).toMatch(/Edit 1/);
      expect(result.error).toMatch(/matched 0 times/);
      expect(result.error).toMatch(/readArtifact/);
      expect(ownVersions()).toHaveLength(1);
    });

    it("names an ambiguous edit and writes no version", async () => {
      seedExisting({ content: "repeat repeat" });

      const result = (await callTool(tools.updateArtifact, {
        id: "artifact-1",
        edits: [{ old: "repeat", new: "once" }],
      })) as { error: string };

      expect(result.error).toMatch(/Edit 1/);
      expect(result.error).toMatch(/matched 2 times/);
      expect(ownVersions()).toHaveLength(1);
    });

    it("writes nothing when a later edit fails", async () => {
      seedExisting();

      const result = (await callTool(tools.updateArtifact, {
        id: "artifact-1",
        edits: [
          { old: "Hello world.", new: "Goodbye world." },
          { old: "not there", new: "anything" },
        ],
      })) as { error: string };

      expect(result.error).toMatch(/Edit 2/);
      expect(ownVersions()).toHaveLength(1);
      expect(ownVersions()[0].content).toBe("# Notes\n\nHello world.");
      expect(artifacts()[0].updatedAt.getTime()).toBe(day(1).getTime());
    });

    it("works from the latest version, including one the User wrote", async () => {
      fake = seedDb({
        artifact: [
          {
            id: "artifact-1",
            workspaceId,
            sourceChatId: chatId,
            title: "Notes",
            type: "markdown",
            language: null,
            createdAt: day(1),
            updatedAt: day(2),
          },
        ],
        artifact_version: [
          {
            id: "v1",
            artifactId: "artifact-1",
            version: 1,
            content: "First text.",
            author: "agent",
            createdAt: day(1),
          },
          {
            id: "v2",
            artifactId: "artifact-1",
            version: 2,
            content: "Edited by hand.",
            author: "user",
            createdAt: day(2),
          },
        ],
      });

      const stale = (await callTool(tools.updateArtifact, {
        id: "artifact-1",
        edits: [{ old: "First text.", new: "Stale change." }],
      })) as { error: string };
      expect(stale.error).toMatch(/matched 0 times/);

      const result = (await callOkTool(tools.updateArtifact, {
        id: "artifact-1",
        edits: [{ old: "Edited by hand.", new: "Edited by the agent." }],
      })) as CreatedArtifact;

      expect(result).toMatchObject({ version: 3 });
      expect(versions()[2]).toMatchObject({
        version: 3,
        content: "Edited by the agent.",
        author: "agent",
      });
    });

    it("refuses an edit that would push the content over the cap", async () => {
      seedExisting({
        content: `${"x".repeat(ARTIFACT_CONTENT_MAX_BYTES - 5)}MARK`,
      });

      const result: unknown = await callTool(tools.updateArtifact, {
        id: "artifact-1",
        edits: [{ old: "MARK", new: "MARK".padEnd(50, "y") }],
      });

      expect(result).toEqual({
        error: "Artifact content must be at most 512 KB",
      });
      expect(ownVersions()).toHaveLength(1);
    });

    it("does not find an Artifact from another Workspace", async () => {
      seedExisting();

      const result: unknown = await callTool(tools.updateArtifact, {
        id: "artifact-theirs",
        edits: [{ old: "Their secret", new: "Mine" }],
      });

      expect(result).toEqual({ error: "Artifact not found" });
      expect(
        versions().find(({ artifactId }) => artifactId === "artifact-theirs")
          ?.content,
      ).toBe("Their secret");
    });
  });

  describe("readArtifact", () => {
    it("returns the latest version's title, type, number and content", async () => {
      seedExisting();

      const result = (await callOkTool(tools.readArtifact, {
        id: "artifact-1",
      })) as ReadArtifact;

      expect(result).toEqual({
        title: "Notes",
        type: "markdown",
        version: 1,
        content: "# Notes\n\nHello world.",
      });
    });

    it("reads a named older version", async () => {
      seedExisting();
      await callOkTool(tools.updateArtifact, {
        id: "artifact-1",
        edits: [{ old: "Hello world.", new: "Hello there." }],
      });

      const latest = (await callOkTool(tools.readArtifact, {
        id: "artifact-1",
      })) as ReadArtifact;
      const first = (await callOkTool(tools.readArtifact, {
        id: "artifact-1",
        version: 1,
      })) as ReadArtifact;

      expect(latest).toMatchObject({ version: 2 });
      expect(latest.content).toContain("Hello there.");
      expect(first).toMatchObject({
        version: 1,
        content: "# Notes\n\nHello world.",
      });
    });

    it("does not find an Artifact from another Workspace or a missing version", async () => {
      seedExisting();

      const theirs: unknown = await callTool(tools.readArtifact, {
        id: "artifact-theirs",
      });
      const missing: unknown = await callTool(tools.readArtifact, {
        id: "artifact-1",
        version: 9,
      });

      expect(theirs).toEqual({ error: "Artifact not found" });
      expect(missing).toEqual({ error: "Artifact version not found" });
    });
  });

  describe("listArtifacts", () => {
    const seedList = () => {
      fake = seedDb({
        artifact: [
          {
            id: "a-alpha",
            workspaceId,
            sourceChatId: null,
            title: "Alpha guide",
            type: "markdown",
            language: null,
            createdAt: day(1),
            updatedAt: day(4),
          },
          {
            id: "a-beta",
            workspaceId,
            sourceChatId: null,
            title: "Beta parser",
            type: "code",
            language: "ts",
            createdAt: day(1),
            updatedAt: day(3),
          },
          {
            id: "a-gamma",
            workspaceId,
            sourceChatId: null,
            title: "Gamma diagram",
            type: "mermaid",
            language: null,
            createdAt: day(1),
            updatedAt: day(2),
          },
          {
            id: "a-secret",
            workspaceId: "ws-2",
            sourceChatId: null,
            title: "Alpha secret",
            type: "markdown",
            language: null,
            createdAt: day(1),
            updatedAt: day(5),
          },
        ],
        artifact_version: [
          {
            id: "v-alpha",
            artifactId: "a-alpha",
            version: 1,
            content: "Alpha content",
            author: "agent",
            createdAt: day(1),
          },
        ],
      });
    };

    it("lists this Workspace's Artifacts newest first, without content", async () => {
      seedList();

      const result = (await callOkTool(tools.listArtifacts, {})) as {
        artifacts: Record<string, unknown>[];
      };

      expect(result.artifacts.map(({ id }) => id)).toEqual([
        "a-alpha",
        "a-beta",
        "a-gamma",
      ]);
      expect(result.artifacts[0]).toEqual({
        id: "a-alpha",
        title: "Alpha guide",
        type: "markdown",
        updatedAt: day(4),
      });
      expect(JSON.stringify(result)).not.toContain("Alpha content");
    });

    it("searches titles case-insensitively and filters by type", async () => {
      seedList();

      const searched = (await callOkTool(tools.listArtifacts, {
        query: "alpha",
      })) as { artifacts: { id: string }[] };
      const typed = (await callOkTool(tools.listArtifacts, {
        type: "code",
      })) as { artifacts: { id: string }[] };

      expect(searched.artifacts.map(({ id }) => id)).toEqual(["a-alpha"]);
      expect(typed.artifacts.map(({ id }) => id)).toEqual(["a-beta"]);
    });

    it("honours the limit", async () => {
      seedList();

      const result = (await callOkTool(tools.listArtifacts, {
        limit: 2,
      })) as { artifacts: { id: string }[] };

      expect(result.artifacts.map(({ id }) => id)).toEqual([
        "a-alpha",
        "a-beta",
      ]);
    });
  });
});
