import fs from "node:fs/promises";
import path from "node:path";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { strToU8, zipSync } from "fflate";
import { migratedPglite } from "../db/migrated-pglite.test-fixtures.ts";
import os from "node:os";
import { afterEach } from "vitest";
import type { Tool } from "ai";
import { z } from "zod";
import type { SandboxBackend } from "@platypuschat/plugin-sdk";
import { resetStorage } from "../storage/index.ts";
import { mockNanoid } from "../test-setup.ts";
import { NotFoundError, ValidationError } from "../errors.ts";

/**
 * Skill bundles (ADR-0036) end to end against an in-process Postgres built
 * from the shipped migrations and a real disk StorageBackend in a temp dir:
 * what each write leaves in the database and in storage, and what the
 * model-facing Skill Tools read back.
 */
const { holder } = vi.hoisted(() => ({
  holder: { db: undefined as ReturnType<typeof drizzle> | undefined },
}));
vi.mock("../index.ts", () => ({
  get db() {
    return holder.db!;
  },
}));

const { importSkillBundle, replaceSkillBundle, exportSkillBundle } =
  await import("./skill-bundle.ts");
const { deleteSkill, updateSkill, upsertSkill } = await import("./skill.ts");
const { prepareWorkspaceCleanup } = await import("./workspace-delete.ts");
const { promoteScoped } = await import("./promote.ts");
const { seedUserInvokedSkill } = await import("./slash-command.ts");
const { createLoadSkillTool, createReadSkillFileTool } =
  await import("../tools/skill.ts");
const { createSkillManagementTools } =
  await import("../tools/skill-management.ts");
const { parseSkillZip, bundleHash } = await import("./skill-bundle-format.ts");
const { registerSandboxBackend } = await import("../sandbox/index.ts");

/**
 * An in-memory Sandbox: what the copy left in it, and every write it took.
 * `rm -rf` and `chmod +x` are the only commands it understands.
 */
const sandboxState = {
  files: new Map<string, string>(),
  executable: new Set<string>(),
  writes: 0,
  failing: false,
  withBytes: true,
};
const quotedArgs = (command: string) =>
  [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) =>
    m[1].replaceAll("'\\''", "'"),
  );
const fakeSandbox = (): SandboxBackend => {
  // Async, as a real backend's calls are: a stopped Sandbox rejects.
  const guard = () =>
    sandboxState.failing
      ? Promise.reject(new Error("sandbox stopped"))
      : Promise.resolve();
  const write = async (path: string, content: string) => {
    await guard();
    sandboxState.writes++;
    sandboxState.files.set(path, content);
  };
  const unsupported = () => Promise.reject(new Error("unsupported"));
  return {
    shellExec: async (_ctx, { command }) => {
      await guard();
      const args = quotedArgs(command);
      if (command.startsWith("rm -rf")) {
        sandboxState.writes++;
        for (const key of [...sandboxState.files.keys()]) {
          if (args.some((dir) => key.startsWith(`${dir}/`))) {
            sandboxState.files.delete(key);
          }
        }
      } else if (command.startsWith("chmod +x")) {
        args.forEach((path) => sandboxState.executable.add(path));
      } else {
        throw new Error(`fake sandbox can't run: ${command}`);
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        truncated: false,
        durationMs: 1,
      };
    },
    fsRead: async (_ctx, { path }) => {
      await guard();
      const content = sandboxState.files.get(path);
      if (content === undefined)
        throw new Error(`fs.read: no such file ${path}`);
      return { content, lineCount: 1, truncated: false };
    },
    fsWrite: async (_ctx, { path, content }) => {
      await write(path, content);
      return { bytesWritten: content.length };
    },
    fsEdit: unsupported,
    fsList: unsupported,
    destroy: () => Promise.resolve(),
    ...(sandboxState.withBytes && {
      fsWriteBytes: (_ctx, { path, bytes }) =>
        write(path, Buffer.from(bytes).toString("latin1")),
    }),
  };
};

let pg: PGlite;
beforeAll(async () => {
  // Every stored file needs its own key, so the suite-wide fixed id won't do.
  const actual = await vi.importActual<typeof import("nanoid")>("nanoid");
  mockNanoid.mockImplementation(actual.nanoid);
  pg = await migratedPglite();
  holder.db = drizzle(pg);
  registerSandboxBackend({
    backend: "fake",
    name: "Fake",
    configSchema: z.object({}),
    credentialsSchema: z.object({}),
    create: fakeSandbox,
  });
}, 60_000);
afterAll(() => pg.close());

// Not `test-utils.ts`: importing it installs its own mocks of `../index.ts`
// and `drizzle-orm` over the PGlite this suite runs against.
beforeEach(async () => {
  process.env.STORAGE_DISK_PATH = await fs.mkdtemp(
    path.join(os.tmpdir(), "platypus-skill-bundle-test-"),
  );
  resetStorage();
});
afterEach(async () => {
  await fs.rm(process.env.STORAGE_DISK_PATH!, { recursive: true, force: true });
  delete process.env.STORAGE_DISK_PATH;
  resetStorage();
});

const callTool = async (tool: Tool, input: unknown): Promise<unknown> =>
  (await tool.execute!(input, {
    toolCallId: "call-1",
    messages: [],
    context: undefined,
  })) as unknown;

const ctx = { orgId: "org-1", workspaceId: "ws-1" };
const wsScope = { kind: "workspace", ctx } as const;
const orgScope = { kind: "organization", orgId: "org-1" } as const;

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM "organization";
    DELETE FROM "provider";
    DELETE FROM "user";
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at") VALUES
      ('u-1', 'Olive', 'olive@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name") VALUES
      ('ws-1', 'org-1', 'u-1', 'Support');
    INSERT INTO "provider" ("id", "workspace_id", "name", "provider_type", "api_key", "task_model_id", "memory_extraction_model_id", "modelIds") VALUES
      ('p-1', 'ws-1', 'P', 'openai', 'k', 'm', 'm', '[]');
  `);
  sandboxState.files.clear();
  sandboxState.executable.clear();
  sandboxState.writes = 0;
  sandboxState.failing = false;
  sandboxState.withBytes = true;
});

const addSandbox = () =>
  pg.exec(
    `INSERT INTO "sandbox" ("id", "workspace_id", "name", "backend") VALUES ('sb-1', 'ws-1', 'Box', 'fake')`,
  );

const skillMd = (name: string, body = "Read forms.md first.\n") =>
  strToU8(
    `---\nname: ${name}\ndescription: Work with PDF files.\nlicense: Proprietary\n---\n${body}`,
  );

const pdfFields = {
  name: "pdf",
  description: "Work with PDF files.",
  body: "Read forms.md first.",
};

const pdfZip = (name = "pdf") =>
  zipSync({
    "pdf/SKILL.md": skillMd(name),
    "pdf/forms.md": strToU8("# Forms"),
    "pdf/Forms.md": strToU8("# Upper Forms"),
    "pdf/My Notes.md": strToU8("notes"),
    "pdf/日本.md": strToU8("unicode"),
    "pdf/LICENSE": strToU8("All rights reserved"),
    "pdf/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]),
    "pdf/big.txt": strToU8("x".repeat(1024 * 1024 + 1)),
  });

/** Every object stored under `prefix`, as relative paths. */
const storedUnder = async (prefix: string): Promise<string[]> => {
  try {
    const entries = await fs.readdir(
      path.join(process.env.STORAGE_DISK_PATH!, prefix),
      { recursive: true, withFileTypes: true },
    );
    return entries
      .filter((e) => e.isFile() && !e.name.endsWith(".meta"))
      .map((e) => e.name);
  } catch {
    return [];
  }
};

const skillPrefix = (skillId: string) => `org-1/skills/${skillId}/`;

const rowCounts = async () => {
  const skills = await pg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "skill"`,
  );
  const files = await pg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "skill_file"`,
  );
  return { skills: skills.rows[0].n, files: files.rows[0].n };
};

const read = (skillId: string, name: string, filePath: string) =>
  callTool(createReadSkillFileTool("org-1", "ws-1", [skillId]), {
    name,
    path: filePath,
  });

describe("importSkillBundle", () => {
  it("creates the Skill, its files and its preserved frontmatter", async () => {
    const row = await importSkillBundle(wsScope, pdfZip());

    expect(row).toMatchObject({
      name: "pdf",
      workspaceId: "ws-1",
      frontmatter: { license: "Proprietary" },
    });
    expect(await rowCounts()).toEqual({ skills: 1, files: 7 });
    expect(await storedUnder(skillPrefix(row.id))).toHaveLength(7);
  });

  it("reads every text file back by its bundle path", async () => {
    const row = await importSkillBundle(wsScope, pdfZip());

    for (const [filePath, content] of [
      ["forms.md", "# Forms"],
      ["Forms.md", "# Upper Forms"],
      ["My Notes.md", "notes"],
      ["日本.md", "unicode"],
      ["./LICENSE", "All rights reserved"],
    ]) {
      expect(await read(row.id, "pdf", filePath)).toEqual({
        path: filePath.replace("./", ""),
        content,
      });
    }
  });

  it("writes nothing for an invalid zip", async () => {
    const zip = zipSync({ "SKILL.md": strToU8("no frontmatter") });
    await expect(importSkillBundle(wsScope, zip)).rejects.toThrow(
      ValidationError,
    );
    expect(await rowCounts()).toEqual({ skills: 0, files: 0 });
    expect(await storedUnder("org-1/")).toEqual([]);
  });

  it("refuses a name already taken in the scope and removes what it stored", async () => {
    await importSkillBundle(wsScope, pdfZip());
    await expect(importSkillBundle(wsScope, pdfZip())).rejects.toMatchObject({
      cause: { code: "23505" },
    });
    expect(await rowCounts()).toEqual({ skills: 1, files: 7 });
    expect(await storedUnder("org-1/skills/")).toHaveLength(7);
  });

  it("exports a zip that re-imports to the same hash and file set", async () => {
    const row = await importSkillBundle(wsScope, pdfZip());
    const reparsed = parseSkillZip(await exportSkillBundle(row));

    expect(bundleHash(reparsed)).toBe(row.bundleHash);
    expect(reparsed.files.map((f) => f.path).sort()).toEqual(
      [
        "Forms.md",
        "LICENSE",
        "My Notes.md",
        "big.txt",
        "forms.md",
        "logo.png",
        "日本.md",
      ].sort(),
    );
  });

  it("fails an export as a server fault when storage has lost a file", async () => {
    const row = await importSkillBundle(wsScope, pdfZip());
    await fs.rm(
      path.join(process.env.STORAGE_DISK_PATH!, skillPrefix(row.id)),
      { recursive: true },
    );

    const error = await exportSkillBundle(row).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(NotFoundError);
    expect((error as Error).message).toMatch(/^Skill file missing/);
  });
});

describe("replaceSkillBundle", () => {
  it("swaps the bundle and leaves nothing under the old upload", async () => {
    const row = await importSkillBundle(wsScope, pdfZip());
    const [before] = await storedUploads(row.id);

    const replaced = await replaceSkillBundle(
      wsScope,
      row.id,
      zipSync({
        "SKILL.md": skillMd("pdf", "New body"),
        "only.md": strToU8("only"),
      }),
    );

    expect(replaced.body).toBe("New body");
    expect(replaced.bundleHash).not.toBe(row.bundleHash);
    expect(await storedUnder(`${skillPrefix(row.id)}${before}/`)).toEqual([]);
    expect(await read(row.id, "pdf", "only.md")).toEqual({
      path: "only.md",
      content: "only",
    });
    expect(await read(row.id, "pdf", "forms.md")).toEqual({
      error: "Skill 'pdf' has no file 'forms.md'",
    });
  });

  it("keeps every file readable when replaced with an identical zip", async () => {
    const row = await importSkillBundle(wsScope, pdfZip());
    const replaced = await replaceSkillBundle(wsScope, row.id, pdfZip());

    expect(replaced.bundleHash).toBe(row.bundleHash);
    expect(await storedUploads(row.id)).toHaveLength(1);
    expect(await read(row.id, "pdf", "forms.md")).toMatchObject({
      content: "# Forms",
    });
  });

  it("leaves the old bundle intact when the swap fails", async () => {
    await importSkillBundle(wsScope, pdfZip("taken"));
    const row = await importSkillBundle(wsScope, pdfZip());
    const uploads = await storedUploads(row.id);

    await expect(
      replaceSkillBundle(wsScope, row.id, pdfZip("taken")),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    expect(await storedUploads(row.id)).toEqual(uploads);
    expect(await read(row.id, "pdf", "forms.md")).toMatchObject({
      content: "# Forms",
    });
  });
});

/** The upload ids a Skill has files stored under. */
const storedUploads = async (skillId: string) =>
  fs
    .readdir(path.join(process.env.STORAGE_DISK_PATH!, skillPrefix(skillId)))
    .catch(() => []);

describe("Skill writes outside the bundle", () => {
  it("rehashes on a form edit and keeps the files readable", async () => {
    const row = await importSkillBundle(wsScope, pdfZip());
    const updated = await updateSkill(wsScope, row.id, {
      ...pdfFields,
      body: "Edited",
    });

    expect(updated.bundleHash).not.toBe(row.bundleHash);
    expect(await read(row.id, "pdf", "forms.md")).toMatchObject({
      content: "# Forms",
    });
  });

  it("deleting a Skill removes its stored files", async () => {
    const row = await importSkillBundle(wsScope, pdfZip());
    await deleteSkill(wsScope, row.id);
    expect(await storedUnder(skillPrefix(row.id))).toEqual([]);
  });

  it("deleting a Shared Skill removes its stored files", async () => {
    const row = await importSkillBundle(orgScope, pdfZip());
    await deleteSkill(orgScope, row.id);
    expect(await storedUnder(skillPrefix(row.id))).toEqual([]);
  });

  it("deleting a Workspace removes its Skills' stored files", async () => {
    const row = await importSkillBundle(wsScope, pdfZip());
    const cleanup = await prepareWorkspaceCleanup(ctx);
    await pg.exec(`DELETE FROM "workspace" WHERE "id" = 'ws-1'`);
    await cleanup();
    expect(await storedUnder(skillPrefix(row.id))).toEqual([]);
  });

  it("promoting a bundled Skill keeps its files readable", async () => {
    const row = await importSkillBundle(wsScope, pdfZip());
    await promoteScoped((await import("../index.ts")).db, {
      type: "skill",
      id: row.id,
      orgId: "org-1",
      workspaceId: "ws-1",
    });
    expect(await read(row.id, "pdf", "forms.md")).toMatchObject({
      content: "# Forms",
    });
  });

  it("upsertSkill refuses the name of a Shared bundled Skill", async () => {
    const row = await importSkillBundle(orgScope, pdfZip());
    await pg.exec(
      `INSERT INTO "attachment" ("id", "workspace_id", "resource_type", "resource_id") VALUES ('a-1', 'ws-1', 'skill', '${row.id}')`,
    );
    const tools = createSkillManagementTools("ws-1", "org-1", undefined);

    expect(
      await callTool(tools.upsertSkill, {
        name: "pdf",
        description: "d",
        body: "b",
      }),
    ).toEqual({ error: expect.stringContaining("bundled files") as unknown });
    expect(await rowCounts()).toEqual({ skills: 1, files: 7 });
  });

  it("upsertSkill on the Workspace's own bundled Skill rehashes and keeps the files", async () => {
    const row = await importSkillBundle(wsScope, pdfZip());
    const updated = await upsertSkill(ctx, {
      name: "pdf",
      description: "New",
      body: "New body",
    });

    expect(updated.id).toBe(row.id);
    expect(updated.bundleHash).not.toBe(row.bundleHash);
    expect(await read(row.id, "pdf", "forms.md")).toMatchObject({
      content: "# Forms",
    });
  });

  it("the deleteSkill Tool removes the Skill's stored files", async () => {
    const row = await importSkillBundle(wsScope, pdfZip());
    const tools = createSkillManagementTools("ws-1", "org-1", undefined);
    expect(await callTool(tools.deleteSkill, { name: "pdf" })).toEqual({
      success: true,
    });
    expect(await storedUnder(skillPrefix(row.id))).toEqual([]);
  });
});

describe("loadSkill and readSkillFile", () => {
  const load = (skillId: string, name: string, hasSandboxToolSet = false) =>
    callTool(
      createLoadSkillTool("org-1", "ws-1", [skillId], hasSandboxToolSet),
      { name },
    );

  it("lists a bundle's files", async () => {
    const row = await importSkillBundle(wsScope, pdfZip());
    const result = await load(row.id, "pdf");

    expect(result).toMatchObject({
      name: "pdf",
      body: "Read forms.md first.",
      note: expect.stringContaining("readSkillFile") as unknown,
    });
    expect((result as { files: unknown[] }).files).toContainEqual({
      path: "logo.png",
      isText: false,
    });
  });

  it("returns exactly { name, body } for a single-file Skill", async () => {
    const row = await importSkillBundle(
      wsScope,
      zipSync({ "SKILL.md": skillMd("solo") }),
    );
    expect(await load(row.id, "solo")).toEqual({
      name: "solo",
      body: "Read forms.md first.",
    });
  });

  it("seeds a slash command with the same result as loadSkill", async () => {
    const row = await importSkillBundle(wsScope, pdfZip());
    await pg.exec(
      `INSERT INTO "agent" ("id", "workspace_id", "provider_id", "name", "description", "model_id", "skill_ids") VALUES ('agent-1', 'ws-1', 'p-1', 'Helper', 'Helps', 'm', '["${row.id}"]')`,
    );
    const seeded = await seedUserInvokedSkill({
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "/pdf" }] },
      ],
      orgId: "org-1",
      workspaceId: "ws-1",
      agentId: "agent-1",
    });

    const part = seeded.at(-1)!.parts[0] as { output: unknown };
    expect(part.output).toEqual(await load(row.id, "pdf"));
  });

  it.each([
    ["a binary file", "logo.png", /binary file; using it needs a Sandbox/],
    ["a file over 1 MiB", "big.txt", /larger than the 1 MiB/],
    ["a missing path", "nope.md", /has no file 'nope\.md'/],
    ["a .. path", "../x.md", /'\.\.'/],
    ["an absolute path", "/forms.md", /absolute/],
  ])("errors on %s", async (_label, filePath, message) => {
    const row = await importSkillBundle(wsScope, pdfZip());
    const result = (await read(row.id, "pdf", filePath)) as { error: string };
    expect(result.error).toMatch(message);
  });

  it("errors on an unassigned Skill", async () => {
    await importSkillBundle(wsScope, pdfZip());
    expect(await read("other", "pdf", "forms.md")).toEqual({
      error: "Skill 'pdf' is not assigned to this agent",
    });
  });

  it("errors on a user-invocable-only Skill", async () => {
    const row = await importSkillBundle(wsScope, pdfZip());
    await updateSkill(wsScope, row.id, {
      ...pdfFields,
      disableModelInvocation: true,
    });
    expect(await read(row.id, "pdf", "forms.md")).toEqual({
      error: "Skill 'pdf' can only be invoked by a user",
    });
  });
});

describe("copying a bundled Skill into the Sandbox", () => {
  const load = (skillId: string, name: string, hasSandboxToolSet = true) =>
    callTool(
      createLoadSkillTool("org-1", "ws-1", [skillId], hasSandboxToolSet),
      { name },
    ) as Promise<{ directory?: string; note: string; files: unknown[] }>;

  const scriptsZip = (run = "#!/bin/sh\necho hi\n") =>
    zipSync({
      "tool/SKILL.md": skillMd("tool"),
      "tool/references/guide.md": strToU8("# Guide"),
      "tool/run": strToU8(run),
      "tool/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]),
    });

  it("writes SKILL.md and every bundled file under .platypus/skills/<name>/", async () => {
    await addSandbox();
    const row = await importSkillBundle(wsScope, scriptsZip());

    const result = await load(row.id, "tool");

    expect(result.directory).toBe(".platypus/skills/tool");
    expect(result.note).toContain(".platypus/skills/tool");
    expect(sandboxState.files.get(".platypus/skills/tool/SKILL.md")).toBe(
      "---\nname: tool\ndescription: Work with PDF files.\nlicense: Proprietary\n---\nRead forms.md first.",
    );
    expect(
      sandboxState.files.get(".platypus/skills/tool/references/guide.md"),
    ).toBe("# Guide");
    expect(sandboxState.files.has(".platypus/skills/tool/logo.png")).toBe(true);
    expect(sandboxState.executable).toEqual(
      new Set([".platypus/skills/tool/run"]),
    );
  });

  it("writes nothing on a second load of an unchanged bundle", async () => {
    await addSandbox();
    const row = await importSkillBundle(wsScope, scriptsZip());
    await load(row.id, "tool");
    const writes = sandboxState.writes;

    const again = await load(row.id, "tool");

    expect(sandboxState.writes).toBe(writes);
    expect(again.directory).toBe(".platypus/skills/tool");
  });

  it("rewrites the copy after Replace bundle, removing files no longer in it", async () => {
    await addSandbox();
    const row = await importSkillBundle(wsScope, scriptsZip());
    await load(row.id, "tool");

    await replaceSkillBundle(
      wsScope,
      row.id,
      zipSync({
        "tool/SKILL.md": skillMd("tool"),
        "tool/references/new.md": strToU8("# New"),
      }),
    );
    await load(row.id, "tool");

    expect(
      [...sandboxState.files.keys()]
        .filter((key) => key.startsWith(".platypus/skills/tool/"))
        .sort(),
    ).toEqual([
      ".platypus/skills/tool/SKILL.md",
      ".platypus/skills/tool/references/new.md",
    ]);
  });

  it("copies only text files to a backend without fsWriteBytes, naming the binaries it skipped", async () => {
    sandboxState.withBytes = false;
    await addSandbox();
    const row = await importSkillBundle(wsScope, scriptsZip());

    const result = await load(row.id, "tool");

    expect(sandboxState.files.has(".platypus/skills/tool/run")).toBe(true);
    expect(sandboxState.files.has(".platypus/skills/tool/logo.png")).toBe(
      false,
    );
    expect(result.note).toContain("logo.png");
  });

  it("copies nothing for an Agent without the sandbox Tool set, and says why", async () => {
    await addSandbox();
    const row = await importSkillBundle(wsScope, scriptsZip());

    const result = await load(row.id, "tool", false);

    expect(sandboxState.writes).toBe(0);
    expect(result.directory).toBeUndefined();
    expect(result.note).toMatch(/no Sandbox tools.*readSkillFile/);
  });

  it("says why when the Workspace has no Sandbox", async () => {
    const row = await importSkillBundle(wsScope, scriptsZip());
    const result = await load(row.id, "tool");
    expect(result.directory).toBeUndefined();
    expect(result.note).toMatch(/no Sandbox, .*readSkillFile/);
  });

  it("still returns the body and files when the Sandbox errors during the copy", async () => {
    sandboxState.failing = true;
    await addSandbox();
    const row = await importSkillBundle(wsScope, scriptsZip());

    const result = await load(row.id, "tool");

    expect(result).toMatchObject({
      name: "tool",
      body: "Read forms.md first.",
    });
    expect(result.files).toHaveLength(3);
    expect(result.directory).toBeUndefined();
    expect(result.note).toMatch(
      /could not be copied into the Sandbox this time/,
    );
  });

  it("copies a Skill invoked by slash command, exactly as loadSkill does", async () => {
    await addSandbox();
    const row = await importSkillBundle(wsScope, scriptsZip());
    await pg.exec(
      `INSERT INTO "agent" ("id", "workspace_id", "provider_id", "name", "description", "model_id", "skill_ids", "tool_set_ids") VALUES ('agent-1', 'ws-1', 'p-1', 'Helper', 'Helps', 'm', '["${row.id}"]', '["sandbox"]')`,
    );

    const seeded = await seedUserInvokedSkill({
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "/tool" }] },
      ],
      orgId: "org-1",
      workspaceId: "ws-1",
      agentId: "agent-1",
    });

    expect(sandboxState.files.has(".platypus/skills/tool/run")).toBe(true);
    const part = seeded.at(-1)!.parts[0] as { output: unknown };
    expect(part.output).toEqual(await load(row.id, "tool"));
  });

  it("never writes into .agents/skills or .claude/skills", async () => {
    await addSandbox();
    const row = await importSkillBundle(wsScope, scriptsZip());
    await load(row.id, "tool");
    expect(
      [...sandboxState.files.keys()].every((key) =>
        key.startsWith(".platypus/skills/"),
      ),
    ).toBe(true);
  });
});

describe("needsSandbox", () => {
  const bundleWith = (files: Record<string, Uint8Array>) =>
    importSkillBundle(
      wsScope,
      zipSync({
        "x/SKILL.md": skillMd("x"),
        ...Object.fromEntries(
          Object.entries(files).map(([path, data]) => [`x/${path}`, data]),
        ),
      }),
    );

  it.each([
    ["a file under scripts/", { "scripts/x.py": strToU8("print(1)") }],
    ["a root file starting with #!", { run: strToU8("#!/bin/sh\necho") }],
    ["a PNG", { "logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]) }],
  ])("is true for a bundle with %s", async (_label, files) => {
    expect((await bundleWith(files)).needsSandbox).toBe(true);
  });

  it("is false for a references-only bundle", async () => {
    const row = await bundleWith({ "references/a.md": strToU8("# A") });
    expect(row.needsSandbox).toBe(false);
  });

  it("follows the bundle through Replace bundle", async () => {
    const row = await bundleWith({ "references/a.md": strToU8("# A") });
    const replaced = await replaceSkillBundle(
      wsScope,
      row.id,
      zipSync({ "x/SKILL.md": skillMd("x"), "x/scripts/a.sh": strToU8("ls") }),
    );
    expect(replaced.needsSandbox).toBe(true);
  });

  it("warns, when not copied, that the Skill's scripts can't be used", async () => {
    const row = await bundleWith({ "scripts/x.py": strToU8("print(1)") });
    const result = (await callTool(
      createLoadSkillTool("org-1", "ws-1", [row.id], false),
      { name: "x" },
    )) as { note: string };
    expect(result.note).toContain("scripts and binary assets can't be used");
  });
});
