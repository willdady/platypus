import crypto from "node:crypto";
import { Inflate, strToU8, zipSync } from "fflate";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { skillBaseSchema } from "@platypus/schemas";
import { ValidationError } from "../errors.ts";

/**
 * The on-the-wire shape of a Skill bundle (ADR-0036): reading an uploaded zip
 * into validated fields, preserved frontmatter and files, and writing one back
 * out. Pure — no database, no storage — so every rule here is checked before
 * anything is written.
 */

const MiB = 1024 * 1024;

/** The largest zip a request may carry. */
export const SKILL_ZIP_MAX_BYTES = 10 * MiB;
/** The most a bundle may decompress to, counted from the bytes actually inflated. */
export const SKILL_BUNDLE_MAX_UNPACKED_BYTES = 25 * MiB;
/** The most entries a zip may list, directories included. */
export const SKILL_BUNDLE_MAX_ENTRIES = 500;
/** The largest frontmatter block `SKILL.md` may open with. */
export const SKILL_FRONTMATTER_MAX_BYTES = 16 * 1024;

/** The `SKILL.md` frontmatter keys stored as columns rather than kept as-is. */
const MAPPED_KEYS = {
  name: "name",
  description: "description",
  "disable-model-invocation": "disableModelInvocation",
  "argument-hint": "argumentHint",
} as const;

export type SkillBundleFields = {
  name: string;
  description: string;
  body: string;
  disableModelInvocation: boolean;
  argumentHint: string | null;
};

export type SkillBundleFile = {
  path: string;
  data: Uint8Array;
  size: number;
  sha256: string;
  isText: boolean;
};

export type ParsedSkillBundle = {
  fields: SkillBundleFields;
  /** Every frontmatter key not mapped to a column, kept as-is. */
  frontmatter: Record<string, unknown>;
  /** Every file but `SKILL.md`, at its bundle-root-relative path. */
  files: SkillBundleFile[];
};

const fail = (message: string): never => {
  throw new ValidationError(message);
};

/**
 * A bundle path in its one canonical form: empty and `.` segments dropped.
 * Rejects what could name something outside the bundle — absolute paths, `..`,
 * backslashes — rather than repairing it. Shared with `readSkillFile`, so the
 * model addresses a file by the same path the import stored it under.
 */
export const normaliseBundlePath = (raw: string): string => {
  if (raw.includes("\0")) fail(`Path contains a NUL character: ${raw}`);
  if (raw.includes("\\")) fail(`Path contains a backslash: ${raw}`);
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    fail(`Path is absolute: ${raw}`);
  }
  const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) fail(`Path contains '..': ${raw}`);
  return segments.join("/");
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Text is decided by content, never extension: no NUL in the first 8 KB, and strict UTF-8. */
export const isTextContent = (bytes: Uint8Array): boolean => {
  if (bytes.subarray(0, 8192).includes(0)) return false;
  try {
    utf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
};

export const sha256Hex = (data: Uint8Array | string): string =>
  crypto.createHash("sha256").update(data).digest("hex");

type ZipEntry = {
  name: string;
  isDirectory: boolean;
  data: Uint8Array;
};

/**
 * Reads every entry's bytes out of a zip, counting the bytes actually inflated
 * against the unpacked cap. The sizes a zip declares are never trusted: input is
 * fed to the inflater in small chunks, so even a maximal-ratio entry overshoots
 * the cap by at most about a megabyte before it is refused.
 */
const readZipEntries = (zip: Uint8Array): ZipEntry[] => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);

  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail("File is not a valid zip archive");

  const count = u16(eocd + 10);
  let offset = u32(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    fail("ZIP64 archives are not supported");
  }
  if (count > SKILL_BUNDLE_MAX_ENTRIES) {
    fail(`Zip has more than ${SKILL_BUNDLE_MAX_ENTRIES} entries`);
  }

  let unpacked = 0;
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (offset + 46 > zip.length || u32(offset) !== 0x02014b50) {
      fail("File is not a valid zip archive");
    }
    const madeByOs = u16(offset + 4) >> 8;
    const flags = u16(offset + 8);
    const method = u16(offset + 10);
    const compressedSize = u32(offset + 20);
    const nameLength = u16(offset + 28);
    const extraLength = u16(offset + 30);
    const commentLength = u16(offset + 32);
    const mode = u32(offset + 38) >>> 16;
    const localOffset = u32(offset + 42);
    const nameBytes = zip.subarray(offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    let name: string;
    try {
      name = utf8.decode(nameBytes);
    } catch {
      name = fail("Zip entry name is not valid UTF-8");
    }
    if (madeByOs === 3 && (mode & 0o170000) === 0o120000) {
      fail(`Zip contains a symlink: ${name}`);
    }
    if (flags & 1) fail(`Zip entry is encrypted: ${name}`);
    if (method !== 0 && method !== 8) {
      fail(`Zip entry uses an unsupported compression method: ${name}`);
    }

    if (localOffset + 30 > zip.length || u32(localOffset) !== 0x04034b50) {
      fail("File is not a valid zip archive");
    }
    const start =
      localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
    if (start + compressedSize > zip.length) {
      fail("File is not a valid zip archive");
    }
    const raw = zip.subarray(start, start + compressedSize);

    const chunks: Uint8Array[] = [];
    const take = (chunk: Uint8Array) => {
      unpacked += chunk.length;
      if (unpacked > SKILL_BUNDLE_MAX_UNPACKED_BYTES) {
        fail(
          `Zip unpacks to more than ${SKILL_BUNDLE_MAX_UNPACKED_BYTES / MiB} MiB`,
        );
      }
      chunks.push(chunk);
    };
    if (method === 0) {
      take(raw);
    } else {
      const inflater = new Inflate((chunk) => take(chunk));
      try {
        for (let at = 0; at < raw.length; at += 1024) {
          inflater.push(raw.subarray(at, at + 1024), at + 1024 >= raw.length);
        }
        if (raw.length === 0) inflater.push(new Uint8Array(0), true);
      } catch (error) {
        if (error instanceof ValidationError) throw error;
        fail(`Zip entry is corrupt: ${name}`);
      }
    }
    const data = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      data.set(chunk, at);
      at += chunk.length;
    }

    entries.push({ name, isDirectory: name.endsWith("/"), data });
  }
  return entries;
};

/** Splits `SKILL.md` into its frontmatter YAML and the body that follows it. */
const splitFrontmatter = (text: string): { yaml: string; body: string } => {
  const lines = text.replace(/^\uFEFF/, "").split("\n");
  const isFence = (line: string | undefined) => line?.trimEnd() === "---";
  const close = isFence(lines[0])
    ? lines.findIndex((line, i) => i > 0 && isFence(line))
    : -1;
  if (close < 0) fail("SKILL.md must open with a `---` frontmatter block");
  return {
    yaml: lines.slice(1, close).join("\n"),
    body: lines.slice(close + 1).join("\n"),
  };
};

const fieldsSchema = skillBaseSchema.pick({
  name: true,
  description: true,
  body: true,
  disableModelInvocation: true,
  argumentHint: true,
});

const parseSkillMd = (
  bytes: Uint8Array,
): Pick<ParsedSkillBundle, "fields" | "frontmatter"> => {
  if (!isTextContent(bytes)) fail("SKILL.md is not UTF-8 text");
  const { yaml, body } = splitFrontmatter(utf8.decode(bytes));
  if (Buffer.byteLength(yaml) > SKILL_FRONTMATTER_MAX_BYTES) {
    fail(
      `Frontmatter is larger than ${SKILL_FRONTMATTER_MAX_BYTES / 1024} KiB`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (error) {
    const { linePos, message } = error as {
      linePos?: [{ line: number }];
      message: string;
    };
    // The YAML starts on SKILL.md's second line, after the opening fence.
    const where = linePos ? ` at line ${linePos[0].line + 1}` : "";
    fail(`Frontmatter is not valid YAML${where}: ${message.split("\n")[0]}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("Frontmatter must be a YAML mapping");
  }

  const frontmatter: Record<string, unknown> = {};
  const mapped: Record<string, unknown> = { body };
  for (const [key, value] of Object.entries(parsed as object)) {
    if (key in MAPPED_KEYS) {
      mapped[MAPPED_KEYS[key as keyof typeof MAPPED_KEYS]] = value;
    } else {
      frontmatter[key] = value;
    }
  }
  for (const required of ["name", "description"] as const) {
    if (mapped[required] === undefined) {
      fail(`Frontmatter is missing required field \`${required}\``);
    }
  }

  const result = fieldsSchema.safeParse(mapped);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = String(issue.path[0]);
    const label =
      field === "body"
        ? "SKILL.md body"
        : `Frontmatter \`${Object.entries(MAPPED_KEYS).find(([, column]) => column === field)?.[0] ?? field}\``;
    fail(`${label} is invalid: ${issue.message}`);
  }
  const fields = result.data!;
  return {
    fields: { ...fields, argumentHint: fields.argumentHint ?? null },
    frontmatter,
  };
};

const isIgnored = (path: string) =>
  path.split("/")[0] === "__MACOSX" || path.split("/").at(-1) === ".DS_Store";

/**
 * Parses and validates an uploaded Skill zip. Every rule is checked before the
 * caller writes anything, and any violation throws a `ValidationError` (400)
 * naming the rule — nothing is truncated, coerced or repaired.
 */
export const parseSkillZip = (zip: Uint8Array): ParsedSkillBundle => {
  const seen = new Set<string>();
  const files: { path: string; data: Uint8Array }[] = [];
  for (const entry of readZipEntries(zip)) {
    const path = normaliseBundlePath(entry.name);
    if (entry.isDirectory || path === "" || isIgnored(path)) continue;
    if (seen.has(path)) fail(`Zip contains a duplicate path: ${path}`);
    seen.add(path);
    files.push({ path, data: entry.data });
  }

  // SKILL.md sits at the root, or inside exactly one top-level directory that
  // is stripped. The directory's name is ignored; the frontmatter names the Skill.
  let root = "";
  if (!seen.has("SKILL.md")) {
    const tops = new Set(files.map((f) => f.path.split("/")[0]));
    const [top] = tops;
    const nested = files.every((f) => f.path.includes("/"));
    if (tops.size !== 1 || !nested || !seen.has(`${top}/SKILL.md`)) {
      fail(
        "SKILL.md must be at the zip root or inside a single top-level directory",
      );
    }
    root = `${top}/`;
  }

  let skillMd: Uint8Array | undefined;
  const bundled: SkillBundleFile[] = [];
  for (const { path, data } of files) {
    const relative = path.slice(root.length);
    if (relative === "SKILL.md") {
      skillMd = data;
      continue;
    }
    bundled.push({
      path: relative,
      data,
      size: data.length,
      sha256: sha256Hex(data),
      isText: isTextContent(data),
    });
  }

  return { ...parseSkillMd(skillMd!), files: bundled };
};

/** JSON with object keys sorted, so a jsonb round-trip cannot change a hash. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
};

/**
 * A hash over the stored content: the mapped fields, the preserved
 * frontmatter, the body, and each file's path and sha256. Scope and ids are
 * not content, so promoting a Skill leaves its hash alone.
 */
export const bundleHash = (bundle: {
  fields: SkillBundleFields;
  frontmatter: Record<string, unknown>;
  files: { path: string; sha256: string }[];
}): string =>
  sha256Hex(
    canonicalJson({
      fields: bundle.fields,
      frontmatter: bundle.frontmatter,
      files: bundle.files
        .map(({ path, sha256 }) => ({ path, sha256 }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    }),
  );

/**
 * The zip an export downloads: `<name>/SKILL.md`, its frontmatter rebuilt from
 * the columns plus the preserved keys, and every other file at its stored path.
 * Re-importing it gives the same bundle hash.
 */
export const buildSkillZip = (bundle: {
  fields: SkillBundleFields;
  frontmatter: Record<string, unknown>;
  files: { path: string; data: Uint8Array }[];
}): Uint8Array => {
  const { name, description, body, disableModelInvocation, argumentHint } =
    bundle.fields;
  const yaml = stringifyYaml({
    name,
    description,
    ...(disableModelInvocation && { "disable-model-invocation": true }),
    ...(argumentHint !== null && { "argument-hint": argumentHint }),
    ...bundle.frontmatter,
  });
  const entries: Record<string, Uint8Array> = {
    [`${name}/SKILL.md`]: strToU8(`---\n${yaml}---\n${body}`),
  };
  for (const file of bundle.files) entries[`${name}/${file.path}`] = file.data;
  return zipSync(entries);
};
