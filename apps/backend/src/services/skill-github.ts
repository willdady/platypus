import { eq } from "drizzle-orm";
import {
  commitShaSchema,
  githubSkillSourceSchema,
  type GithubSkillSource,
  type SkillGithubCandidate,
  type SkillGithubInstallRequest,
  type SkillGithubInstallResult,
  type SkillGithubPreview,
  type SkillGithubUpdateCheck,
} from "@platypus/schemas";
import { db } from "../index.ts";
import { skill as skillTable } from "../db/schema.ts";
import { env } from "../env.ts";
import {
  mapError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
  ValidationError,
} from "../errors.ts";
import {
  buildSkillMd,
  bundleNeedsSandbox,
  inflateZipRecord,
  listZipRecords,
  SKILL_BUNDLE_MAX_ENTRIES,
  SKILL_BUNDLE_MAX_UNPACKED_BYTES,
  validateSkillBundle,
  type ParsedSkillBundle,
  type ZipRecord,
} from "./skill-bundle-format.ts";
import {
  createSkillFromBundle,
  fieldsOf,
  listSkillFiles,
  updateSkillBundleFromGithub,
  writableSkillWhere,
} from "./skill-bundle.ts";
import type { SkillScope } from "./skill.ts";

const MiB = 1024 * 1024;

export const GITHUB_ARCHIVE_MAX_BYTES = 100 * 1024 * 1024;

const API_HOST = "api.github.com";
const ALLOWED_HOSTS = new Set([API_HOST, "codeload.github.com"]);
const MAX_REDIRECTS = 5;

const fail: (message: string) => never = (message) => {
  throw new ValidationError(message);
};

export const parseGithubSource = (input: string): GithubSkillSource => {
  const text = input.trim();
  if (text.split(/[/@]/).includes(".."))
    fail("The source must not contain '..'");

  let segments: string[];
  let ref: string | null = null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    const url = URL.parse(text);
    if (
      !url ||
      url.protocol !== "https:" ||
      url.host !== "github.com" ||
      url.username ||
      url.password
    ) {
      fail("Only https://github.com URLs are supported");
    }
    try {
      segments = url.pathname
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
    } catch {
      segments = fail("The URL is not valid");
    }
    if (segments.length > 2) {
      if (segments[2] !== "tree" || segments.length < 4) {
        fail("Link to a repository or a folder in it (…/tree/<ref>/<path>)");
      }
      ref = segments[3] ?? null;
      segments = [...segments.slice(0, 2), ...segments.slice(4)];
    }
    if (segments[1]) segments[1] = segments[1].replace(/\.git$/, "");
  } else {
    const at = text.lastIndexOf("@");
    if (at >= 0) ref = text.slice(at + 1);
    segments = (at >= 0 ? text.slice(0, at) : text).split("/");
  }

  const [owner, repo, ...rest] = segments;
  if (!owner || !repo) {
    fail("Enter a GitHub URL or <owner>/<repo>");
  }
  const parsed = githubSkillSourceSchema.safeParse({
    owner,
    repo,
    ref,
    path: rest.join("/").replace(/\/+$/, ""),
  });
  if (!parsed.success) {
    fail(parsed.error.issues[0]?.message ?? "The source is not valid");
  }
  return parsed.data;
};

const resetMessage = (response: Response): string => {
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const retryAfter = Number(response.headers.get("retry-after"));
  const at =
    reset > 0
      ? new Date(reset * 1000)
      : retryAfter > 0
        ? new Date(Date.now() + retryAfter * 1000)
        : null;
  return at ? `until ${at.toISOString()}` : "for now";
};

const githubFetch = async (
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> => {
  const token = env().GITHUB_TOKEN;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { host } = new URL(url);
    if (!ALLOWED_HOSTS.has(host)) {
      throw new UpstreamError(
        `GitHub redirected to ${host}, which isn't allowed`,
      );
    }
    const response = await fetch(url, {
      redirect: "manual",
      headers: {
        "User-Agent": "Platypus",
        ...headers,
        ...(host === API_HOST &&
          token && {
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          }),
      },
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url).toString();
      continue;
    }
    if (
      response.status === 429 ||
      (response.status === 403 &&
        response.headers.get("x-ratelimit-remaining") === "0")
    ) {
      throw new RateLimitError(
        `GitHub's rate limit is spent ${resetMessage(response)}.${
          token ? "" : " An Operator can set GITHUB_TOKEN to raise it."
        }`,
      );
    }
    return response;
  }
  throw new UpstreamError("GitHub redirected too many times");
};

const upstream = (response: Response) =>
  new UpstreamError(`GitHub answered ${response.status}`);

const resolveCommit = async (source: GithubSkillSource): Promise<string> => {
  const repo = `${source.owner}/${source.repo}`;
  const ref = (source.ref ?? "HEAD")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const response = await githubFetch(
    `https://${API_HOST}/repos/${repo}/commits/${ref}`,
    { Accept: "application/vnd.github.sha" },
  );
  if (response.status === 404) {
    throw new NotFoundError(`Repository ${repo} not found`);
  }
  if (response.status === 422) {
    throw new NotFoundError(`Ref "${source.ref}" not found in ${repo}`);
  }
  if (!response.ok) throw upstream(response);
  const sha = (await response.text()).trim();
  if (!commitShaSchema.safeParse(sha).success) {
    throw new UpstreamError("GitHub didn't answer with a commit SHA");
  }
  return sha;
};

const fetchArchive = async (
  owner: string,
  repo: string,
  sha: string,
): Promise<Uint8Array> => {
  const response = await githubFetch(
    `https://codeload.github.com/${owner}/${repo}/zip/${sha}`,
  );
  if (response.status === 404) {
    throw new NotFoundError(`Commit ${sha} not found in ${owner}/${repo}`);
  }
  if (!response.ok || !response.body) throw upstream(response);

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > GITHUB_ARCHIVE_MAX_BYTES) {
      await reader.cancel();
      fail(
        `The repository archive is larger than ${GITHUB_ARCHIVE_MAX_BYTES / MiB} MiB`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

type ArchiveEntry = { path: string; record: ZipRecord };

const archiveEntries = (zip: Uint8Array): ArchiveEntry[] =>
  listZipRecords(zip).flatMap((record) => {
    const path = record.name.slice(record.name.indexOf("/") + 1);
    return record.name.includes("/") && path !== "" ? [{ path, record }] : [];
  });

const isUnder = (path: string, dir: string) =>
  dir === "" || path === dir || path.startsWith(`${dir}/`);

const skillMdPath = (skillPath: string) =>
  skillPath === "" ? "SKILL.md" : `${skillPath}/SKILL.md`;

const skillPathsUnder = (entries: ArchiveEntry[], dir: string): string[] =>
  entries
    .filter(
      ({ path, record }) =>
        !record.isDirectory &&
        (path === "SKILL.md" || path.endsWith("/SKILL.md")),
    )
    .map(({ path }) => path.slice(0, -"SKILL.md".length).replace(/\/$/, ""))
    .filter((skillPath) => isUnder(skillPath, dir))
    .sort();

const readSkill = (
  entries: ArchiveEntry[],
  skillPath: string,
): ParsedSkillBundle => {
  const files = entries.filter(
    ({ path, record }) => !record.isDirectory && isUnder(path, skillPath),
  );
  if (files.length > SKILL_BUNDLE_MAX_ENTRIES) {
    fail(`Skill has more than ${SKILL_BUNDLE_MAX_ENTRIES} files`);
  }
  const budget = { left: SKILL_BUNDLE_MAX_UNPACKED_BYTES };
  const overflow = `Skill unpacks to more than ${SKILL_BUNDLE_MAX_UNPACKED_BYTES / MiB} MiB`;
  return validateSkillBundle(
    files.map(({ path, record }) => ({
      path: skillPath === "" ? path : path.slice(skillPath.length + 1),
      bytes: record.isSymlink
        ? new Uint8Array(0)
        : inflateZipRecord(record, budget, overflow),
      isSymlink: record.isSymlink,
    })),
  );
};

const takenNames = async (scope: SkillScope): Promise<Set<string>> => {
  const rows = await db
    .select({ name: skillTable.name })
    .from(skillTable)
    .where(
      scope.kind === "workspace"
        ? eq(skillTable.workspaceId, scope.ctx.workspaceId)
        : eq(skillTable.organizationId, scope.orgId),
    );
  return new Set(rows.map((row) => row.name));
};

export const previewGithubSkills = async (
  scope: SkillScope,
  input: string,
): Promise<SkillGithubPreview> => {
  const source = parseGithubSource(input);
  const commitSha = await resolveCommit(source);
  const entries = archiveEntries(
    await fetchArchive(source.owner, source.repo, commitSha),
  );
  if (!entries.some(({ path }) => isUnder(path, source.path))) {
    throw new NotFoundError(
      `Path "${source.path}" not found in ${source.owner}/${source.repo}`,
    );
  }
  const taken = await takenNames(scope);
  const skills = skillPathsUnder(entries, source.path).map(
    (skillPath): SkillGithubCandidate => {
      try {
        const bundle = readSkill(entries, skillPath);
        return {
          skillPath,
          name: bundle.fields.name,
          description: bundle.fields.description,
          body: bundle.fields.body,
          files: bundle.files.map(({ path, size }) => ({ path, size })),
          needsSandbox: bundleNeedsSandbox(bundle.files),
          error: null,
          taken: taken.has(bundle.fields.name),
        };
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return {
          skillPath,
          name: null,
          description: null,
          body: null,
          files: [],
          needsSandbox: false,
          error: error.message,
          taken: false,
        };
      }
    },
  );
  return { ...source, commitSha, skills };
};

export const installGithubSkills = async (
  scope: SkillScope,
  request: SkillGithubInstallRequest,
): Promise<SkillGithubInstallResult> => {
  const { owner, repo, ref, commitSha } = request;
  const entries = archiveEntries(await fetchArchive(owner, repo, commitSha));
  const results: SkillGithubInstallResult["results"] = [];
  for (const skillPath of request.skillPaths) {
    if (!entries.some(({ path }) => path === skillMdPath(skillPath))) {
      results.push({
        skillPath,
        status: 404,
        error: `No Skill at ${skillPath || "the repository root"}`,
      });
      continue;
    }
    let name: string | undefined;
    try {
      const bundle = readSkill(entries, skillPath);
      name = bundle.fields.name;
      const row = await createSkillFromBundle(scope, bundle, {
        source: `${owner}/${repo}`,
        ref,
        skillPath,
        commitSha,
      });
      results.push({ skillPath, status: 201, skillId: row.id, name });
    } catch (error) {
      const mapped = mapError(error);
      if (!mapped) throw error;
      results.push({
        skillPath,
        status: mapped.status,
        ...(name && { name }),
        error: mapped.message,
      });
    }
  }
  return { results };
};

const requireGithubSkill = async (scope: SkillScope, skillId: string) => {
  const [row] = await db
    .select()
    .from(skillTable)
    .where(await writableSkillWhere(scope, skillId))
    .limit(1);
  if (!row) throw new NotFoundError("Skill not found");
  if (
    row.sourceType !== "github" ||
    !row.source ||
    row.skillPath === null ||
    !row.commitSha
  ) {
    fail("This Skill wasn't installed from GitHub");
  }
  const [owner, repo, ...rest] = row.source.split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Skill ${row.id} has a malformed source: ${row.source}`);
  }
  return {
    row,
    owner,
    repo,
    skillPath: row.skillPath,
    commitSha: row.commitSha,
  };
};

const fetchSkill = async (
  owner: string,
  repo: string,
  sha: string,
  skillPath: string,
): Promise<ParsedSkillBundle> => {
  const entries = archiveEntries(await fetchArchive(owner, repo, sha));
  if (!entries.some(({ path }) => path === skillMdPath(skillPath))) {
    throw new NotFoundError(
      `No Skill at ${skillPath || "the repository root"} in commit ${sha.slice(0, 7)}`,
    );
  }
  return readSkill(entries, skillPath);
};

export const checkGithubSkillUpdate = async (
  scope: SkillScope,
  skillId: string,
): Promise<SkillGithubUpdateCheck> => {
  const { row, owner, repo, skillPath, commitSha } = await requireGithubSkill(
    scope,
    skillId,
  );
  if (commitShaSchema.safeParse(row.ref).success) return { upToDate: true };
  const toSha = await resolveCommit({
    owner,
    repo,
    ref: row.ref,
    path: skillPath,
  });
  if (toSha === commitSha) return { upToDate: true };

  const bundle = await fetchSkill(owner, repo, toSha, skillPath);
  const before = new Map(
    (await listSkillFiles(db, row.id)).map((file) => [file.path, file]),
  );
  const after = new Set(bundle.files.map(({ path }) => path));
  return {
    upToDate: false,
    fromSha: commitSha,
    toSha,
    files: {
      added: bundle.files
        .filter(({ path }) => !before.has(path))
        .map(({ path, size }) => ({ path, size })),
      removed: [...before.values()]
        .filter(({ path }) => !after.has(path))
        .map(({ path, size }) => ({ path, size })),
      changed: bundle.files.flatMap(({ path, size, sha256 }) => {
        const old = before.get(path);
        return old && old.sha256 !== sha256
          ? [{ path, oldSize: old.size, newSize: size }]
          : [];
      }),
    },
    skillMd: {
      before: buildSkillMd({
        fields: fieldsOf(row),
        frontmatter: row.frontmatter,
      }),
      after: buildSkillMd(bundle),
    },
    needsSandbox: {
      before: row.needsSandbox,
      after: bundleNeedsSandbox(bundle.files),
    },
  };
};

export const updateGithubSkill = async (
  scope: SkillScope,
  skillId: string,
  commitSha: string,
) => {
  const { owner, repo, skillPath } = await requireGithubSkill(scope, skillId);
  return updateSkillBundleFromGithub(
    scope,
    skillId,
    await fetchSkill(owner, repo, commitSha, skillPath),
    commitSha,
  );
};
