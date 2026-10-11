import { and, asc, eq, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, type Tx } from "../index.ts";
import {
  skill as skillTable,
  skillFile as skillFileTable,
} from "../db/schema.ts";
import { NotFoundError } from "../errors.ts";
import { getStorage } from "../storage/index.ts";
import { skillStorageKeyPrefix } from "../storage/keys.ts";
import { deleteStoredPrefix } from "../storage/utils.ts";
import {
  bundleHash,
  bundleNeedsSandbox,
  buildSkillZip,
  parseSkillZip,
  type SkillBundleFields,
  type SkillBundleFile,
} from "./skill-bundle-format.ts";
import {
  orgScopedWhere,
  requireOrgScoped,
  requireWorkspaceMutable,
  workspaceScopedWhere,
  type Database,
} from "./scoped-resource.ts";
import type { SkillRow, SkillScope } from "./skill.ts";

/**
 * A Skill's bundle (ADR-0036): `SKILL.md` on the `skill` row, every other file
 * a `skill_file` row whose bytes sit in the StorageBackend. This module is the
 * one place bytes are written or read for it — import, Replace bundle, export —
 * and what the model-facing Skill Tools read files through.
 *
 * ponytail: every Skill owns its bytes, so the same zip in two Workspaces is
 * stored twice. Content addressing (keys by sha256, reference-counted delete)
 * is the upgrade path if storage cost ever matters.
 */

export type SkillFileRow = typeof skillFileTable.$inferSelect;

type Executor = Database | Tx;

/**
 * Every file is stored as `application/octet-stream`, whatever it contains, so
 * a bundled `.html` or `.svg` can never be served inline from the deployment's
 * origin.
 */
export const SKILL_FILE_CONTENT_TYPE = "application/octet-stream";

const orgIdOf = (scope: SkillScope) =>
  scope.kind === "workspace" ? scope.ctx.orgId : scope.orgId;

/** The scope columns a new Skill row is inserted with. */
export const scopeColumnsOf = (scope: SkillScope) =>
  scope.kind === "workspace"
    ? { workspaceId: scope.ctx.workspaceId, organizationId: null }
    : { organizationId: scope.orgId, workspaceId: null };

/**
 * The `where` that writes one Skill at `scope`, once it is known to be
 * writable there. At Workspace scope a Shared Skill is a single source of
 * truth edited only on the Organization surface (ADR-0007):
 * `requireWorkspaceMutable` throws NotFound (→404) when the Skill is not
 * visible here, then Locked (→403) when it is org-scoped. At Organization
 * scope `requireOrgScoped` throws NotFound (→404) before the write ever runs
 * (#605).
 */
export const writableSkillWhere = async (
  scope: SkillScope,
  skillId: string,
): Promise<SQL> => {
  if (scope.kind === "workspace") {
    await requireWorkspaceMutable(db, "skill", skillId, scope.ctx);
    return workspaceScopedWhere("skill", skillId, scope.ctx.workspaceId);
  }
  await requireOrgScoped(db, "skill", skillId, scope.orgId);
  return orgScopedWhere("skill", skillId, scope.orgId);
};

/** The mapped fields of a row, or of a create, as the bundle hash sees them. */
export const fieldsOf = (row: {
  name: string;
  description: string;
  body: string;
  disableModelInvocation?: boolean;
  argumentHint?: string | null;
}): SkillBundleFields => ({
  name: row.name,
  description: row.description,
  body: row.body,
  disableModelInvocation: row.disableModelInvocation ?? false,
  argumentHint: row.argumentHint ?? null,
});

/** A Skill's bundled files, by path. */
export const listSkillFiles = (
  database: Executor,
  skillId: string,
): Promise<SkillFileRow[]> =>
  database
    .select()
    .from(skillFileTable)
    .where(eq(skillFileTable.skillId, skillId))
    .orderBy(asc(skillFileTable.path));

/** The bundle hash of a row as it now stands, with the files it holds. */
export const hashSkillRow = async (
  database: Executor,
  row: SkillRow,
): Promise<string> =>
  bundleHash({
    fields: fieldsOf(row),
    frontmatter: row.frontmatter,
    files: await listSkillFiles(database, row.id),
  });

/**
 * Recomputes and stores a row's bundle hash after a write that changed its
 * body or mapped fields, keeping its files.
 */
export const rehashSkill = async (
  database: Executor,
  row: SkillRow,
): Promise<SkillRow> => {
  const [updated] = await database
    .update(skillTable)
    .set({ bundleHash: await hashSkillRow(database, row) })
    .where(eq(skillTable.id, row.id))
    .returning();
  return updated;
};

/**
 * Writes a bundle's files under a fresh upload prefix, and returns the
 * `skill_file` rows to insert. A fresh `uploadId` per write is what lets an
 * identical Replace leave the live files alone until its rows have swapped. If
 * any write fails, whatever was written is removed and the error rethrown.
 */
const storeFiles = async (
  orgId: string,
  skillId: string,
  files: SkillBundleFile[],
): Promise<{ prefix: string; rows: SkillFileRow[] }> => {
  const prefix = `${skillStorageKeyPrefix({ orgId, skillId })}${nanoid()}/`;
  const now = new Date();
  try {
    const rows = await Promise.all(
      files.map(async (file) => {
        const storageKey = `${prefix}${nanoid()}`;
        await getStorage().put(
          storageKey,
          Buffer.from(file.data),
          SKILL_FILE_CONTENT_TYPE,
        );
        return {
          id: nanoid(),
          skillId,
          path: file.path,
          size: file.size,
          sha256: file.sha256,
          isText: file.isText,
          storageKey,
          createdAt: now,
        };
      }),
    );
    return { prefix, rows };
  } catch (error) {
    await deleteStoredPrefix(prefix);
    throw error;
  }
};

/**
 * Creates a new Skill from an uploaded zip. Everything is validated before
 * anything is written (a `ValidationError` names the rule), and a name already
 * taken in the scope surfaces as a unique violation (→409, ADR-0010) with the
 * stored files removed again.
 */
export async function importSkillBundle(
  scope: SkillScope,
  zip: Uint8Array,
): Promise<SkillRow> {
  const bundle = parseSkillZip(zip);
  const id = nanoid();
  const { prefix, rows } = await storeFiles(orgIdOf(scope), id, bundle.files);
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(skillTable)
        .values({
          id,
          ...bundle.fields,
          frontmatter: bundle.frontmatter,
          bundleHash: bundleHash(bundle),
          needsSandbox: bundleNeedsSandbox(bundle.files),
          ...scopeColumnsOf(scope),
        })
        .returning();
      if (rows.length > 0) await tx.insert(skillFileTable).values(rows);
      return row;
    });
  } catch (error) {
    await deleteStoredPrefix(prefix);
    throw error;
  }
}

/** The upload prefixes a set of stored files sit under. */
const uploadPrefixesOf = (rows: { storageKey: string }[]) =>
  new Set(
    rows.map(({ storageKey }) =>
      storageKey.slice(0, storageKey.lastIndexOf("/") + 1),
    ),
  );

/**
 * Replaces an existing Skill's whole bundle — mapped fields, frontmatter, body
 * and files — from an uploaded zip. The new files go under a new upload prefix
 * and the rows swap in one transaction; only then is the old prefix deleted. A
 * failed swap deletes the new prefix instead, leaving the old bundle intact. At
 * Workspace scope a Shared Skill is locked (ADR-0007), as for any edit.
 */
export async function replaceSkillBundle(
  scope: SkillScope,
  skillId: string,
  zip: Uint8Array,
): Promise<SkillRow> {
  const where = await writableSkillWhere(scope, skillId);
  const bundle = parseSkillZip(zip);
  const { prefix, rows } = await storeFiles(
    orgIdOf(scope),
    skillId,
    bundle.files,
  );
  let replaced: { row: SkillRow; old: SkillFileRow[] };
  try {
    replaced = await db.transaction(async (tx) => {
      const old = await tx
        .delete(skillFileTable)
        .where(eq(skillFileTable.skillId, skillId))
        .returning();
      const [row] = await tx
        .update(skillTable)
        .set({
          ...bundle.fields,
          frontmatter: bundle.frontmatter,
          bundleHash: bundleHash(bundle),
          needsSandbox: bundleNeedsSandbox(bundle.files),
          updatedAt: new Date(),
        })
        .where(where)
        .returning();
      if (!row) throw new NotFoundError("Skill not found");
      if (rows.length > 0) await tx.insert(skillFileTable).values(rows);
      return { row, old };
    });
  } catch (error) {
    await deleteStoredPrefix(prefix);
    throw error;
  }

  for (const old of uploadPrefixesOf(replaced.old)) {
    await deleteStoredPrefix(old);
  }
  return replaced.row;
}

/** A stored file's bytes, or `null` where storage no longer holds them. */
export const readStoredSkillFile = async (
  file: SkillFileRow,
): Promise<Buffer | null> =>
  (await getStorage().get(file.storageKey))?.data ?? null;

/**
 * The zip an export downloads. See `buildSkillZip`. A `skill_file` row whose
 * bytes storage no longer holds is a server fault (→500), not a missing Skill.
 */
export async function exportSkillBundle(row: SkillRow): Promise<Uint8Array> {
  const files = await Promise.all(
    (await listSkillFiles(db, row.id)).map(async (file) => {
      const data = await readStoredSkillFile(file);
      if (!data) throw new Error(`Skill file missing: ${file.path}`);
      return { path: file.path, data };
    }),
  );
  return buildSkillZip({
    fields: fieldsOf(row),
    frontmatter: row.frontmatter,
    files,
  });
}

/** One of a Skill's bundled files, or `NotFoundError`. */
export const requireSkillFile = async (
  skillId: string,
  fileId: string,
): Promise<SkillFileRow> => {
  const [file] = await db
    .select()
    .from(skillFileTable)
    .where(
      and(eq(skillFileTable.skillId, skillId), eq(skillFileTable.id, fileId)),
    )
    .limit(1);
  if (!file) throw new NotFoundError("Skill file not found");
  return file;
};

/** One of a Skill's bundled files by its path in the bundle, if it has one. */
export const findSkillFileByPath = async (
  skillId: string,
  path: string,
): Promise<SkillFileRow | undefined> => {
  const [file] = await db
    .select()
    .from(skillFileTable)
    .where(
      and(eq(skillFileTable.skillId, skillId), eq(skillFileTable.path, path)),
    )
    .limit(1);
  return file;
};

/**
 * One bundled file's bytes and download name, or `NotFoundError` when the
 * Skill has no such file. The caller has already established the Skill is
 * visible. A row whose bytes storage no longer holds is a server fault (→500).
 */
export const downloadSkillFile = async (
  skillId: string,
  fileId: string,
): Promise<{ data: Buffer; filename: string }> => {
  const file = await requireSkillFile(skillId, fileId);
  const data = await readStoredSkillFile(file);
  if (!data) throw new Error(`Skill file missing: ${file.path}`);
  return { data, filename: file.path.split("/").at(-1)! };
};

/** A Skill's files as the API returns them: no storage key. */
export const skillFilesForApi = async (skillId: string) =>
  (await listSkillFiles(db, skillId)).map(
    ({ id, path, size, sha256, isText }) => ({
      id,
      path,
      size,
      sha256,
      isText,
    }),
  );
