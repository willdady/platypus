import type {
  SandboxBackend,
  SandboxCallOptions,
  SandboxContext,
} from "@platypuschat/plugin-sdk";
import { logger } from "../logger.ts";
import { openSandboxRow } from "../sandbox/open-row.ts";
import { buildSkillMd, startsWithShebang } from "./skill-bundle-format.ts";
import {
  fieldsOf,
  hashSkillRow,
  listSkillFiles,
  readStoredSkillFile,
  type SkillFileRow,
} from "./skill-bundle.ts";
import type { Database } from "./scoped-resource.ts";
import type { SkillRow } from "./skill.ts";
import { resolveOwned } from "./workspace-resource.ts";

/**
 * Copies a bundled Skill into the Workspace's Sandbox when it is loaded
 * (ADR-0036). The copy is a cache of the stored bundle: a hash manifest says
 * which bundle it holds, and anything else is rewritten from scratch.
 */

/** Where a Skill's copy sits, relative to the Sandbox root. */
export const skillSandboxDirectory = (name: string) =>
  `.platypus/skills/${name}`;

// Skill names never start with `.`, so no Skill's directory is ever this one.
const manifestPath = (name: string) => `.platypus/skills/.hashes/${name}`;

/** What a load needs to copy a Skill into the Sandbox, if it may. */
export type SkillSandboxAccess = {
  workspaceId: string;
  hasSandboxToolSet: boolean;
  signal?: AbortSignal;
};

type SkillNotCopiedReason = "no-toolset" | "no-sandbox" | "failed";

type SkillCopyOutcome =
  | { kind: "copied"; directory: string; skipped: string[] }
  | { kind: "not-copied"; reason: SkillNotCopiedReason };

const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const exec = async (
  backend: SandboxBackend,
  ctx: SandboxContext,
  command: string,
  options: SandboxCallOptions,
) => {
  const result = await backend.shellExec(ctx, { command }, options);
  if (result.exitCode !== 0) {
    throw new Error(`'${command}' exited ${result.exitCode}: ${result.stderr}`);
  }
};

/**
 * Brings the Sandbox's copy up to date and returns the files it had to leave
 * out. One read when the manifest matches; otherwise the directory is removed
 * and rewritten, and the manifest written last so a copy that fails part way
 * is retried on the next load.
 */
const syncSkill = async (
  database: Database,
  backend: SandboxBackend,
  ctx: SandboxContext,
  row: SkillRow,
  files: SkillFileRow[],
  options: SandboxCallOptions,
): Promise<string[]> => {
  const writeBytes = backend.fsWriteBytes?.bind(backend);
  const skipped = writeBytes
    ? []
    : files.filter((file) => !file.isText).map((file) => file.path);
  // A text-only copy is a different copy: the same bundle copied later to a
  // backend that can take bytes must be rewritten with its binaries.
  const hash = row.bundleHash ?? (await hashSkillRow(database, row));
  const stamp = writeBytes ? hash : `${hash} text-only`;
  const manifest = manifestPath(row.name);

  try {
    const current = await backend.fsRead(ctx, { path: manifest }, options);
    if (current.content === stamp) return skipped;
  } catch {
    // No manifest yet: nothing has been copied.
  }

  const directory = skillSandboxDirectory(row.name);
  await exec(backend, ctx, `rm -rf -- ${shQuote(directory)}`, options);
  await backend.fsWrite(
    ctx,
    {
      path: `${directory}/SKILL.md`,
      content: buildSkillMd({
        fields: fieldsOf(row),
        frontmatter: row.frontmatter,
      }),
      mode: "overwrite",
    },
    options,
  );

  const executable: string[] = [];
  // ponytail: one write at a time; a bundle holds at most 500 files.
  for (const file of files) {
    if (!file.isText && !writeBytes) continue;
    const data = await readStoredSkillFile(file);
    if (!data) throw new Error(`Skill file missing: ${file.path}`);
    const path = `${directory}/${file.path}`;
    if (writeBytes) {
      await writeBytes(ctx, { path, bytes: data }, options);
    } else {
      await backend.fsWrite(
        ctx,
        { path, content: data.toString("utf8"), mode: "overwrite" },
        options,
      );
    }
    if (file.isText && startsWithShebang(data)) executable.push(path);
  }
  if (executable.length > 0) {
    await exec(
      backend,
      ctx,
      `chmod +x -- ${executable.map(shQuote).join(" ")}`,
      options,
    );
  }

  await backend.fsWrite(
    ctx,
    { path: manifest, content: stamp, mode: "overwrite" },
    options,
  );
  return skipped;
};

/**
 * Copies a bundled Skill into the Workspace's Sandbox, where the Agent has the
 * `sandbox` Tool set and the Workspace has a Sandbox. Never throws: a Sandbox
 * that is stopped or errors is a `failed` outcome, and the load goes on.
 */
const copySkillToSandbox = async (
  database: Database,
  row: SkillRow,
  files: SkillFileRow[],
  access: SkillSandboxAccess,
): Promise<SkillCopyOutcome> => {
  if (!access.hasSandboxToolSet) {
    return { kind: "not-copied", reason: "no-toolset" };
  }
  const sandbox = await resolveOwned(database, "sandbox", {
    workspaceId: access.workspaceId,
  });
  if (!sandbox) return { kind: "not-copied", reason: "no-sandbox" };

  let backend: SandboxBackend | undefined;
  try {
    const opened = await openSandboxRow(sandbox, "copy a skill into it");
    backend = opened.backend;
    const skipped = await syncSkill(database, backend, opened.ctx, row, files, {
      signal: access.signal ?? new AbortController().signal,
    });
    return {
      kind: "copied",
      directory: skillSandboxDirectory(row.name),
      skipped,
    };
  } catch (err) {
    logger.warn(
      { err, skillId: row.id, sandboxId: sandbox.id },
      "Could not copy a skill into the Sandbox",
    );
    return { kind: "not-copied", reason: "failed" };
  } finally {
    await backend?.close?.();
  }
};

/** What `loadSkill` returns, and what a slash command seeds. */
export type SkillLoadResult =
  | { name: string; body: string }
  | {
      name: string;
      body: string;
      files: { path: string; isText: boolean }[];
      /** Where the Sandbox copy is, when the Skill was copied into one. */
      directory?: string;
      note: string;
    };

const READ_SKILL_FILE_NOTE =
  "Read a text file with the readSkillFile tool, passing its path relative to the skill's root.";

const NOT_COPIED_REASONS: Record<SkillNotCopiedReason, string> = {
  "no-toolset":
    "This agent has no Sandbox tools, so the skill was not copied into a Sandbox.",
  "no-sandbox":
    "This workspace has no Sandbox, so the skill was not copied into one.",
  failed: "The skill could not be copied into the Sandbox this time.",
};

const loadNote = (copy: SkillCopyOutcome, needsSandbox: boolean): string => {
  if (copy.kind === "copied") {
    const skipped =
      copy.skipped.length > 0
        ? ` These binary files could not be copied, because this Sandbox only takes text files: ${copy.skipped.join(", ")}.`
        : "";
    return `This skill's files are copied into the Sandbox at ${copy.directory}; relative paths in the skill resolve against that directory.${skipped}`;
  }
  const warning = needsSandbox
    ? " This skill's scripts and binary assets can't be used here."
    : "";
  return `${NOT_COPIED_REASONS[copy.reason]} ${READ_SKILL_FILE_NOTE}${warning}`;
};

/**
 * The one builder of a loaded Skill's result, called by both `loadSkill` and
 * slash-command seeding so the two cannot drift — including the copy into the
 * Sandbox, which happens here and only here. A Skill with no bundled files
 * keeps exactly the `{ name, body }` it always had, and copies nothing.
 */
export const skillLoadResult = async (
  database: Database,
  row: SkillRow,
  access: SkillSandboxAccess,
): Promise<SkillLoadResult> => {
  const files = await listSkillFiles(database, row.id);
  if (files.length === 0) return { name: row.name, body: row.body };
  const copy = await copySkillToSandbox(database, row, files, access);
  return {
    name: row.name,
    body: row.body,
    files: files.map(({ path, isText }) => ({ path, isText })),
    ...(copy.kind === "copied" && { directory: copy.directory }),
    note: loadNote(copy, row.needsSandbox),
  };
};
