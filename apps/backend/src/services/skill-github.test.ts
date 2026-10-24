import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { strToU8, zipSync, type Zippable } from "fflate";
import { migratedPglite } from "../db/migrated-pglite.test-fixtures.ts";
import { resetStorage } from "../storage/index.ts";
import { mockNanoid } from "../test-setup.ts";
import { ValidationError } from "../errors.ts";

/**
 * Installing Skills from GitHub (ADR-0037) end to end against an in-process
 * Postgres and a disk StorageBackend, with GitHub played by a fake `fetch`:
 * what each request asks GitHub for, and what an install leaves behind.
 */
const { holder } = vi.hoisted(() => ({
  holder: { db: undefined as ReturnType<typeof drizzle> | undefined },
}));
vi.mock("../index.ts", () => ({
  get db() {
    return holder.db!;
  },
}));

const { previewGithubSkills, installGithubSkills, GITHUB_ARCHIVE_MAX_BYTES } =
  await import("./skill-github.ts");
const { replaceSkillBundle } = await import("./skill-bundle.ts");
const { updateSkill } = await import("./skill.ts");

let pg: PGlite;
beforeAll(async () => {
  const actual = await vi.importActual<typeof import("nanoid")>("nanoid");
  mockNanoid.mockImplementation(actual.nanoid);
  pg = await migratedPglite();
  holder.db = drizzle(pg);
}, 60_000);
afterAll(() => pg.close());

const ctx = { orgId: "org-1", workspaceId: "ws-1" };
const wsScope = { kind: "workspace", ctx } as const;
const orgScope = { kind: "organization", orgId: "org-1" } as const;

const SHA = "a".repeat(40);
const MOVED_SHA = "b".repeat(40);

const skillMd = (name: string, extra = "") =>
  strToU8(
    `---\nname: ${name}\ndescription: The ${name} skill.${extra}\n---\nUse ${name}.\n`,
  );

/** A repo as codeload zips it: everything under `<repo>-<sha>/`. */
const archive = (sha: string, files: Zippable): Uint8Array =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, data]) => [
        `skills-${sha}/${name}`,
        data,
      ]),
    ),
  );

const REPO: Zippable = {
  "README.md": strToU8("# Skills"),
  "skills/pdf/SKILL.md": skillMd("pdf"),
  "skills/pdf/forms.md": strToU8("# Forms"),
  "skills/pdf/scripts/fill.py": strToU8("print('fill')"),
  "skills/docx/SKILL.md": skillMd("docx"),
  "skills/xlsx/SKILL.md": skillMd("xlsx"),
  "skills/broken/SKILL.md": strToU8(
    "---\nname: broken\ndescription: a: b\n---\nx\n",
  ),
  "skills/linked/SKILL.md": skillMd("linked"),
  "skills/linked/data": [
    strToU8("/etc/passwd"),
    { os: 3, attrs: 0o120777 << 16 },
  ],
};

type Call = { url: string; headers: Headers };
let calls: Call[];
/** What each GitHub URL answers; the default branch is at `SHA`. */
let routes: Map<string, () => Response>;

const repoAt = (sha: string, files: Zippable) =>
  routes.set(
    `https://codeload.github.com/acme/skills/zip/${sha}`,
    () => new Response(Buffer.from(archive(sha, files))),
  );
const refAt = (ref: string, sha: string) =>
  routes.set(
    `https://api.github.com/repos/acme/skills/commits/${ref}`,
    () => new Response(sha),
  );

beforeEach(async () => {
  process.env.STORAGE_DISK_PATH = await fs.mkdtemp(
    path.join(os.tmpdir(), "platypus-skill-github-test-"),
  );
  resetStorage();
  delete process.env.GITHUB_TOKEN;
  calls = [];
  routes = new Map();
  refAt("HEAD", SHA);
  refAt("main", SHA);
  repoAt(SHA, REPO);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      return Promise.resolve(
        routes.get(url)?.() ?? new Response("Not Found", { status: 404 }),
      );
    }),
  );
  await pg.exec(`
    DELETE FROM "organization";
    DELETE FROM "user";
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at") VALUES
      ('u-1', 'Olive', 'olive@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name") VALUES
      ('ws-1', 'org-1', 'u-1', 'Support');
  `);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(process.env.STORAGE_DISK_PATH!, { recursive: true, force: true });
  delete process.env.STORAGE_DISK_PATH;
  delete process.env.GITHUB_TOKEN;
  resetStorage();
});

const skillRows = async () =>
  (
    await pg.query<{ name: string }>(`SELECT name FROM "skill" ORDER BY name`)
  ).rows.map((row) => row.name);

describe("previewGithubSkills", () => {
  it("lists every Skill under the path at the commit the ref resolves to", async () => {
    const preview = await previewGithubSkills(wsScope, "acme/skills");

    expect(preview).toMatchObject({
      owner: "acme",
      repo: "skills",
      ref: null,
      path: "",
      commitSha: SHA,
    });
    const pdf = preview.skills.find((s) => s.skillPath === "skills/pdf");
    expect(pdf).toEqual({
      skillPath: "skills/pdf",
      name: "pdf",
      description: "The pdf skill.",
      body: "Use pdf.",
      files: [
        { path: "forms.md", size: 7 },
        { path: "scripts/fill.py", size: 13 },
      ],
      needsSandbox: true,
      error: null,
      taken: false,
    });
    expect(preview.skills.map((s) => s.skillPath).sort()).toEqual([
      "skills/broken",
      "skills/docx",
      "skills/linked",
      "skills/pdf",
      "skills/xlsx",
    ]);
    expect(
      preview.skills.find((s) => s.skillPath === "skills/broken")?.error,
    ).toMatch(/Frontmatter is not valid YAML at line 3/);
    expect(
      preview.skills.find((s) => s.skillPath === "skills/linked")?.error,
    ).toBe("Skill contains a symlink: data");
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/acme/skills/commits/HEAD",
      `https://codeload.github.com/acme/skills/zip/${SHA}`,
    ]);
  });

  it("reads a tree URL and the shorthand alike", async () => {
    const fromUrl = await previewGithubSkills(
      wsScope,
      "https://github.com/acme/skills/tree/main/skills/pdf",
    );
    const fromShorthand = await previewGithubSkills(
      wsScope,
      "acme/skills/skills/pdf@main",
    );
    expect(fromUrl).toEqual(fromShorthand);
    expect(fromUrl).toMatchObject({ ref: "main", path: "skills/pdf" });
    expect(fromUrl.skills.map((s) => s.skillPath)).toEqual(["skills/pdf"]);
  });

  it("flags a name already taken in the scope", async () => {
    await installGithubSkills(orgScope, {
      owner: "acme",
      repo: "skills",
      ref: null,
      commitSha: SHA,
      skillPaths: ["skills/docx"],
    });
    const preview = await previewGithubSkills(orgScope, "acme/skills/skills");
    expect(
      preview.skills.filter((s) => s.taken).map((s) => s.skillPath),
    ).toEqual(["skills/docx"]);
  });

  it.each([
    "acme/../etc",
    "acme/skills/../../x",
    "acme/skills@../main",
    "https://evil.example/acme/skills",
    "ftp://github.com/acme/skills",
    "acme",
    "-acme/skills",
    "acme/sk ills",
    "acme/skills@ma\u0001in",
    "acme/skills//etc",
  ])("rejects %j with a 400 before any request", async (source) => {
    await expect(previewGithubSkills(wsScope, source)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(calls).toEqual([]);
  });

  it("names a repo, ref or path that doesn't exist", async () => {
    await expect(previewGithubSkills(wsScope, "acme/nope")).rejects.toThrow(
      "Repository acme/nope not found",
    );
    routes.set(
      "https://api.github.com/repos/acme/skills/commits/gone",
      () => new Response("{}", { status: 422 }),
    );
    await expect(
      previewGithubSkills(wsScope, "acme/skills@gone"),
    ).rejects.toThrow('Ref "gone" not found in acme/skills');
    await expect(
      previewGithubSkills(wsScope, "acme/skills/no/such"),
    ).rejects.toThrow('Path "no/such" not found in acme/skills');
  });

  it("aborts an archive over 100 MiB with a 400", async () => {
    const MiB = 1024 * 1024;
    routes.set(
      `https://codeload.github.com/acme/skills/zip/${SHA}`,
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(MiB));
            },
          }),
        ),
    );
    expect(GITHUB_ARCHIVE_MAX_BYTES).toBe(100 * MiB);
    await expect(previewGithubSkills(wsScope, "acme/skills")).rejects.toThrow(
      "The repository archive is larger than 100 MiB",
    );
  });

  it("turns a GitHub rate limit into a 429 naming the reset time", async () => {
    routes.set(
      "https://api.github.com/repos/acme/skills/commits/HEAD",
      () =>
        new Response("{}", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1800000000",
          },
        }),
    );
    const preview = previewGithubSkills(wsScope, "acme/skills");
    await expect(preview).rejects.toMatchObject({ name: "RateLimitError" });
    await expect(preview).rejects.toThrow(
      /2027-01-15T08:00:00\.000Z.*GITHUB_TOKEN/,
    );

    process.env.GITHUB_TOKEN = "ghp_test";
    await expect(previewGithubSkills(wsScope, "acme/skills")).rejects.toThrow(
      /^(?!.*GITHUB_TOKEN)/,
    );
  });

  it("sends GITHUB_TOKEN to api.github.com only", async () => {
    await previewGithubSkills(wsScope, "acme/skills");
    expect(calls.every((c) => !c.headers.has("authorization"))).toBe(true);

    calls = [];
    process.env.GITHUB_TOKEN = "ghp_test";
    await previewGithubSkills(wsScope, "acme/skills");
    expect(calls.map((c) => c.headers.get("authorization"))).toEqual([
      "Bearer ghp_test",
      null,
    ]);
  });

  it("follows no redirect off the allowlist", async () => {
    routes.set(
      `https://codeload.github.com/acme/skills/zip/${SHA}`,
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/archive.zip" },
        }),
    );
    await expect(previewGithubSkills(wsScope, "acme/skills")).rejects.toThrow(
      /evil\.example/,
    );
    expect(calls.map((c) => new URL(c.url).host)).toEqual([
      "api.github.com",
      "codeload.github.com",
    ]);
  });

  it("follows a redirect within the allowlist", async () => {
    routes.set(
      "https://api.github.com/repos/acme/skills/commits/HEAD",
      () =>
        new Response(null, {
          status: 301,
          headers: {
            location: "https://api.github.com/repositories/1/commits/HEAD",
          },
        }),
    );
    routes.set(
      "https://api.github.com/repositories/1/commits/HEAD",
      () => new Response(SHA),
    );
    const preview = await previewGithubSkills(wsScope, "acme/skills");
    expect(preview.commitSha).toBe(SHA);
  });
});

describe("installGithubSkills", () => {
  it("installs each Skill on its own, at the previewed commit", async () => {
    // The ref moved after the preview: the install still takes `SHA`.
    refAt("HEAD", MOVED_SHA);
    repoAt(MOVED_SHA, { "skills/pdf/SKILL.md": skillMd("pdf-moved") });
    await installGithubSkills(wsScope, {
      owner: "acme",
      repo: "skills",
      ref: null,
      commitSha: SHA,
      skillPaths: ["skills/docx"],
    });

    const result = await installGithubSkills(wsScope, {
      owner: "acme",
      repo: "skills",
      ref: "main",
      commitSha: SHA,
      skillPaths: [
        "skills/pdf",
        "skills/docx",
        "skills/xlsx",
        "skills/broken",
        "skills/nope",
      ],
    });

    expect(result.results).toEqual([
      expect.objectContaining({
        skillPath: "skills/pdf",
        status: 201,
        name: "pdf",
      }),
      {
        skillPath: "skills/docx",
        status: 409,
        name: "docx",
        error: "A resource with that name already exists",
      },
      expect.objectContaining({ skillPath: "skills/xlsx", status: 201 }),
      {
        skillPath: "skills/broken",
        status: 400,
        error: expect.stringMatching(/not valid YAML/) as unknown,
      },
      {
        skillPath: "skills/nope",
        status: 404,
        error: "No Skill at skills/nope",
      },
    ]);
    expect(await skillRows()).toEqual(["docx", "pdf", "xlsx"]);
    expect(calls.map((c) => c.url)).not.toContain(
      `https://codeload.github.com/acme/skills/zip/${MOVED_SHA}`,
    );
    expect(calls.some((c) => c.url.startsWith("https://api.github.com"))).toBe(
      false,
    );

    const { rows } = await pg.query<Record<string, unknown>>(
      `SELECT * FROM "skill" WHERE name = 'pdf'`,
    );
    expect(rows[0]).toMatchObject({
      workspace_id: "ws-1",
      needs_sandbox: true,
      source_type: "github",
      source: "acme/skills",
      ref: "main",
      skill_path: "skills/pdf",
      commit_sha: SHA,
      installed_hash: rows[0].bundle_hash,
    });
    const files = await pg.query(
      `SELECT path FROM "skill_file" WHERE skill_id = $1 ORDER BY path`,
      [result.results[0].skillId],
    );
    expect(files.rows).toEqual([
      { path: "forms.md" },
      { path: "scripts/fill.py" },
    ]);
  });

  it("creates a Shared Skill at Organization scope", async () => {
    await installGithubSkills(orgScope, {
      owner: "acme",
      repo: "skills",
      ref: null,
      commitSha: SHA,
      skillPaths: ["skills/pdf"],
    });
    const { rows } = await pg.query(
      `SELECT organization_id, workspace_id, ref FROM "skill"`,
    );
    expect(rows).toEqual([
      { organization_id: "org-1", workspace_id: null, ref: null },
    ]);
  });

  it("keeps the source record through a form edit; Replace bundle clears it", async () => {
    const { results } = await installGithubSkills(wsScope, {
      owner: "acme",
      repo: "skills",
      ref: null,
      commitSha: SHA,
      skillPaths: ["skills/docx"],
    });
    const id = results[0].skillId!;

    const edited = await updateSkill(wsScope, id, {
      name: "docx",
      description: "The docx skill.",
      body: "Edited.",
    });
    expect(edited).toMatchObject({ source: "acme/skills", commitSha: SHA });

    const replaced = await replaceSkillBundle(
      wsScope,
      id,
      zipSync({ "SKILL.md": skillMd("docx") }),
    );
    expect(replaced).toMatchObject({
      sourceType: null,
      source: null,
      ref: null,
      skillPath: null,
      commitSha: null,
      installedHash: null,
    });
  });
});
