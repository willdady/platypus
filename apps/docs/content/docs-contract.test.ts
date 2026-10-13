/**
 * Documentation contract test.
 *
 * Pins the documentation claims that have exactly one authoritative source, so
 * that renaming an environment variable, adding a webhook event, registering a
 * core Plugin, or changing a field limit fails CI instead of reaching an
 * Operator at deploy time. Every failure names the doc file, the line, and the
 * source of truth — an unattributable failure in a docs suite gets skipped.
 *
 * Only claims that can be checked without judgement live here. Anything that
 * needs a reader's eye belongs in the `/docs-audit` skill instead. One noisy
 * assertion trains everyone to ignore a red suite, which costs more than the
 * assertion is worth.
 *
 * Known limits, stated so nobody mistakes this for coverage:
 *
 * - It only checks what someone encoded, with one ratchet: a number with a
 *   unit in prose must be pinned or listed in UNPINNED_NUMBERS with a reason.
 *   The ~150 bolded UI labels across `building-with-platypus/` have no anchor
 *   at all — rename a button and nothing here complains. A green suite is not
 *   a correct docs site.
 * - Text-matching MDX is brittle in boring ways. Dashes are normalised and
 *   thousands separators stripped before comparison, but a rewritten sentence
 *   can still move a claim out from under its anchor. When that happens the
 *   failure says so explicitly rather than reporting a wrong number.
 *
 * Anything this file reads from outside `apps/docs` must also be declared in
 * `apps/docs/turbo.json`, or turbo replays a cached pass over stale input. The
 * list there is the whole of that coupling: add a `readRepoFile` path here, add
 * it there.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import GithubSlugger from "github-slugger";
import { describe, expect, it } from "vitest";
import {
  a2aEndpointSchema,
  a2aTokenSchema,
  agentSchema,
  chatSchema,
  invitationRedemptionRegisterSchema,
  dashboardCreateSchema,
  DEFAULT_DIRECT_MAX_STEPS,
  inboundTriggerInputSchema,
  DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
  kanbanBoardSchema,
  MAX_PLUGIN_NAME_LENGTH,
  MAX_PLUGIN_TOOL_NAME_LENGTH,
  mcpSchema,
  modelConfigSchema,
  RUN_EVENT_ERROR_MAX_BYTES,
  skillSchema,
  TOOL_NAME_NAMESPACE_SEPARATOR,
  TOOL_NAME_PATTERN,
  TOOL_RESULT_CLEARING_KEEP_RECENT,
  TOOL_RESULT_CLEARING_THRESHOLD,
  triggerSchema,
  eventTriggerEventSchema,
  webhookEventDataSchemas,
  webhookEventSchema,
  type WebhookEvent,
  workspaceSchema,
} from "@platypus/schemas";

const CONTENT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(CONTENT_DIR, "..", "..", "..");

// --- reading -----------------------------------------------------------------

/**
 * Normalise CRLF to LF at the point of reading.
 *
 * Git can check out CRLF on Windows. Everything downstream splits on `"\n"` and
 * several patterns anchor with `$`, and a trailing `"\r"` defeats both — most
 * sharply the heading pattern, which then matches nothing and leaves the
 * internal-link check with no anchors to resolve against. One normalisation
 * here rather than a tolerance every future pattern has to remember.
 */
const normalizeNewlines = (text: string): string => text.replace(/\r\n/g, "\n");

const readRepoFile = (repoRelativePath: string): string =>
  normalizeNewlines(readFileSync(join(REPO_ROOT, repoRelativePath), "utf8"));

const readDoc = (contentRelativePath: string): string =>
  normalizeNewlines(
    readFileSync(join(CONTENT_DIR, contentRelativePath), "utf8"),
  );

/** Every `.mdx` page under `content/`, as paths relative to `content/`. */
const listDocs = (dir = CONTENT_DIR): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) {
      found.push(...listDocs(absolute));
    } else if (entry.endsWith(".mdx")) {
      found.push(relative(CONTENT_DIR, absolute).split(sep).join(posix.sep));
    }
  }
  return found.sort();
};

const DOCS = listDocs();

if (DOCS.length === 0) {
  throw new Error(
    `No .mdx pages found under ${CONTENT_DIR}. Every assertion below would pass vacuously.`,
  );
}

/**
 * Blank out fenced code blocks while preserving line numbering. Fences hold
 * illustrative snippets — a Dockerfile `ARG`, an example payload — that are not
 * claims about the current shape of anything.
 */
const withoutCodeFences = (content: string): string => {
  let inFence = false;
  return content
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return "";
      }
      return inFence ? "" : line;
    })
    .join("\n");
};

type Located = { text: string; line: number };

/** Inline `` `code` `` spans outside fenced blocks, with their line numbers. */
const inlineCodeSpans = (content: string): Located[] => {
  const spans: Located[] = [];
  withoutCodeFences(content)
    .split("\n")
    .forEach((line, index) => {
      for (const match of line.matchAll(/`([^`\n]+)`/g)) {
        spans.push({ text: match[1], line: index + 1 });
      }
    });
  return spans;
};

/**
 * Every fenced block on the page, as raw text with its opening line number.
 *
 * The counterpart to `withoutCodeFences`: that one throws the fences away
 * because a snippet is not a claim, and this one keeps them for the rare
 * snippet that is — text the reader is told the product produces verbatim.
 */
const fencedBlocks = (content: string): Located[] => {
  const blocks: Located[] = [];
  let open: number | null = null;
  let body: string[] = [];
  content.split("\n").forEach((line, index) => {
    if (!/^\s*```/.test(line)) {
      if (open !== null) body.push(line);
      return;
    }
    if (open === null) {
      open = index + 1;
      body = [];
    } else {
      blocks.push({ text: body.join("\n"), line: open });
      open = null;
    }
  });
  return blocks;
};

type MarkdownTable = { line: number; header: string[]; rows: string[][] };

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

/** Every pipe table on the page, in document order. */
const markdownTables = (content: string): MarkdownTable[] => {
  const lines = withoutCodeFences(content).split("\n");
  const tables: MarkdownTable[] = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    const isHeader = lines[i].trim().startsWith("|");
    const isDivider = /^\s*\|[\s|:-]+\|\s*$/.test(lines[i + 1]);
    if (!isHeader || !isDivider) continue;

    const header = splitRow(lines[i]);
    const rows: string[][] = [];
    let cursor = i + 2;
    while (cursor < lines.length && lines[cursor].trim().startsWith("|")) {
      rows.push(splitRow(lines[cursor]));
      cursor += 1;
    }
    tables.push({ line: i + 1, header, rows });
    i = cursor;
  }
  return tables;
};

/**
 * The one table whose first header cell matches `label`, e.g. "Event".
 *
 * Throws when a page grows a second one rather than silently checking the
 * first: the rows of the table nobody looked at would read as undocumented,
 * and the failure would point at the wrong thing.
 */
const tableByFirstColumn = (
  content: string,
  label: string,
): MarkdownTable | undefined => {
  const matches = markdownTables(content).filter(
    (table) => table.header[0] === label,
  );
  if (matches.length > 1) {
    throw new Error(
      `Found ${matches.length} tables whose first column is "${label}" (lines ` +
        `${matches.map((table) => table.line).join(", ")}). This check reads one — ` +
        `merge them, or teach this test which is authoritative.`,
    );
  }
  return matches[0];
};

const firstCodeSpan = (cell: string): string | undefined =>
  cell.match(/`([^`]+)`/)?.[1];

// --- assertion plumbing ------------------------------------------------------

/**
 * Report every violation at once rather than the first. A docs failure is
 * usually a batch — one rename touching six rows — and fixing them one CI run
 * at a time is how people learn to skip the suite.
 */
const expectNoViolations = (violations: string[]) => {
  expect(violations.join("\n\n"), "documentation contract violations").toBe("");
};

// --- environment variables ---------------------------------------------------

const BACKEND_REFERENCE_PAGE = "reference/backend-configuration.mdx";
const FRONTEND_REFERENCE_PAGE = "reference/frontend-configuration.mdx";

const ENV_REFERENCE_PAGES = [BACKEND_REFERENCE_PAGE, FRONTEND_REFERENCE_PAGE];

/**
 * Which page owes a row for the variables each file ships. The two app files
 * pair with their own page — a backend variable listed only under "Frontend
 * configuration" is as good as undocumented to the Operator reading the page
 * for the service they are configuring. The root Compose file feeds both
 * containers, so either page discharges it.
 */
const ENV_EXAMPLE_FILES: Record<string, string[]> = {
  ".example.env": ENV_REFERENCE_PAGES,
  "apps/backend/.example.env": [BACKEND_REFERENCE_PAGE],
  "apps/frontend/.example.env": [FRONTEND_REFERENCE_PAGE],
};

const ENV_EXAMPLE_NAMES = Object.keys(ENV_EXAMPLE_FILES);

/**
 * Variables a reference page deliberately still names after they stopped
 * existing. Empty on purpose: "Reference describes the present tense" is now a
 * stated section rule (`reference/index.mdx`), so where a removed setting went
 * is told on the upgrade page instead, which no check here reads.
 *
 * An entry earns its place back only if a reference table itself needs to name a
 * variable that no `.example.env` ships any more.
 */
const REMOVED_VARS = new Set<string>([]);

/**
 * Real variables that no `.example.env` ships, so the reference page is their
 * only home. The first two are read by the frontend (`next.config.ts` and the
 * About page) and neither is something a deployment normally sets.
 * `NODE_ENV` is set by the backend image, not in `.env`.
 * `PLATYPUS_PLUGIN_CONFIG` is deprecated, so the example files show the
 * per-plugin `PLATYPUS_PLUGIN_CONFIG_<NAME>` form instead.
 */
const VARS_WITHOUT_ENV_EXAMPLE_ENTRY = new Set([
  "ALLOWED_DEV_ORIGINS",
  "NEXT_PUBLIC_APP_VERSION",
  "NODE_ENV",
  "PLATYPUS_PLUGIN_CONFIG",
]);

/**
 * Assignments in a `.example.env`, including commented-out ones — a `# VAR=`
 * line is how the file documents an optional setting, so it is still a variable
 * the reference page owes the reader a row for.
 */
const parseEnvExample = (content: string): Map<string, number> => {
  const found = new Map<string, number>();
  content.split("\n").forEach((line, index) => {
    const match = line.match(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/);
    if (match && !found.has(match[1])) found.set(match[1], index + 1);
  });
  return found;
};

/**
 * The first column of every `| Variable |` table on a page. Rows, not prose
 * mentions: the reference pages call themselves "the exhaustive list", and a
 * variable named only in a warning is one a reader scanning the table never
 * finds. Reading the column also means no uppercase-word heuristic — `UTC` sits
 * in a Default cell and is never mistaken for a claim.
 */
const variableRows = (content: string): Map<string, number> => {
  const rows = new Map<string, number>();
  for (const table of markdownTables(content)) {
    if (table.header[0] !== "Variable") continue;
    table.rows.forEach((row, index) => {
      const name = firstCodeSpan(row[0]);
      if (name && !rows.has(name)) rows.set(name, table.line + 2 + index);
    });
  }
  return rows;
};

/**
 * Whether a table row documents `name`. A row spelled `PREFIX_<NAME>` stands for
 * a family of variables, one per `<NAME>` — `PLATYPUS_PLUGIN_CONFIG_<NAME>` is
 * one variable per plugin — so it covers every assignment of `PREFIX_` followed
 * by a name, and a `.example.env` shows the family through one example member.
 */
const rowCovers = (row: string, name: string): boolean => {
  const family = row.match(/^([A-Z][A-Z0-9_]*_)<[A-Z]+>$/);
  return family
    ? name.startsWith(family[1]) &&
        /^[A-Z0-9_]+$/.test(name.slice(family[1].length))
    : row === name;
};

/**
 * Where the backend keeps the fallback for each variable whose Default cell on
 * the backend reference page is a number. Each file declares it as
 * `DEFAULT_<VAR> = <product of integers>;`. No row is excluded today: every
 * numeric default the page quotes is one the backend chooses itself.
 */
const BACKEND_DEFAULT_SOURCES: Record<string, string> = {
  PORT: "apps/backend/index.ts",
  INVITATION_EXPIRY_DAYS: "apps/backend/src/routes/invitation.ts",
  MEMORY_EXTRACTION_INTERVAL_MS: "apps/backend/src/jobs/memory-scheduler.ts",
  SCHEDULE_SCHEDULER_INTERVAL_MS: "apps/backend/src/jobs/scheduler.ts",
  SCHEDULE_MAX_CONCURRENT: "apps/backend/src/jobs/scheduler.ts",
  TRIGGER_PER_STEP_TIMEOUT_MS: "apps/backend/src/runs/trigger-timeouts.ts",
  TRIGGER_PER_RUN_TIMEOUT_MS: "apps/backend/src/runs/trigger-timeouts.ts",
  TRIGGER_BREAKER_MAX_RUNS: "apps/backend/src/services/trigger-breaker.ts",
  TRIGGER_BREAKER_WINDOW_SECONDS:
    "apps/backend/src/services/trigger-breaker.ts",
  TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP:
    "apps/backend/src/services/trigger-breaker.ts",
  INBOUND_TRIGGER_MAX_CONCURRENT_RUNS:
    "apps/backend/src/services/inbound-trigger.ts",
  INBOUND_TRIGGER_MAX_BODY_BYTES:
    "apps/backend/src/services/inbound-trigger.ts",
  A2A_MAX_CONCURRENT_RUNS: "apps/backend/src/services/a2a-call.ts",
  A2A_MAX_CONCURRENT_STREAMS: "apps/backend/src/services/a2a-call.ts",
  A2A_MAX_BODY_BYTES: "apps/backend/src/services/a2a-call.ts",
  CHAT_PER_STEP_TIMEOUT_MS: "apps/backend/src/runs/chat-timeouts.ts",
  CHAT_PER_RUN_TIMEOUT_MS: "apps/backend/src/runs/chat-timeouts.ts",
};

/**
 * The value of `NAME = <product of integers>;` in a repo file, e.g.
 * `10 * 60 * 1000` or `65536`, or `undefined` when there is no such line.
 */
const readIntegerConstant = (
  source: string,
  name: string,
): number | undefined => {
  const declared = readRepoFile(source).match(
    new RegExp(`\\b${name} = ([\\d_ *]+);`),
  );
  return declared?.[1]
    .split("*")
    .reduce((product, n) => product * Number(n.replace(/[_\s]/g, "")), 1);
};

/** Durations a Default cell's gloss may name, in seconds. */
const GLOSS_SECONDS: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3_600,
};

/**
 * Sizes a Default cell's gloss may name, in bytes. `KB` and `MB` are read as
 * binary because the page has written them for binary values.
 */
const GLOSS_BYTES: Record<string, number> = {
  KiB: 1_024,
  KB: 1_024,
  MiB: 1_024 ** 2,
  MB: 1_024 ** 2,
};

/**
 * What a gloss like "5 minutes" or "64 KiB" means in `name`'s own unit — a
 * minute is 60000 for a `_MS` variable and 60 for a `_SECONDS` one — or
 * `undefined` when it names no unit this reads.
 */
const glossValue = (name: string, gloss: string): number | undefined => {
  const match = gloss.match(/^(\d+) ([A-Za-z]+?)s?$/);
  if (!match) return undefined;
  const count = Number(match[1]);
  const seconds = GLOSS_SECONDS[match[2]];
  if (seconds && name.endsWith("_MS")) return count * seconds * 1_000;
  if (seconds && name.endsWith("_SECONDS")) return count * seconds;
  const bytes = GLOSS_BYTES[match[2]];
  if (bytes && name.endsWith("_BYTES")) return count * bytes;
  return undefined;
};

/** The value a `.example.env` line assigns `name`, commented-out or not. */
const envExampleValue = (
  content: string,
  name: string,
): { value: string; line: number } | undefined => {
  for (const [index, text] of content.split("\n").entries()) {
    const match = text.match(
      new RegExp(`^\\s*#?\\s*${name}=\\s*"?([^"\\s#]*)"?`),
    );
    if (match) return { value: match[1], line: index + 1 };
  }
  return undefined;
};

type NumericDefault = {
  name: string;
  line: number;
  value: number;
  gloss?: string;
  /** The Default cell as written, e.g. "`300000` (5 minutes)". */
  cell: string;
};

/** Every row on the backend page whose Default cell is a number. */
const backendNumericDefaults = (): NumericDefault[] => {
  const found: NumericDefault[] = [];
  for (const table of markdownTables(readDoc(BACKEND_REFERENCE_PAGE))) {
    const column = table.header.indexOf("Default");
    if (table.header[0] !== "Variable" || column === -1) continue;
    table.rows.forEach((row, index) => {
      const name = firstCodeSpan(row[0]);
      const cell = row[column]?.match(/^`(\d+)`(?: \(([^)]+)\))?$/);
      if (!name || !cell) return;
      found.push({
        name,
        line: table.line + 2 + index,
        value: Number(cell[1]),
        gloss: cell[2],
        cell: cell[0],
      });
    });
  }
  return found;
};

describe("environment variables", () => {
  type Declaration = { origin: string; pages: string[] };
  const declared = new Map<string, Declaration>();
  for (const [file, pages] of Object.entries(ENV_EXAMPLE_FILES)) {
    for (const [name, line] of parseEnvExample(readRepoFile(file))) {
      const existing = declared.get(name);
      if (existing) {
        existing.pages = [...new Set([...existing.pages, ...pages])];
      } else {
        declared.set(name, { origin: `${file}:${line}`, pages: [...pages] });
      }
    }
  }

  const rowsByPage = new Map<string, Map<string, number>>();
  for (const page of ENV_REFERENCE_PAGES) {
    rowsByPage.set(page, variableRows(readDoc(page)));
  }
  const documentedRows = new Map<string, string>(); // VAR -> "page:line"
  for (const [page, rows] of rowsByPage) {
    for (const [name, line] of rows) {
      if (!documentedRows.has(name)) {
        documentedRows.set(name, `${page}:${line}`);
      }
    }
  }

  // Prose counts for the allowlists below — a migration note telling a reader
  // where a removed setting went is exactly a mention without a row.
  const mentionedAnywhere = new Map<string, string>(); // VAR -> "page:line"
  for (const page of ENV_REFERENCE_PAGES) {
    for (const span of inlineCodeSpans(readDoc(page))) {
      const token = span.text.split("=")[0].trim();
      if (!mentionedAnywhere.has(token)) {
        mentionedAnywhere.set(token, `${page}:${span.line}`);
      }
    }
  }

  it("extracted variables from both sides", () => {
    // An extractor that silently stops matching turns every assertion below
    // green, which is worse than no test at all.
    expect(
      declared.size,
      `parsed no assignments out of ${ENV_EXAMPLE_NAMES.join(", ")}`,
    ).toBeGreaterThan(20);
    expect(
      documentedRows.size,
      `parsed no variable rows out of ${ENV_REFERENCE_PAGES.join(", ")}`,
    ).toBeGreaterThan(20);
  });

  it("gives every variable the .example.env files ship a row on its own page", () => {
    const violations: string[] = [];
    for (const [name, { origin, pages }] of declared) {
      const onOwedPage = pages.some((page) =>
        [...(rowsByPage.get(page)?.keys() ?? [])].some((row) =>
          rowCovers(row, name),
        ),
      );
      if (onOwedPage) continue;

      const elsewhere = documentedRows.get(name);
      const owed = pages
        .map((page) => `apps/docs/content/${page}`)
        .join(" or ");
      violations.push(
        elsewhere
          ? `\`${name}\` is set in ${origin}, but its only row is apps/docs/content/${elsewhere}.\n` +
              `Move it to ${owed} — the page for the service that ships it.`
          : `\`${name}\` is set in ${origin} but no reference table has a row for it.\n` +
              `Add a row to ${owed}.`,
      );
    }
    expectNoViolations(violations);
  });

  it("names no variable the .example.env files do not ship", () => {
    const violations: string[] = [];
    for (const [page, rows] of rowsByPage) {
      for (const [name, line] of rows) {
        if (
          [...declared.keys()].some((declaredName) =>
            rowCovers(name, declaredName),
          )
        ) {
          continue;
        }
        if (REMOVED_VARS.has(name)) continue;
        if (VARS_WITHOUT_ENV_EXAMPLE_ENTRY.has(name)) continue;
        violations.push(
          `apps/docs/content/${page}:${line} has a row for \`${name}\`, which no .example.env assigns.\n` +
            `Source of truth: ${ENV_EXAMPLE_NAMES.join(", ")}.\n` +
            `If the variable was deliberately removed, add it to REMOVED_VARS in this file; ` +
            `if it is real but no example file ships it, add it to VARS_WITHOUT_ENV_EXAMPLE_ENTRY.`,
        );
      }
    }
    expectNoViolations(violations);
  });

  it("keeps the variable allowlists honest", () => {
    const violations: string[] = [];
    for (const name of REMOVED_VARS) {
      if (declared.has(name)) {
        violations.push(
          `\`${name}\` is listed in REMOVED_VARS but ${declared.get(name)?.origin} assigns it again.\n` +
            `Drop it from REMOVED_VARS so the reference page is checked against the env files.`,
        );
      }
    }
    for (const name of [...REMOVED_VARS, ...VARS_WITHOUT_ENV_EXAMPLE_ENTRY]) {
      if (!mentionedAnywhere.has(name)) {
        violations.push(
          `\`${name}\` is allowlisted in this file but no reference page mentions it any more.\n` +
            `Remove the allowlist entry.`,
        );
      }
    }
    expectNoViolations(violations);
  });

  describe("numeric defaults on the backend page", () => {
    const numericDefaults = backendNumericDefaults();
    const at = (line: number) =>
      `apps/docs/content/${BACKEND_REFERENCE_PAGE}:${line}`;

    it("found the numeric Default cells", () => {
      expect(
        numericDefaults.length,
        `parsed no numeric Default cells out of ${BACKEND_REFERENCE_PAGE}`,
      ).toBeGreaterThan(10);
    });

    it("quotes the value the backend uses when the variable is unset", () => {
      const violations: string[] = [];
      for (const { name, line, value } of numericDefaults) {
        const source = BACKEND_DEFAULT_SOURCES[name];
        if (!source) {
          violations.push(
            `${at(line)} gives \`${name}\` the default ${value}, but this test does not know where the backend sets it.\n` +
              `Declare \`DEFAULT_${name} = <number>;\` beside the code that reads it and add it to BACKEND_DEFAULT_SOURCES.`,
          );
          continue;
        }
        const code = readIntegerConstant(source, `DEFAULT_${name}`);
        if (code === undefined) {
          violations.push(
            `${at(line)} gives \`${name}\` the default ${value}, but there is no \`DEFAULT_${name} = <number>;\` in ${source}.\n` +
              `Re-anchor BACKEND_DEFAULT_SOURCES if it moved.`,
          );
        } else if (code !== value) {
          violations.push(
            `${at(line)} gives \`${name}\` the default ${value}, but ${source} sets DEFAULT_${name} to ${code}.\n` +
              `An Operator tuning against the page starts from the wrong number.`,
          );
        }
      }
      expectNoViolations(violations);
    });

    it("glosses each default with the value it states", () => {
      const violations: string[] = [];
      for (const { name, line, value, gloss } of numericDefaults) {
        if (gloss === undefined) continue;
        const glossed = glossValue(name, gloss);
        if (glossed === undefined) {
          violations.push(
            `${at(line)} glosses \`${name}\`'s default as "${gloss}", which this test cannot read.\n` +
              `Use a unit from GLOSS_SECONDS or GLOSS_BYTES, or teach this test the new one.`,
          );
        } else if (glossed !== value) {
          violations.push(
            `${at(line)} glosses \`${name}\`'s default ${value} as "${gloss}", which is ${glossed}.`,
          );
        }
      }
      expectNoViolations(violations);
    });

    it("ships the same value in every .example.env that assigns it", () => {
      const violations: string[] = [];
      for (const { name, line, value } of numericDefaults) {
        for (const file of ENV_EXAMPLE_NAMES) {
          const assigned = envExampleValue(readRepoFile(file), name);
          if (assigned && Number(assigned.value) !== value) {
            violations.push(
              `${file}:${assigned.line} sets \`${name}\` to "${assigned.value}", but ${at(line)} and the backend default it to ${value}.\n` +
                `An example file is copied as-is; a different value there is a default nobody documented.`,
            );
          }
        }
      }
      expectNoViolations(violations);
    });

    it("keeps BACKEND_DEFAULT_SOURCES to rows the page has", () => {
      const quoted = new Set(numericDefaults.map(({ name }) => name));
      const stale = Object.keys(BACKEND_DEFAULT_SOURCES).filter(
        (name) => !quoted.has(name),
      );
      expect(
        stale,
        `BACKEND_DEFAULT_SOURCES lists variables with no numeric Default cell on ${BACKEND_REFERENCE_PAGE}. Remove them.`,
      ).toEqual([]);
    });
  });
});

// --- where the self-hosting pages say uploaded files land -------------------

const COMPOSE_FILE = "compose.yaml";
const COMPOSE_YAML = readRepoFile(COMPOSE_FILE);

const BACKEND_DOCKERFILE = "apps/backend/Dockerfile";
const DOCKERFILE = readRepoFile(BACKEND_DOCKERFILE);

/** Leading-whitespace width, used to walk `compose.yaml` by indentation. */
const indentWidth = (line: string): number =>
  line.length - line.trimStart().length;

type ComposeLine = { text: string; line: number };

/**
 * The lines of one nested block of `compose.yaml`, addressed by key path.
 *
 * No YAML parser is a dependency of this package, and this file already
 * hand-reads Markdown tables and `.env` assignments. The compose file is short,
 * hand-maintained and three levels deep, so a key path plus indentation reads
 * it. An extractor that quietly stops matching would turn the assertions below
 * green, so the first test in the block checks that it found anything at all.
 */
const composeBlock = (keyPath: string[]): ComposeLine[] => {
  let lines: ComposeLine[] = COMPOSE_YAML.split("\n").map((text, index) => ({
    text,
    line: index + 1,
  }));
  let indent = 0;
  for (const key of keyPath) {
    const start = lines.findIndex(
      ({ text }) =>
        indentWidth(text) === indent && text.trim().startsWith(`${key}:`),
    );
    if (start === -1) return [];
    const body: ComposeLine[] = [];
    for (const entry of lines.slice(start + 1)) {
      if (entry.text.trim() === "") continue;
      if (indentWidth(entry.text) <= indent) break;
      body.push(entry);
    }
    if (body.length === 0) return [];
    lines = body;
    indent = indentWidth(body[0].text);
  }
  return lines;
};

type BindMount = { host: string; container: string; line: number };

/** The `host:container` bind mounts of a service's `volumes:` block. */
const composeBindMounts = (service: string): BindMount[] =>
  composeBlock(["services", service, "volumes"]).flatMap(({ text, line }) => {
    const match = text.trim().match(/^-\s*(\.\S*?):(\/\S+?)(?::[a-z,]+)?$/);
    return match ? [{ host: match[1], container: match[2], line }] : [];
  });

/** An `ENV KEY=value` declaration in the backend Dockerfile. */
const dockerfileEnv = (
  name: string,
): { value: string; line: number } | undefined => {
  const lines = DOCKERFILE.split("\n");
  for (const [index, text] of lines.entries()) {
    const match = text.match(new RegExp(`^ENV ${name}=(\\S+)\\s*$`));
    if (match) return { value: match[1], line: index + 1 };
  }
  return undefined;
};

/**
 * Where the self-hosting pages tell an Operator their uploaded files are.
 *
 * Two pages make that claim and both are load-bearing: the Compose page names
 * `./data` as the directory uploads are written to, and the production page
 * sends the Operator there to back them up — a Chat File part is the one thing
 * a database dump does not contain, so a wrong directory there is silent data
 * loss discovered at restore time.
 *
 * Neither claim is true on its own. `STORAGE_DISK_PATH` is resolved relative to
 * the working directory, so left at its library default the backend writes
 * uploads into the container's own layer and any mount receives nothing. The
 * backend image is what settles this, because it is what every deployment has
 * in common — Compose, Kubernetes, Swarm, a bare `docker run`. The pages that
 * promise the mount sit in a third place again, which is what this pins.
 */
describe("the uploaded-files location the self-hosting pages promise", () => {
  const imagePath = dockerfileEnv("STORAGE_DISK_PATH");
  const bindMounts = composeBindMounts("backend");
  const claimedBy = "apps/docs/content/self-hosting/docker-compose.mdx";

  it("parsed the image and the compose file", () => {
    expect(
      dockerfileEnv("NODE_ENV")?.value,
      `read no \`ENV NODE_ENV\` out of ${BACKEND_DOCKERFILE}, so the extractor ` +
        `below cannot be trusted to find STORAGE_DISK_PATH either`,
    ).toBeDefined();
    expect(
      bindMounts.map((mount) => `${mount.host}:${mount.container}`),
      `parsed no host bind mount out of the backend service in ${COMPOSE_FILE}`,
    ).not.toHaveLength(0);
  });

  it("has the image store uploads where a volume can be mounted", () => {
    expect(
      imagePath?.value,
      `${BACKEND_DOCKERFILE} declares no \`ENV STORAGE_DISK_PATH\`, so the backend ` +
        `falls back to DiskStorage's relative default. That resolves under ` +
        `WORKDIR, inside the container's own layer, and every deployment that ` +
        `does not set the variable itself loses uploaded files on the next ` +
        `container recreate — an image upgrade, or a Kubernetes rollout.\n` +
        `${claimedBy} promises an Operator those files are on the host.`,
    ).toBeDefined();

    expect(
      imagePath?.value.startsWith("/"),
      `${BACKEND_DOCKERFILE}:${imagePath?.line} sets STORAGE_DISK_PATH to ` +
        `\`${imagePath?.value}\`. A relative path resolves under WORKDIR, which ` +
        `is inside the image; it has to be absolute to name a mount point.`,
    ).toBe(true);
  });

  it("mounts the compose stack's host directory over that location", () => {
    const mount = bindMounts.find(
      (candidate) =>
        imagePath?.value === candidate.container ||
        imagePath?.value.startsWith(`${candidate.container}/`),
    );
    expect(
      mount?.host,
      `The backend image stores uploads at \`${imagePath?.value}\` ` +
        `(${BACKEND_DOCKERFILE}:${imagePath?.line}), which is not under any bind ` +
        `mount the backend service declares in ${COMPOSE_FILE} ` +
        `(${bindMounts.map((m) => `${m.container} at line ${m.line}`).join(", ") || "none"}).\n` +
        `The Compose stack would write uploads into the container layer and lose ` +
        `them on recreate, while ${claimedBy} goes on promising they are on the ` +
        `host under that bind mount.`,
    ).toBeDefined();
  });

  it("names that mount on both pages that send an Operator to it", () => {
    const violations: string[] = [];
    for (const page of [
      "self-hosting/docker-compose.mdx",
      "self-hosting/production.mdx",
    ]) {
      const content = readDoc(page);
      if (bindMounts.some((mount) => content.includes(`\`${mount.host}\``)))
        continue;
      violations.push(
        `apps/docs/content/${page} names none of the host directories the ` +
          `backend service bind-mounts ` +
          `(${bindMounts.map((m) => `\`${m.host}\` at ${COMPOSE_FILE}:${m.line}`).join(", ")}).\n` +
          `That page tells an Operator where their uploads are and what to back ` +
          `up, so it has to name the directory Compose actually mounts.`,
      );
    }
    expectNoViolations(violations);
  });
});

// --- webhook events ----------------------------------------------------------

describe("webhook events", () => {
  const page = "building-with-platypus/webhooks.mdx";
  const content = readDoc(page);
  const table = tableByFirstColumn(content, "Event");
  const source = "packages/schemas/index.ts (webhookEventSchema)";

  it("has a subscribable-events table to check", () => {
    expect(
      table,
      `apps/docs/content/${page} has no table whose first column is "Event". ` +
        `The event list is checked against ${source}; restore the table or update this test.`,
    ).toBeDefined();
  });

  it("matches webhookEventSchema in both directions", () => {
    if (!table) return;

    const documented = new Map<string, number>();
    table.rows.forEach((row, index) => {
      const name = firstCodeSpan(row[0]);
      if (name) documented.set(name, table.line + 2 + index);
    });
    expect(
      documented.size,
      `parsed no event names out of the table at apps/docs/content/${page}:${table.line}`,
    ).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const event of webhookEventSchema.options) {
      if (!documented.has(event)) {
        violations.push(
          `\`${event}\` is in ${source} but the events table at apps/docs/content/${page}:${table.line} has no row for it.\n` +
            `An integrator cannot subscribe to an event they cannot find.`,
        );
      }
    }
    const events: readonly string[] = webhookEventSchema.options;
    for (const [event, line] of documented) {
      if (!events.includes(event)) {
        violations.push(
          `apps/docs/content/${page}:${line} lists \`${event}\`, which is not in ${source}.\n` +
            `That event never fires.`,
        );
      }
    }
    expectNoViolations(violations);
  });
});

// --- webhook event payloads --------------------------------------------------

/**
 * Every event's `data` example on the Webhooks page, pinned against the
 * declared payload it claims to show.
 *
 * The event names have been pinned in both directions for a while; the
 * examples beside them were prose, and an integrator writes their handler
 * against the example, not the name. A payload is one declaration now
 * (`webhookEventDataSchemas`), so the page can be held to it: an event whose
 * shape changes, or one that ships with no example at all, fails here rather
 * than at somebody's endpoint.
 *
 * An example is attributed to an event by the `"event"` key in its envelope,
 * or — for the short `data`-only blocks — to the last event named in a code
 * span above it. Write one of those two ways or this test cannot see it.
 */

/** A shape-bearing schema, and a union of them, without importing zod here. */
type ShapeLike = { shape: Record<string, unknown> };
type UnionLike = { options: ShapeLike[] };

/** The key sets one event's payload may take — more than one where it has two shapes. */
const declaredPayloadKeys = (event: WebhookEvent): string[][] => {
  const schema: unknown = webhookEventDataSchemas[event];
  const variants =
    schema !== null && typeof schema === "object" && "options" in schema
      ? (schema as UnionLike).options
      : [schema as ShapeLike];
  return variants.map((variant) => Object.keys(variant.shape).sort());
};

/** Each ```json fence in `content`, with the line its opening fence sits on. */
const jsonFences = (content: string): { line: number; text: string }[] => {
  const lines = content.split("\n");
  const fences: { line: number; text: string }[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() !== "```json") continue;
    const line = index + 1;
    const body: string[] = [];
    index++;
    while (index < lines.length && lines[index].trim() !== "```") {
      body.push(lines[index]);
      index++;
    }
    fences.push({ line, text: body.join("\n") });
  }
  return fences;
};

describe("webhook event payloads", () => {
  const page = "building-with-platypus/webhooks.mdx";
  const content = readDoc(page);
  const source = "packages/schemas/index.ts (webhookEventDataSchemas)";
  const events: readonly string[] = webhookEventSchema.options;

  /** The examples, each attributed to the event it documents. */
  const examples = jsonFences(content).flatMap(({ line, text }) => {
    const parsed = JSON.parse(text) as {
      event?: unknown;
      data?: unknown;
    };
    if (parsed.data === null || typeof parsed.data !== "object") return [];
    const named = typeof parsed.event === "string" ? parsed.event : undefined;
    // A `data`-only block belongs to the event the prose above it named.
    const preceding = content
      .split("\n")
      .slice(0, line - 1)
      .join("\n")
      .match(/`([a-z_]+\.[a-z]+)`/g)
      ?.map((span) => span.replaceAll("`", ""))
      .filter((span) => events.includes(span));
    const event = named ?? preceding?.at(-1);
    return event === undefined
      ? []
      : [{ event, line, keys: Object.keys(parsed.data).sort() }];
  });

  it("shows a payload for every event", () => {
    const violations: string[] = [];
    for (const event of webhookEventSchema.options) {
      const shown = examples.filter((example) => example.event === event);
      if (shown.length === 0) {
        violations.push(
          `\`${event}\` is in ${source} but apps/docs/content/${page} shows no example of its \`data\`.\n` +
            `An integrator writes their handler against the example.`,
        );
        continue;
      }
      // An event with two declared shapes needs both: the bulk
      // `notification.read` is the one a handler written against the singular
      // form drops silently.
      const variants = declaredPayloadKeys(event);
      for (const variant of variants) {
        if (!shown.some((example) => example.keys.join() === variant.join())) {
          violations.push(
            `\`${event}\` declares a payload shaped \`{ ${variant.join(", ")} }\` in ${source}, ` +
              `and apps/docs/content/${page} shows no example of it.\n` +
              `Each shape an event can take needs its own example.`,
          );
        }
      }
    }
    expectNoViolations(violations);
  });

  it("shows no payload the declaration does not describe", () => {
    const violations: string[] = [];
    for (const example of examples) {
      if (!events.includes(example.event)) {
        violations.push(
          `apps/docs/content/${page}:${example.line} documents \`${example.event}\`, which is not in ${source}.\n` +
            `That event never fires.`,
        );
        continue;
      }
      const variants = declaredPayloadKeys(example.event as WebhookEvent);
      if (variants.some((variant) => variant.join() === example.keys.join())) {
        continue;
      }
      violations.push(
        `apps/docs/content/${page}:${example.line} shows \`${example.event}\` carrying ` +
          `\`{ ${example.keys.join(", ")} }\`, but ${source} declares ` +
          `${variants.map((variant) => `\`{ ${variant.join(", ")} }\``).join(" or ")}.\n` +
          `The page is what an integrator writes their handler against.`,
      );
    }
    expectNoViolations(violations);
  });
});

// --- trigger event payloads --------------------------------------------------

/**
 * The Triggers page reproduces the prefix an Event trigger's Agent actually
 * receives, because there is no other way for a Workspace Owner to learn the
 * shape short of firing an event and reading the run. That makes the prefix a
 * quoted string with one authoritative source, so pin it: the docs show a
 * worked example, and the example's scaffolding has to be the scaffolding the
 * service builds.
 */
const TRIGGER_PREFIX_SOURCE = "apps/backend/src/services/trigger-firing.ts";
const CALLER_DATA_SOURCE = "apps/backend/src/services/caller-data.ts";

/**
 * The fixed text of the event prefix template, in order — the parts of the
 * template literal that are not interpolations, with escapes resolved.
 */
const parseEventPrefixSegments = (): string[] => {
  const source = readRepoFile(TRIGGER_PREFIX_SOURCE);
  const template = source.match(/effectiveInstruction\s*=[\s\S]*?`([^`]*)`/);
  if (!template) {
    throw new Error(
      `No \`effectiveInstruction = \` template literal in ${TRIGGER_PREFIX_SOURCE}. ` +
        `The prefix moved or stopped being a template; re-anchor this test.`,
    );
  }
  return template[1]
    .split(/\$\{[^}]*\}/)
    .map((segment) => segment.replace(/\\n/g, "\n").trim())
    .filter((segment) => segment.length > 0);
};

describe("trigger event payloads", () => {
  const page = "building-with-platypus/triggers.mdx";
  const content = readDoc(page);
  const segments = parseEventPrefixSegments();

  it("parsed the prefix template", () => {
    expect(
      segments.length,
      `Parsed no fixed text out of the event prefix in ${TRIGGER_PREFIX_SOURCE}. ` +
        `A test that checks nothing is worse than no test; re-anchor it.`,
    ).toBeGreaterThan(0);
  });

  it("shows the prefix the service builds", () => {
    const examples = fencedBlocks(content).filter((block) =>
      /^Event: \S/.test(block.text),
    );
    expect(
      examples.length,
      `apps/docs/content/${page} has ${examples.length} fenced blocks starting with ` +
        `"Event: ". This check reads one — it is the worked example of the prefix ` +
        `built in ${TRIGGER_PREFIX_SOURCE}.`,
    ).toBe(1);

    const example = examples[0];
    const violations: string[] = [];
    for (const segment of segments) {
      if (!example.text.includes(segment)) {
        violations.push(
          `apps/docs/content/${page}:${example.line} does not contain ${JSON.stringify(segment)}, ` +
            `but ${TRIGGER_PREFIX_SOURCE} puts it in the prefix every Event trigger sends.\n` +
            `An Instruction written against the wrong prefix refers to text the Agent never sees.`,
        );
      }
    }
    const named = example.text.match(/^Event: (\S+)/);
    const events: readonly string[] = eventTriggerEventSchema.options;
    if (named && !events.includes(named[1])) {
      violations.push(
        `apps/docs/content/${page}:${example.line} works the example through \`${named[1]}\`, ` +
          `which is not in packages/schemas/index.ts (eventTriggerEventSchema).\n` +
          `No Event trigger fires on it.`,
      );
    }
    expectNoViolations(violations);
  });

  it("names only events that exist", () => {
    const namespaces = new Set(
      webhookEventSchema.options.map((event) => event.split(".")[0]),
    );
    const looksLikeEvent = new RegExp(
      `^(?:${[...namespaces].join("|")})\\.[A-Za-z.]+$`,
    );
    const events: readonly string[] = webhookEventSchema.options;

    const violations: string[] = [];
    for (const span of inlineCodeSpans(content)) {
      if (!looksLikeEvent.test(span.text)) continue;
      if (events.includes(span.text)) continue;
      violations.push(
        `apps/docs/content/${page}:${span.line} mentions \`${span.text}\`, which is not in ` +
          `packages/schemas/index.ts (webhookEventSchema).\n` +
          `A Trigger cannot subscribe to an event that never fires.`,
      );
    }
    expectNoViolations(violations);
  });
});

// --- core plugins ------------------------------------------------------------

/**
 * Read the plugin names out of the backend registry as text rather than
 * importing it — the module pulls in the plugin SDK, and the docs package has
 * no business depending on the backend to check a list of five strings.
 */
const BUILTIN_SOURCE = "apps/backend/src/plugins/builtin.ts";

/**
 * The literal between `export const <name>` and the `};` / `];` that closes it.
 *
 * Anchored on the declaration, not on the first mention of the name: the
 * registry's own comments cross-reference both constants, and matching a comment
 * would silently read the neighbouring literal — producing confident failures
 * that blame the docs for a table that was right.
 */
const exportedLiteral = (content: string, name: string): string => {
  const start = content.search(new RegExp(`export const ${name}\\b`));
  if (start === -1) {
    throw new Error(
      `No \`export const ${name}\` in ${BUILTIN_SOURCE}. It was renamed or moved; ` +
        `update this test rather than trusting what it parses.`,
    );
  }
  const body = content.slice(start);
  return body.slice(0, body.search(/[}\]];/));
};

const parseBuiltinPluginNames = (): string[] => {
  const literal = exportedLiteral(
    readRepoFile(BUILTIN_SOURCE),
    "BUILTIN_PLUGINS",
  );
  return [...literal.matchAll(/"(@platypus\/[a-z0-9-]+)":/g)].map(
    (match) => match[1],
  );
};

const parseAlwaysOnPluginNames = (): string[] => {
  const literal = exportedLiteral(
    readRepoFile(BUILTIN_SOURCE),
    "ALWAYS_ON_PLUGINS",
  );
  return [...literal.matchAll(/"(@platypus\/[a-z0-9-]+)"/g)].map(
    (match) => match[1],
  );
};

// --- inbound triggers --------------------------------------------------------

/**
 * The header of the block an Inbound Trigger's inputs arrive in. An
 * Instruction is written against it ("the inputs above"), so the worked example
 * on the Triggers page must show the header the service actually writes.
 */
const parseInboundInputsHeader = (): string => {
  const label = readRepoFile(TRIGGER_PREFIX_SOURCE).match(
    /callerDataBlock\(\s*"(Inbound call inputs[^"]*)"/,
  );
  if (!label) {
    throw new Error(
      `No callerDataBlock("Inbound call inputs", …) in ${TRIGGER_PREFIX_SOURCE}. ` +
        `The inputs block moved or was renamed; re-anchor this test.`,
    );
  }
  const caveat = readRepoFile(CALLER_DATA_SOURCE).match(/`\$\{label\}([^`]*)`/);
  if (!caveat) {
    throw new Error(
      `No \`\${label}…\` header template in ${CALLER_DATA_SOURCE}. ` +
        `The caveat moved or was reworded; re-anchor this test.`,
    );
  }
  return label[1] + caveat[1];
};

describe("inbound trigger inputs block", () => {
  const page = "building-with-platypus/triggers.mdx";

  it("shows the header the service writes", () => {
    const header = parseInboundInputsHeader();
    const examples = fencedBlocks(readDoc(page)).filter((block) =>
      block.text.startsWith("Inbound call inputs"),
    );
    expect(
      examples.length,
      `apps/docs/content/${page} has ${examples.length} fenced blocks starting with ` +
        `"Inbound call inputs". This check reads one — the worked example of the ` +
        `block built in ${TRIGGER_PREFIX_SOURCE}.`,
    ).toBe(1);
    expect(
      examples[0].text.split("\n")[0],
      `apps/docs/content/${page}:${examples[0].line} does not open with the header ` +
        `${TRIGGER_PREFIX_SOURCE} writes above an Inbound Trigger's Instruction.`,
    ).toBe(header);
  });
});

const CALL_LOG_PAGE = "reference/backend-configuration.mdx";

/** Each call log the reference documents, and where its source writes it. */
const CALL_LOGS = [
  {
    name: "inbound trigger call log",
    source: "apps/backend/src/services/inbound-trigger.ts",
    heading: "#### The inbound call log",
    messageConst: "INBOUND_CALL_LOG_MESSAGE",
    outcomeType: "InboundCallOutcome",
    reasonType: "InboundRejectReason",
  },
  {
    name: "A2A call log",
    source: "apps/backend/src/services/a2a-call.ts",
    heading: "#### The A2A call log",
    messageConst: "A2A_CALL_LOG_MESSAGE",
    outcomeType: "A2aCallOutcome",
    reasonType: "A2aRejectReason",
  },
];

/** The string members of a `export type X = "a" | "b"` union in the source. */
const unionMembers = (
  source: string,
  typeName: string,
  path: string,
): string[] => {
  // Comments first: a `;` inside a member's doc comment would end the match.
  const declaration = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .match(new RegExp(`export type ${typeName} =([\\s\\S]*?);`));
  if (!declaration) {
    throw new Error(
      `No \`export type ${typeName}\` in ${path}; re-anchor this test.`,
    );
  }
  return [...declaration[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
};

/**
 * The call logs are the log output Platypus promises Operators not to break:
 * they ship them to their own store and build on their message, fields and
 * values. So the reference must name every one of them, and name no value the
 * backend never writes.
 */
describe.each(CALL_LOGS)("$name", (log) => {
  const source = readRepoFile(log.source);
  const content = readDoc(CALL_LOG_PAGE);
  const start = content.indexOf(log.heading);
  const rest = start === -1 ? "" : content.slice(start + log.heading.length);
  const nextHeading = rest.search(/\n#{1,4} /);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const spans = new Set(
    [...section.matchAll(/`([^`]+)`/g)].map((match) => match[1]),
  );

  const message = source.match(
    new RegExp(`${log.messageConst} = "([^"]+)"`),
  )?.[1];
  const logCall = source.match(
    new RegExp(
      `logger\\.info\\(\\s*\\{([\\s\\S]*?)\\},\\s*${log.messageConst}`,
    ),
  );
  const fields = logCall
    ? [...logCall[1].matchAll(/^\s*(\w+):/gm)].map((match) => match[1])
    : [];
  const outcomes = unionMembers(source, log.outcomeType, log.source);
  const reasons = unionMembers(source, log.reasonType, log.source);

  it("found the section and the source's vocabulary", () => {
    expect(start, `No "${log.heading}" in ${CALL_LOG_PAGE}.`).not.toBe(-1);
    expect(message, `No ${log.messageConst} in ${log.source}.`).toBeDefined();
    expect(fields.length).toBeGreaterThan(0);
    expect(outcomes.length).toBeGreaterThan(0);
    expect(reasons.length).toBeGreaterThan(0);
  });

  it("names the message, every field, every outcome and every reason", () => {
    const missing = [message ?? "", ...fields, ...outcomes, ...reasons].filter(
      (value) => !spans.has(value),
    );
    expectNoViolations(
      missing.map(
        (value) =>
          `apps/docs/content/${CALL_LOG_PAGE} (${log.heading}) does not name \`${value}\`, ` +
          `which ${log.source} writes on the call log line.\n` +
          `An Operator's log tooling built from the reference misses it.`,
      ),
    );
  });

  it("lists no reason the backend never writes", () => {
    const rows = [...section.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map(
      (match) => match[1],
    );
    const documented = rows.filter((value) => !fields.includes(value));
    expectNoViolations(
      documented
        .filter((value) => !reasons.includes(value))
        .map(
          (value) =>
            `apps/docs/content/${CALL_LOG_PAGE} (${log.heading}) lists the reason ` +
            `\`${value}\`, which is not in ${log.source} (${log.reasonType}).`,
        ),
    );
  });
});

describe("core plugins", () => {
  const registered = parseBuiltinPluginNames();
  const alwaysOn = parseAlwaysOnPluginNames();

  it("parsed the registry", () => {
    expect(
      registered.length,
      `Parsed no plugin names out of ${BUILTIN_SOURCE} (BUILTIN_PLUGINS). The registry's shape changed; update this test.`,
    ).toBeGreaterThan(0);
    expect(
      alwaysOn.length,
      `Parsed no plugin names out of ${BUILTIN_SOURCE} (ALWAYS_ON_PLUGINS). The registry's shape changed; update this test.`,
    ).toBeGreaterThan(0);
  });

  it("mentions every registered core plugin somewhere in the docs", () => {
    const mentioned = new Map<string, string>(); // name -> "page:line"
    for (const doc of DOCS) {
      readDoc(doc)
        .split("\n")
        .forEach((line, index) => {
          for (const match of line.matchAll(/@platypus\/[a-z0-9-]+/g)) {
            if (!mentioned.has(match[0])) {
              mentioned.set(match[0], `${doc}:${index + 1}`);
            }
          }
        });
    }

    const violations: string[] = [];
    for (const name of registered) {
      if (!mentioned.has(name)) {
        violations.push(
          `\`${name}\` is registered in ${BUILTIN_SOURCE} but no page under apps/docs/content mentions it.\n` +
            `An Operator cannot enable a plugin they have never heard of — document it in reference/backend-configuration.mdx and self-hosting/configuration.mdx.`,
        );
      }
    }
    for (const [name, origin] of mentioned) {
      if (!registered.includes(name)) {
        violations.push(
          `apps/docs/content/${origin} mentions \`${name}\`, which ${BUILTIN_SOURCE} does not register.\n` +
            `Either the plugin was renamed or removed, or the page invented it.`,
        );
      }
    }
    expectNoViolations(violations);
  });

  // A mention anywhere is a weak floor: a plugin named once in an upgrade note
  // still leaves the Operator-facing list a row short. Configuration.mdx says
  // "This page owns the list", so that table is checked row by row, tier
  // included — which is the only thing pinning ALWAYS_ON_PLUGINS.
  it("keeps the core-plugin table in step with the registry, tier included", () => {
    const page = "self-hosting/configuration.mdx";
    const table = tableByFirstColumn(readDoc(page), "Plugin");
    expect(
      table,
      `apps/docs/content/${page} has no table whose first column is "Plugin". ` +
        `The core plugin list is checked against ${BUILTIN_SOURCE}; restore the table or update this test.`,
    ).toBeDefined();
    if (!table) return;

    const tierColumn = table.header.indexOf("Tier");
    expect(
      tierColumn,
      `The core plugin table at apps/docs/content/${page}:${table.line} has no "Tier" column ` +
        `to check against ALWAYS_ON_PLUGINS in ${BUILTIN_SOURCE}.`,
    ).toBeGreaterThan(-1);

    const listed = new Map<string, { tier: string; line: number }>();
    table.rows.forEach((row, index) => {
      const name = firstCodeSpan(row[0]);
      if (name) {
        listed.set(name, {
          tier: row[tierColumn],
          line: table.line + 2 + index,
        });
      }
    });

    const violations: string[] = [];
    for (const name of registered) {
      if (!listed.has(name)) {
        violations.push(
          `\`${name}\` is registered in ${BUILTIN_SOURCE} but the core plugin table at apps/docs/content/${page}:${table.line} has no row for it.\n` +
            `A missing row is invisible — the Operator cannot deny or enable what the list never showed them.`,
        );
      }
    }
    for (const [name, row] of listed) {
      if (!registered.includes(name)) {
        violations.push(
          `apps/docs/content/${page}:${row.line} lists \`${name}\`, which ${BUILTIN_SOURCE} does not register.\n` +
            `That plugin cannot be loaded.`,
        );
        continue;
      }
      const expectedTier = alwaysOn.includes(name) ? "Always-on" : "Gate-able";
      if (row.tier !== expectedTier) {
        violations.push(
          `apps/docs/content/${page}:${row.line} puts \`${name}\` in the "${row.tier}" tier, ` +
            `but ALWAYS_ON_PLUGINS in ${BUILTIN_SOURCE} makes it "${expectedTier}".\n` +
            `Listing an always-on plugin in PLATYPUS_PLUGINS is fail-loud at boot, so this misdirects an Operator into a backend that will not start.`,
        );
      }
    }
    expectNoViolations(violations);
  });
});

// --- field limits ------------------------------------------------------------

type ZodBounds = {
  minLength?: number | null;
  maxLength?: number | null;
  minValue?: number | null;
  maxValue?: number | null;
};

/**
 * Unwrap `.optional()` / `.nullable()` so the bound accessors underneath are
 * reachable.
 */
const unwrap = (schema: unknown): ZodBounds => {
  let current = schema as { unwrap?: () => unknown };
  while (typeof current?.unwrap === "function") {
    current = current.unwrap() as { unwrap?: () => unknown };
  }
  return current as ZodBounds;
};

/**
 * The bounds a Zod field enforces, read off whichever pair of accessors its
 * type uses — `minLength`/`maxLength` for a string, `minValue`/`maxValue` for a
 * number.
 *
 * Throws rather than returning empty bounds. If Zod moves these accessors, an
 * expectation of `{}` would satisfy every claim below and the whole section
 * would go quietly green — the exact failure this file exists to prevent.
 */
const boundedField = (
  schema: { shape: Record<string, unknown> },
  field: string,
  accessors: { min: keyof ZodBounds; max: keyof ZodBounds },
): { min?: number; max?: number } => {
  if (schema.shape[field] === undefined) {
    throw new Error(
      `No field \`${field}\` on that Zod shape. It was renamed or removed — ` +
        `re-point the claim, or drop it if the field is gone.`,
    );
  }
  const bounds = unwrap(schema.shape[field]);
  const min = bounds[accessors.min] ?? undefined;
  const max = bounds[accessors.max] ?? undefined;
  if (min === undefined && max === undefined) {
    throw new Error(
      `Read no min or max off the Zod field \`${field}\`. Either the schema stopped ` +
        `bounding it, or Zod moved ${accessors.min}/${accessors.max} — fix this helper before trusting the suite.`,
    );
  }
  return { min, max };
};

/** The `min`/`max` a Zod string field enforces, whatever it is wrapped in. */
const stringField = (
  schema: { shape: Record<string, unknown> },
  field: string,
): { min?: number; max?: number } =>
  boundedField(schema, field, { min: "minLength", max: "maxLength" });

/**
 * The `min`/`max` a Zod number field enforces. A number's bounds live on
 * different accessors from a string's, and reading a number through
 * `stringField` throws rather than quietly reporting no bounds — which is why
 * this sibling exists rather than one helper guessing.
 */
const numberField = (
  schema: { shape: Record<string, unknown> },
  field: string,
): { min?: number; max?: number } =>
  boundedField(schema, field, { min: "minValue", max: "maxValue" });

type LimitClaim = {
  doc: string;
  /** Unique substring identifying the block that makes the claim. */
  anchor: string;
  source: string;
  expected: { min?: number; max?: number };
};

/**
 * Only limits worth keeping are pinned. Where a page deliberately omits a bound
 * — a Trigger instruction has a `min(1)` no reader will ever hit — the claim
 * simply does not carry that number, and neither does the expectation.
 */
const LIMIT_CLAIMS: LimitClaim[] = [
  {
    doc: "self-hosting/users-and-access.mdx",
    anchor: "**Not signed in** — a short form",
    source:
      "packages/schemas/index.ts (invitationRedemptionRegisterSchema.password)",
    expected: {
      min: stringField(invitationRedemptionRegisterSchema, "password").min,
    },
  },
  {
    doc: "building-with-platypus/agents.mdx",
    anchor: "**Name** — what to call the Agent",
    source: "packages/schemas/index.ts (agentSchema.name)",
    expected: stringField(agentSchema, "name"),
  },
  {
    doc: "building-with-platypus/agents.mdx",
    anchor: "**Description** — a short summary",
    source: "packages/schemas/index.ts (agentSchema.description)",
    expected: stringField(agentSchema, "description"),
  },
  {
    // The Skill floors are 1 — "can't be empty", stated in words on the page,
    // not as a range — so only the ceilings are pinned here.
    doc: "building-with-platypus/skills.mdx",
    anchor: "**Name** — a kebab-case identifier",
    source: "packages/schemas/index.ts (skillSchema.name)",
    expected: { max: stringField(skillSchema, "name").max },
  },
  {
    doc: "building-with-platypus/skills.mdx",
    anchor: "**Description** — a brief summary of what the Skill does",
    source: "packages/schemas/index.ts (skillSchema.description)",
    expected: { max: stringField(skillSchema, "description").max },
  },
  {
    doc: "building-with-platypus/skills.mdx",
    anchor: "**Body** — the full instructions",
    source: "packages/schemas/index.ts (skillSchema.body)",
    expected: { max: stringField(skillSchema, "body").max },
  },
  {
    doc: "building-with-platypus/skills.mdx",
    anchor: "**Argument hint** _(optional)_",
    source: "packages/schemas/index.ts (skillSchema.argumentHint)",
    expected: { max: stringField(skillSchema, "argumentHint").max },
  },
  {
    doc: "building-with-platypus/mcp.mdx",
    anchor: "**Name** — a label for this server",
    source: "packages/schemas/index.ts (mcpSchema.name)",
    expected: stringField(mcpSchema, "name"),
  },
  {
    doc: "building-with-platypus/boards.mdx",
    anchor: "**Name** — what to call the board",
    source: "packages/schemas/index.ts (kanbanBoardSchema.name)",
    expected: stringField(kanbanBoardSchema, "name"),
  },
  {
    doc: "building-with-platypus/boards.mdx",
    anchor: "**Description** _(optional)_ — up to",
    source: "packages/schemas/index.ts (kanbanBoardSchema.description)",
    expected: { max: stringField(kanbanBoardSchema, "description").max },
  },
  {
    doc: "building-with-platypus/dashboards.mdx",
    anchor: "**Name** — must be unique within the Workspace",
    source: "packages/schemas/index.ts (dashboardCreateSchema.name)",
    expected: stringField(dashboardCreateSchema, "name"),
  },
  {
    doc: "building-with-platypus/dashboards.mdx",
    anchor: "**Description** _(optional)_ — up to",
    source: "packages/schemas/index.ts (dashboardCreateSchema.description)",
    expected: { max: stringField(dashboardCreateSchema, "description").max },
  },
  {
    doc: "building-with-platypus/triggers.mdx",
    anchor: "**Instruction** — the message sent to the Agent",
    source: "packages/schemas/index.ts (triggerSchema.instruction)",
    expected: { max: stringField(triggerSchema, "instruction").max },
  },
  {
    doc: "administering/workspaces.mdx",
    anchor: "**Name** — what to call it",
    source: "packages/schemas/index.ts (workspaceSchema.name)",
    expected: stringField(workspaceSchema, "name"),
  },
  {
    doc: "administering/workspaces.mdx",
    anchor: "**Context** is text about the **Workspace**",
    source: "packages/schemas/index.ts (workspaceSchema.context)",
    expected: { max: stringField(workspaceSchema, "context").max },
  },
  {
    doc: "self-hosting/providers-and-auth.mdx",
    anchor: "`maxExtractedTextChars`",
    source: "packages/schemas/index.ts (DEFAULT_MAX_EXTRACTED_TEXT_CHARS)",
    expected: { max: DEFAULT_MAX_EXTRACTED_TEXT_CHARS },
  },
  {
    doc: "self-hosting/providers-and-auth.mdx",
    anchor: "`contextWindow`",
    source: "packages/schemas/index.ts (modelConfigSchema.contextWindow)",
    expected: numberField(modelConfigSchema, "contextWindow"),
  },
  {
    doc: "building-with-platypus/chat.mdx",
    anchor: "**Max steps** caps how many steps",
    source: "packages/schemas/index.ts (chatSchema.maxSteps)",
    expected: numberField(chatSchema, "maxSteps"),
  },
  {
    // Its own paragraph, not the bound's: a block states one limit, and the
    // range above would be the number read from a shared one.
    doc: "building-with-platypus/chat.mdx",
    anchor: "Leave it empty and a default of",
    source: "packages/schemas/index.ts (DEFAULT_DIRECT_MAX_STEPS)",
    expected: { max: DEFAULT_DIRECT_MAX_STEPS },
  },
  {
    doc: "building-with-platypus/triggers.mdx",
    anchor: "a name — letters, digits and underscores",
    source: "packages/schemas/index.ts (inboundTriggerInputSchema.name)",
    expected: { max: stringField(inboundTriggerInputSchema, "name").max },
  },
  {
    doc: "building-with-platypus/triggers.mdx",
    anchor: "a description — up to",
    source: "packages/schemas/index.ts (inboundTriggerInputSchema.description)",
    expected: {
      max: stringField(inboundTriggerInputSchema, "description").max,
    },
  },
  {
    doc: "building-with-platypus/a2a-endpoints.mdx",
    anchor: "**Name** — what callers see",
    source: "packages/schemas/index.ts (a2aEndpointSchema.name)",
    expected: { max: stringField(a2aEndpointSchema, "name").max },
  },
  {
    doc: "building-with-platypus/a2a-endpoints.mdx",
    anchor: "**Description** — what callers see",
    source: "packages/schemas/index.ts (a2aEndpointSchema.description)",
    expected: { max: stringField(a2aEndpointSchema, "description").max },
  },
  {
    doc: "building-with-platypus/a2a-endpoints.mdx",
    anchor: "Under **Tokens**, name the token",
    source: "packages/schemas/index.ts (a2aTokenSchema.name)",
    expected: { max: stringField(a2aTokenSchema, "name").max },
  },
];

// A claim with no bound to compare is a test that always passes. Catch it here,
// at module load, rather than letting it sit green in the report.
for (const claim of LIMIT_CLAIMS) {
  if (claim.expected.min === undefined && claim.expected.max === undefined) {
    throw new Error(
      `The limit claim "${claim.anchor}" in ${claim.doc} carries no expected bound, ` +
        `so it would assert nothing. Its source is ${claim.source}.`,
    );
  }
}

/**
 * The block making a claim: the anchor's line plus any continuation lines, so
 * a limit that wrapped onto the next line is still found. Prose wraps; the
 * claim should not have to care.
 */
const blockContaining = (
  content: string,
  anchor: string,
): Located | undefined => {
  // Fenced blocks are blanked first: an example snippet must not be mistaken
  // for the page's claim about a real limit.
  const lines = withoutCodeFences(content).split("\n");
  const start = lines.findIndex((line) => line.includes(anchor));
  if (start === -1) return undefined;

  const collected = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*([-*+]\s|\||#|<|```)/.test(line)) break;
    collected.push(line);
  }
  return { text: collected.join(" "), line: start + 1 };
};

/** Normalise en/em dashes and thousands separators before reading numbers. */
const normaliseNumbers = (text: string): string =>
  text
    .replace(/[‒–—―]/g, "-") // figure, en, em, horizontal bar
    // Lookahead rather than a capture: the match must not consume the digit a
    // following separator needs, or `1,234,567` strips to `1234,567`.
    .replace(/(\d),(?=\d)/g, "$1");

/**
 * The units a limit can be stated in. A character count, a token count, and a
 * step count are all bounds a reader is rejected by, and none of these pages
 * would thank us for restating its number in another's unit.
 */
const LIMIT_UNIT = "(?:characters|tokens|steps)";

const readClaimedLimits = (
  text: string,
): { min?: number; max?: number } | undefined => {
  const normalised = normaliseNumbers(text);
  const range = normalised.match(
    new RegExp(`(\\d+)\\s*-\\s*(\\d+)\\s*${LIMIT_UNIT}`),
  );
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const upTo = normalised.match(
    new RegExp(`(?:up to|default)[^.]*?(\\d+)\\s*${LIMIT_UNIT}`),
  );
  if (upTo) return { max: Number(upTo[1]) };
  // A floor with no ceiling — a password minimum states one bound and the
  // reader never meets the other.
  const atLeast = normalised.match(
    new RegExp(`at least[^.]*?(\\d+)\\s*${LIMIT_UNIT}`),
  );
  if (atLeast) return { min: Number(atLeast[1]) };
  return undefined;
};

describe("field limits", () => {
  it.each(LIMIT_CLAIMS)("$doc — $anchor", (claim) => {
    const content = readDoc(claim.doc);
    const block = blockContaining(content, claim.anchor);
    expect(
      block,
      `apps/docs/content/${claim.doc} no longer contains "${claim.anchor}". ` +
        `The limit from ${claim.source} was pinned to that text — re-anchor this claim or drop it.`,
    ).toBeDefined();
    if (!block) return;

    const claimed = readClaimedLimits(block.text);
    expect(
      claimed,
      `apps/docs/content/${claim.doc}:${block.line} states no character limit, ` +
        `but one was pinned to ${claim.source}. Restore the limit or drop this claim from the test.`,
    ).toBeDefined();
    if (!claimed) return;

    const violations: string[] = [];
    for (const bound of ["min", "max"] as const) {
      const expected = claim.expected[bound];
      if (expected === undefined) continue;
      if (claimed[bound] !== expected) {
        violations.push(
          `apps/docs/content/${claim.doc}:${block.line} claims a ${bound} of ${claimed[bound] ?? "(none)"}, ` +
            `but ${claim.source} says ${expected}.\n` +
            `A reader trusting the page is rejected by a limit the docs got wrong.`,
        );
      }
    }
    expectNoViolations(violations);
  });
});

// --- the plugin naming caps --------------------------------------------------

/**
 * A third-party plugin's tool names enter a Chat turn namespaced under its
 * manifest name (issue #664), and each half of that composed name is capped. The
 * two numbers are what a plugin author sizes their manifest and their tools
 * against, and getting one wrong does not surface as a warning — the deployment
 * refuses to boot.
 *
 * Checked the way the closer timeout is: one constant, every surface that quotes
 * it. A page saying "24 characters" while core enforces 20 sends an author to
 * rename something that was already short enough, and leaves the real cap
 * undocumented.
 *
 * The surface lists are short on purpose. Every other page that mentions a cap
 * says "over its cap" and links here, because a number restated on five pages
 * rots on four of them — so this pins the two places a reader is actually
 * standing when they need the figure, and nowhere else.
 */
const NAMING_CAPS = [
  {
    constant: "MAX_PLUGIN_NAME_LENGTH",
    value: MAX_PLUGIN_NAME_LENGTH,
    subject: "a third-party plugin's manifest name",
    // The tool-name page composes it; the plugin-API page is where an author
    // chooses the name in the first place.
    surfaces: [
      "extending/tool-sets.mdx",
      "extending/plugin-api-and-config.mdx",
    ],
  },
  {
    constant: "MAX_PLUGIN_TOOL_NAME_LENGTH",
    value: MAX_PLUGIN_TOOL_NAME_LENGTH,
    subject: "a tool name in a third-party Tool set",
    surfaces: ["extending/tool-sets.mdx"],
  },
] as const;

describe("the plugin naming caps", () => {
  it.each(
    NAMING_CAPS.flatMap((cap) => cap.surfaces.map((doc) => ({ ...cap, doc }))),
  )("$doc states the cap on $subject", ({ doc, value, constant, subject }) => {
    // "24 characters" and "24-character cap" both satisfy this; a stale number
    // satisfies neither.
    expect(
      new RegExp(`\\b${value}[ -]character`).test(readDoc(doc)),
      `apps/docs/content/${doc} does not state ${value} characters, but ` +
        `packages/schemas/index.ts sets ${constant} to ${value} — the cap on ${subject}.\n` +
        `An author sizing against the stale figure has their deployment refuse to boot.`,
    ).toBe(true);
  });

  it("shows the separator core actually namespaces with", () => {
    // The shape an author reads their tool names off. `__` is also why a
    // namespaced name renders in the UI with no separator showing, so changing
    // it changes more than one thing.
    expect(
      readDoc("extending/tool-sets.mdx").includes(
        `<manifest-name>${TOOL_NAME_NAMESPACE_SEPARATOR}<toolName>`,
      ),
      `apps/docs/content/extending/tool-sets.mdx does not show ` +
        `\`<manifest-name>${TOOL_NAME_NAMESPACE_SEPARATOR}<toolName>\`, but that is the shape ` +
        `TOOL_NAME_NAMESPACE_SEPARATOR composes. An author cannot guess the separator.`,
    ).toBe(true);
  });

  // The third limit a third-party tool name is held to, alongside the two caps.
  // It is stated in prose rather than as a regex, because an author has to read
  // it — so it is checked against the pattern in both directions here, or the
  // prose is free to drift from what boot enforces.
  it("states the character rule the pattern enforces", () => {
    const PROSE = "letters, digits, underscores and hyphens";

    expect(
      TOOL_NAME_PATTERN.test("aZ9_-"),
      `TOOL_NAME_PATTERN rejects one of the characters ` +
        `apps/docs/content/extending/tool-sets.mdx promises ("${PROSE}").`,
    ).toBe(true);
    expect(
      TOOL_NAME_PATTERN.test("has.a.dot"),
      `TOOL_NAME_PATTERN now accepts a "."; the page still promises only "${PROSE}".`,
    ).toBe(false);
    expect(
      readDoc("extending/tool-sets.mdx").includes(PROSE),
      `apps/docs/content/extending/tool-sets.mdx does not say "${PROSE}", but ` +
        `TOOL_NAME_PATTERN refuses a tool name outside that set at boot.\n` +
        `An enforced limit no page states is one an author meets as a failed deploy.`,
    ).toBe(true);
  });
});

// --- the closer timeout ------------------------------------------------------

/**
 * How long a Plugin's teardown gets before core abandons it is one line of core
 * and four surfaces that quote it — two docs pages, the SDK readme, and the ADR
 * that decided it. It is a judgement call, so it will be revisited, and an author
 * who sizes their teardown against a stale figure gets no error for it: their
 * close is simply cut off half-done.
 */
const CLOSER_SOURCE = "apps/backend/src/tools/closers.ts";

const CLOSER_TIMEOUT_SURFACES = [
  {
    file: "apps/docs/content/extending/tool-sets.mdx",
    phrase: (seconds: number) => `${seconds} seconds`,
  },
  {
    file: "apps/docs/content/extending/web-search-backends.mdx",
    phrase: (seconds: number) => `${seconds} seconds`,
  },
  {
    file: "packages/plugin-sdk/README.md",
    phrase: (seconds: number) => `${seconds} seconds`,
  },
  {
    file: "docs/adr/0014-web-search-backend-extension-point.md",
    phrase: (seconds: number) => `(${seconds}s)`,
  },
] as const;

describe("the closer timeout", () => {
  const declared = readRepoFile(CLOSER_SOURCE).match(
    /CLOSER_TIMEOUT_MS = ([\d_]+)/,
  );

  it("has a constant to quote", () => {
    expect(
      declared,
      `No \`CLOSER_TIMEOUT_MS = <ms>\` in ${CLOSER_SOURCE}. Four surfaces state ` +
        `that number for Plugin authors — re-anchor this test if it moved.`,
    ).not.toBeNull();
  });

  it.each(CLOSER_TIMEOUT_SURFACES)("$file states it", ({ file, phrase }) => {
    if (!declared) return;
    const expected = phrase(Number(declared[1].replace(/_/g, "")) / 1_000);
    expect(
      readRepoFile(file).includes(expected),
      `${file} does not say "${expected}", but ${CLOSER_SOURCE} sets ` +
        `CLOSER_TIMEOUT_MS to ${declared[1]}ms.\n` +
        `An author sizing their teardown against the stale figure has their ` +
        `close cut off with nothing to tell them why.`,
    ).toBe(true);
  });
});

// --- backend constants the concept pages quote -------------------------------

/** How the pages spell small counts. */
const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

/** A page's text with line wraps folded, so a phrase survives a reflow. */
const proseOf = (file: string): string => readDoc(file).replace(/\s+/g, " ");

/**
 * Numbers a reader plans around that live only as a backend constant, not in a
 * schema this file can import. Each is read as `NAME = <product of integers>`
 * and rendered into the phrase the page uses.
 */
const BACKEND_CONSTANTS = [
  {
    source: "apps/backend/src/services/memory-retrieval.ts",
    name: "MEMORY_SNAPSHOT_RE_PIN_HORIZON_MS",
    phrase: (ms: number) =>
      ms === 3_600_000 ? "an hour" : `${ms / 3_600_000} hours`,
    files: ["concepts/memory-and-context.mdx", "concepts/system-prompt.mdx"],
    cost: "A reader waiting out the stated idle gap for fresh Memories waits the wrong time.",
  },
  {
    source: "apps/backend/src/services/memory-retrieval.ts",
    name: "MEMORY_SUMMARY_WINDOW_DAYS",
    phrase: (days: number) => `**${days} days**`,
    files: ["concepts/memory-and-context.mdx"],
    cost: "A reader who switched Memory off expects old summaries to leave the prompt on the stated schedule.",
  },
  {
    source: "apps/backend/src/services/file-extraction.ts",
    name: "MAX_EXTRACTION_INPUT_BYTES",
    phrase: (bytes: number) => `**${bytes / 1024 / 1024} MiB**`,
    files: ["concepts/providers.mdx"],
    cost: "A reader attaching a large PDF is refused at a size the page never warned of.",
  },
  {
    source: "apps/backend/src/sandbox/index.ts",
    name: "MAX_SHELL_OUTPUT_BYTES",
    phrase: (bytes: number) => `**${bytes.toLocaleString("en-US")} bytes**`,
    files: ["extending/sandbox-backends.mdx"],
    cost: "A backend author truncating at the stated cap disagrees with every other adapter about `truncated`.",
  },
  {
    source: "apps/backend/src/sandbox/index.ts",
    name: "MAX_READ_BYTES",
    phrase: (bytes: number) => `**${bytes.toLocaleString("en-US")} bytes**`,
    files: ["extending/sandbox-backends.mdx"],
    cost: "A backend author truncating at the stated cap disagrees with every other adapter about `truncated`.",
  },
  {
    source: "packages/plugin-sdk/index.ts",
    name: "SANDBOX_TRANSFER_MAX_BYTES",
    phrase: (bytes: number) => `**${bytes / 1024 / 1024} MiB**`,
    files: ["concepts/sandboxes.mdx", "building-with-platypus/chat.mdx"],
    cost: "A User uploading a large file is refused at a size the page never warned of.",
  },
  {
    source: "apps/backend/src/sandbox/index.ts",
    name: "MAX_LIST_ENTRIES",
    phrase: (entries: number) =>
      `**${entries.toLocaleString("en-US")} entries**`,
    files: ["extending/sandbox-backends.mdx"],
    cost: "A backend author truncating at the stated cap disagrees with every other adapter about `truncated`.",
  },
  {
    source: "apps/backend/src/runs/no-progress.ts",
    name: "DEFAULT_NO_PROGRESS_THRESHOLD",
    phrase: (count: number) => `${NUMBER_WORDS[count] ?? count} times`,
    files: ["building-with-platypus/triggers.mdx"],
    cost: "A reader debugging a _Failed_ run looks for the wrong number of repeats.",
  },
  {
    source: "apps/backend/src/jobs/scheduler.ts",
    name: "RECOVERY_STALE_BUFFER_MS",
    phrase: (ms: number) =>
      `${NUMBER_WORDS[ms / 60_000] ?? ms / 60_000} minutes`,
    files: [
      "building-with-platypus/triggers.mdx",
      "reference/backend-configuration.mdx",
    ],
    cost: "An integrator waits the wrong time for a stuck record to take calls again.",
  },
  {
    source: "apps/backend/src/services/trigger.ts",
    name: "MAX_PENDING_ONE_OFF_TRIGGERS",
    phrase: (count: number) => `at most **${count}** One-off Triggers`,
    files: ["building-with-platypus/triggers.mdx"],
    cost: "A Workspace Owner is refused a One-off Trigger at a count the page never warned of.",
  },
  {
    source: "apps/backend/src/services/trigger.ts",
    name: "FIRED_ONE_OFF_TTL_DAYS",
    phrase: (days: number) => `with its run, **${days} days**`,
    files: ["building-with-platypus/triggers.mdx"],
    cost: "A Workspace Owner goes looking for a fired One-off Trigger after it was already deleted.",
  },
  {
    source: "apps/backend/src/services/a2a-push.ts",
    name: "MAX_PUSH_CONFIGS_PER_TASK",
    phrase: (count: number) => `**Up to ${count} URLs per Task.**`,
    files: ["building-with-platypus/a2a-endpoints.mdx"],
    cost: "A client is refused a push URL at a count the page never warned of.",
  },
  {
    source: "apps/backend/src/services/a2a-push.ts",
    name: "MAX_PUSHES_PER_TASK",
    phrase: (count: number) => `**At most ${count} pushes per Task**`,
    files: ["building-with-platypus/a2a-endpoints.mdx"],
    cost: "A client waits for a push the Task has no pushes left to send.",
  },
  {
    source: "apps/backend/src/runs/run-events.ts",
    name: "RUN_EVENT_CEILING",
    phrase: (count: number) =>
      `keeps the first ${NUMBER_WORDS[count / 1_000] ?? count / 1_000} thousand`,
    files: ["building-with-platypus/triggers.mdx"],
    cost: "A reader debugging a long run takes a cut-off timeline for the whole run.",
  },
  {
    source: "apps/backend/src/runs/stream-keepalive.ts",
    name: "DEFAULT_HEARTBEAT_INTERVAL_MS",
    phrase: (ms: number) => `a comment line every ${ms / 1_000} seconds`,
    files: ["building-with-platypus/a2a-endpoints.mdx"],
    cost: "An integrator sets a proxy's idle timeout below the real heartbeat and has quiet streams cut off.",
  },
  {
    source: "apps/backend/src/routes/a2a.ts",
    name: "AGENT_CARD_CACHE_SECONDS",
    phrase: (seconds: number) =>
      `for up to ${NUMBER_WORDS[seconds / 60] ?? seconds / 60} minutes`,
    files: ["building-with-platypus/a2a-endpoints.mdx"],
    cost: "A Workspace Owner waits the wrong time for an edited Name or Description to reach callers.",
  },
  {
    source: "apps/backend/src/services/a2a-task.ts",
    name: "MAX_CONTEXT_ID_LENGTH",
    phrase: (length: number) => `at most **${length} characters**`,
    files: ["building-with-platypus/a2a-endpoints.mdx"],
    cost: "A client is refused a `contextId` at a length the page never warned of.",
  },
  {
    source: "apps/backend/src/services/a2a-task.ts",
    name: "A2A_BLOCKING_WAIT_MS",
    phrase: (ms: number) => `waits up to **${ms / 1_000} seconds**`,
    files: ["building-with-platypus/a2a-endpoints.mdx"],
    cost: "A client sizes its request timeout against the wrong wait and gives up on a run, or waits on one that already returned.",
  },
  {
    source: "apps/backend/src/services/a2a-task.ts",
    name: "DEFAULT_PAGE_SIZE",
    phrase: (count: number) => `A page holds **${count}** Tasks`,
    files: ["building-with-platypus/a2a-endpoints.mdx"],
    cost: "A client that pages without a `pageSize` expects the wrong number of Tasks per page.",
  },
  {
    source: "apps/backend/src/services/a2a-task.ts",
    name: "MAX_PAGE_SIZE",
    phrase: (count: number) => `**Pages of up to ${count}.**`,
    files: ["building-with-platypus/a2a-endpoints.mdx"],
    cost: "A client is refused a `pageSize` the page says it may ask for.",
  },
  {
    source: "apps/backend/src/services/a2a-call.ts",
    name: "A2A_MAX_STREAMS_PER_TOKEN",
    phrase: (count: number) => `each token can hold at most ${count}`,
    files: ["building-with-platypus/a2a-endpoints.mdx"],
    cost: "A client opening streams is refused with `429` at a count the page never warned of.",
  },
  {
    source: "apps/backend/src/services/bearer-token.ts",
    name: "EXPIRING_SOON_DAYS",
    phrase: (days: number) => `(within ${days} days)`,
    files: ["building-with-platypus/a2a-endpoints.mdx"],
    cost: "A Workspace Owner reads **Expiring soon** as more, or less, time than the token has left.",
  },
  {
    source: "apps/backend/src/services/bearer-token.ts",
    name: "TOUCH_INTERVAL_MS",
    phrase: (ms: number) =>
      ms === 60_000
        ? "at most once a minute"
        : `at most once every ${ms / 60_000} minutes`,
    files: ["building-with-platypus/a2a-endpoints.mdx"],
    cost: "A Workspace Owner checking whether a token is still in use reads its last-used time as fresher than it is.",
  },
] as const;

describe("backend constants the concept pages quote", () => {
  it.each(BACKEND_CONSTANTS)(
    "$name is stated where quoted",
    ({ source, name, phrase, files, cost }) => {
      const value = readIntegerConstant(source, name);
      expect(
        value,
        `No \`${name} = <number>\` in ${source} — re-anchor this test if it moved.`,
      ).toBeDefined();
      const expected = phrase(value!);
      for (const file of files) {
        expect(
          proseOf(file).includes(expected),
          `${file} does not say "${expected}", but ${source} sets ${name} to ` +
            `${value}.\n${cost}`,
        ).toBe(true);
      }
    },
  );
});

/**
 * Numbers a reader plans around that `@platypus/schemas` exports, so the value
 * is imported rather than read from source text.
 */
const SCHEMA_CONSTANTS = [
  {
    name: "TOOL_RESULT_CLEARING_THRESHOLD",
    value: TOOL_RESULT_CLEARING_THRESHOLD,
    phrase: (fraction: number) => `**${Math.round(fraction * 100)}%**`,
    files: ["building-with-platypus/chat.mdx"],
    cost: "A User watching the context meter expects older tool results to drop at the wrong point.",
  },
  {
    name: "TOOL_RESULT_CLEARING_KEEP_RECENT",
    value: TOOL_RESULT_CLEARING_KEEP_RECENT,
    phrase: (count: number) =>
      `The ${NUMBER_WORDS[count] ?? count} most recent results stay`,
    files: ["building-with-platypus/chat.mdx"],
    cost: "A User expects the model to still see a tool result it no longer gets.",
  },
  {
    name: "RUN_EVENT_ERROR_MAX_BYTES",
    value: RUN_EVENT_ERROR_MAX_BYTES,
    phrase: (bytes: number) => `capped at ${bytes / 1024} KiB`,
    files: ["building-with-platypus/triggers.mdx"],
    cost: "A reader debugging a failed run takes a cut error for the whole of it.",
  },
] as const;

describe("schema constants the pages quote", () => {
  it.each(SCHEMA_CONSTANTS)(
    "$name is stated where quoted",
    ({ name, value, phrase, files, cost }) => {
      const expected = phrase(value);
      for (const file of files) {
        expect(
          proseOf(file).includes(expected),
          `${file} does not say "${expected}", but @platypus/schemas sets ` +
            `${name} to ${value}.\n${cost}`,
        ).toBe(true);
      }
    },
  );
});

// --- numbers no entry above pins -------------------------------------------

/**
 * A number with a time, size, count or percent unit: "45 seconds",
 * "100,000-character", "five minutes", "70%". Unit-less counts ("at most 10 of
 * them") are left alone; a pattern that broad would be mostly noise. The
 * thousands separator may be a comma or a space ("100 000-character").
 */
const NUMBER_WITH_UNIT = new RegExp(
  `\\b(?:\\d{1,3}(?:[, ]\\d{3})+|\\d+(?:\\.\\d+)?|${NUMBER_WORDS.join("|")})` +
    `(?:[ -](?:seconds?|minutes?|hours?|days?|bytes?|KB|KiB|MB|MiB|GB|GiB|characters?|entry|entries|events?|streams?)\\b|%)`,
  "gi",
);

/** Fold whitespace so a phrase still matches after a page reflows. */
const fold = (text: string): string => text.replace(/\s+/g, " ");

/**
 * Every number with a unit in a page's prose that does not sit inside one of
 * `pinned` — the phrases the entries above check on this page. Fenced and
 * inline code are skipped: a snippet is not a claim.
 */
const unpinnedNumbers = (content: string, pinned: string[]): string[] => {
  const prose = fold(withoutCodeFences(content));
  const ranges = [...prose.matchAll(/`[^`]*`/g)].map(
    (code): [number, number] => [code.index, code.index + code[0].length],
  );
  for (const pin of pinned.map(fold)) {
    for (
      let at = prose.indexOf(pin);
      at !== -1;
      at = prose.indexOf(pin, at + 1)
    ) {
      ranges.push([at, at + pin.length]);
    }
  }
  return [...prose.matchAll(NUMBER_WITH_UNIT)]
    .filter(
      ({ index }) => !ranges.some(([from, to]) => index >= from && index < to),
    )
    .map((match) => match[0]);
};

type PagePhrase = { file: string; phrase: string };

/**
 * What each entry above checks: the page it reads and the phrase it expects
 * there. Derived from those entries rather than kept as a second list, so a new
 * pin clears its number below on its own.
 */
const pinnedPhrases = (): PagePhrase[] => {
  const closerMs = readIntegerConstant(CLOSER_SOURCE, "CLOSER_TIMEOUT_MS");
  return [
    ...BACKEND_CONSTANTS.flatMap(({ source, name, phrase, files }) => {
      const value = readIntegerConstant(source, name);
      return value === undefined
        ? []
        : files.map((file) => ({ file, phrase: phrase(value) }));
    }),
    ...SCHEMA_CONSTANTS.flatMap(({ value, phrase, files }) =>
      files.map((file) => ({ file, phrase: phrase(value) })),
    ),
    ...CLOSER_TIMEOUT_SURFACES.filter(({ file }) =>
      file.startsWith("apps/docs/content/"),
    ).flatMap(({ file, phrase }) =>
      closerMs === undefined
        ? []
        : [
            {
              file: file.slice("apps/docs/content/".length),
              phrase: phrase(closerMs / 1_000),
            },
          ],
    ),
    ...NAMING_CAPS.flatMap(({ value, surfaces }) =>
      surfaces.flatMap((file) => [
        { file, phrase: `${value} character` },
        { file, phrase: `${value}-character` },
      ]),
    ),
    // Only the numbers in the claim's block that equal a bound it checks — a
    // token lifetime sharing the bullet with a name limit is not pinned by it.
    ...LIMIT_CLAIMS.flatMap(({ doc, anchor, expected }) =>
      [
        ...fold(blockContaining(readDoc(doc), anchor)?.text ?? "").matchAll(
          NUMBER_WITH_UNIT,
        ),
      ]
        .filter((match) =>
          [expected.min, expected.max].includes(
            Number(match[0].match(/^[\d, ]+/)?.[0].replace(/[, ]/g, "")),
          ),
        )
        .map((match) => ({ file: doc, phrase: match[0] })),
    ),
    ...backendNumericDefaults()
      .filter(({ gloss }) => gloss !== undefined)
      .map(({ cell }) => ({ file: BACKEND_REFERENCE_PAGE, phrase: cell })),
  ];
};

/**
 * Numbers with a unit that no entry above pins, each with why it is left
 * unchecked. Keyed by page and phrase, not line, so editing a page around one
 * does not break it. Only illustrative, external, or checked-accurate numbers
 * belong here — including one pinned on another page but restated on this
 * one. A wrong number is fixed or pinned instead.
 */
const UNPINNED_NUMBERS: (PagePhrase & { reason: string })[] = [
  {
    file: "administering/index.mdx",
    phrase: "7 days",
    reason:
      "Expiring soon threshold; EXPIRING_SOON_DAYS, pinned on the A2A page",
  },
  {
    file: "building-with-platypus/a2a-endpoints.mdx",
    phrase: "1 MiB",
    reason: "A2A_MAX_BODY_BYTES default, pinned on the backend reference page",
  },
  {
    file: "building-with-platypus/a2a-endpoints.mdx",
    phrase: "365 days",
    reason:
      "token lifetime option from BEARER_TOKEN_EXPIRY_DAYS; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/a2a-endpoints.mdx",
    phrase: "30 days",
    reason:
      "token expiry reminder in bearer-token.ts dueReminder; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/a2a-endpoints.mdx",
    phrase: "30-day",
    reason:
      "token lifetime option from BEARER_TOKEN_EXPIRY_DAYS; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/a2a-endpoints.mdx",
    phrase: "7 days",
    reason:
      "token expiry reminder at EXPIRING_SOON_DAYS; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/a2a-endpoints.mdx",
    phrase: "7-day",
    reason:
      "token expiry reminder at EXPIRING_SOON_DAYS; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/board-digest.mdx",
    phrase: "three days",
    reason:
      "illustrative threshold from the example Skill text on the same page",
  },
  {
    file: "building-with-platypus/boards.mdx",
    phrase: "one entry",
    reason: "behaviour, not a limit: one history entry per write",
  },
  {
    file: "building-with-platypus/chat.mdx",
    phrase: "33%",
    reason: "illustrative context-meter reading (42K of 128K)",
  },
  {
    file: "building-with-platypus/chat.mdx",
    phrase: "7 days",
    reason: "the sidebar's Last 7 days group; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/mcp.mdx",
    phrase: "20 seconds",
    reason: "TOOL_SET_RESOLVE_TIMEOUT_MS; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/mcp.mdx",
    phrase: "64 characters",
    reason: "TOOL_NAME_PATTERN's {1,64}; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/mcp.mdx",
    phrase: "one minute",
    reason: "FETCH_FAILURE_SKIP_WINDOW_MS; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/skills.mdx",
    phrase: "1 MiB",
    reason: "SKILL_FILE_READ_MAX_BYTES; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/skills.mdx",
    phrase: "10 MiB",
    reason: "SKILL_ZIP_MAX_BYTES; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/skills.mdx",
    phrase: "16 KiB",
    reason: "SKILL_FRONTMATTER_MAX_BYTES; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/skills.mdx",
    phrase: "25 MiB",
    reason: "SKILL_BUNDLE_MAX_UNPACKED_BYTES; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/skills.mdx",
    phrase: "two entries",
    reason: "prose about duplicate paths, not a limit",
  },
  {
    file: "building-with-platypus/triggers.mdx",
    phrase: "20 seconds",
    reason: "TOOL_SET_RESOLVE_TIMEOUT_MS; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/triggers.mdx",
    phrase: "30 days",
    reason:
      "token expiry reminder in bearer-token.ts dueReminder; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/triggers.mdx",
    phrase: "30 minutes",
    reason:
      "a Simple Frequency option in the Trigger form; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/triggers.mdx",
    phrase: "30-day",
    reason:
      "token lifetime option from BEARER_TOKEN_EXPIRY_DAYS; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/triggers.mdx",
    phrase: "365 days",
    reason:
      "token lifetime option from BEARER_TOKEN_EXPIRY_DAYS; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/triggers.mdx",
    phrase: "5 seconds",
    reason: "event-trigger DEBOUNCE_MS; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/triggers.mdx",
    phrase: "64 KiB",
    reason:
      "INBOUND_TRIGGER_MAX_BODY_BYTES default, pinned on the backend reference page",
  },
  {
    file: "building-with-platypus/triggers.mdx",
    phrase: "7 days",
    reason:
      "Expiring soon and the expiry reminder, both EXPIRING_SOON_DAYS; accurate, not yet pinned here",
  },
  {
    file: "building-with-platypus/triggers.mdx",
    phrase: "7-day",
    reason:
      "token expiry reminder at EXPIRING_SOON_DAYS; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/triggers.mdx",
    phrase: "one day",
    reason: 'prose ("from one day to the next"), not a limit',
  },
  {
    file: "building-with-platypus/webhooks.mdx",
    phrase: "10 seconds",
    reason: "webhook-delivery TIMEOUT_MS; accurate, not yet pinned",
  },
  {
    file: "building-with-platypus/webhooks.mdx",
    phrase: "one event",
    reason: "behaviour, not a limit: Mark all as read sends one bulk event",
  },
  {
    file: "extending/sandbox-backends.mdx",
    phrase: "25 MiB",
    reason: "SANDBOX_TRANSFER_MAX_BYTES, pinned on the Sandboxes concept page",
  },
  {
    file: "extending/sandbox-backends.mdx",
    phrase: "60 seconds",
    reason: "DEFAULT_SHELL_TIMEOUT_MS; accurate, not yet pinned",
  },
  {
    file: "extending/tool-sets.mdx",
    phrase: "20 seconds",
    reason: "TOOL_SET_RESOLVE_TIMEOUT_MS; accurate, not yet pinned",
  },
  {
    file: "extending/web-search-backends.mdx",
    phrase: "100 000-character",
    reason: "MAX_READ_URL_SLICE_CHARS; accurate, not yet pinned",
  },
  {
    file: "extending/web-search-backends.mdx",
    phrase: "240 seconds",
    reason:
      "derived: two calls at MAX_WEB_TIMEOUT_MS; accurate, not yet pinned",
  },
  {
    file: "extending/your-first-plugin.mdx",
    phrase: "32-character",
    reason:
      "MAX_PLUGIN_TOOL_NAME_LENGTH quoted in a log line, pinned on the Tool sets page",
  },
  {
    file: "getting-started/index.mdx",
    phrase: "30 seconds",
    reason: "derived: the backend's 1+2+4+8+16s Postgres retry backoff",
  },
  {
    file: "reference/backend-configuration.mdx",
    phrase: "10 seconds",
    reason: "Docker's default stop grace period, not ours",
  },
  {
    file: "reference/backend-configuration.mdx",
    phrase: "15 seconds",
    reason: "RUN_HEARTBEAT_INTERVAL_MS; accurate, not yet pinned",
  },
  {
    file: "reference/backend-configuration.mdx",
    phrase: "32-character",
    reason: "better-auth's secret-length warning, not ours",
  },
  {
    file: "reference/backend-configuration.mdx",
    phrase: "65 minutes",
    reason:
      "derived: TRIGGER_PER_RUN_TIMEOUT_MS plus RECOVERY_STALE_BUFFER_MS defaults",
  },
  {
    file: "reference/backend-configuration.mdx",
    phrase: "8 characters",
    reason: "MIN_ADMIN_PASSWORD_LENGTH; accurate, not yet pinned",
  },
  {
    file: "reference/backend-configuration.mdx",
    phrase: "8 seconds",
    reason: "SHUTDOWN_DRAIN_MS; accurate, not yet pinned",
  },
  {
    file: "reference/backend-configuration.mdx",
    phrase: "five-minute",
    reason:
      'RECOVERY_STALE_BUFFER_MS, pinned on the same page as "five minutes"',
  },
  {
    file: "self-hosting/configuration.mdx",
    phrase: "20 seconds",
    reason: "TOOL_SET_RESOLVE_TIMEOUT_MS; accurate, not yet pinned",
  },
  {
    file: "self-hosting/docker-compose.mdx",
    phrase: "24-character",
    reason:
      "the installer's generated password length; accurate, not yet pinned",
  },
  {
    file: "self-hosting/docker-compose.mdx",
    phrase: "8 characters",
    reason: "MIN_ADMIN_PASSWORD_LENGTH; accurate, not yet pinned",
  },
  {
    file: "self-hosting/production.mdx",
    phrase: "10 seconds",
    reason: "better-auth's default rate-limit window, not ours",
  },
  {
    file: "self-hosting/production.mdx",
    phrase: "10-seconds",
    reason: "better-auth's default rate-limit window, not ours",
  },
  {
    file: "self-hosting/production.mdx",
    phrase: "60 seconds",
    reason: "better-auth's default rate-limit window, not ours",
  },
  {
    file: "self-hosting/production.mdx",
    phrase: "ten seconds",
    reason: "better-auth's default rate-limit window, not ours",
  },
  {
    file: "self-hosting/providers-and-auth.mdx",
    phrase: "One entry",
    reason: "form-field guidance, not a limit",
  },
  {
    file: "self-hosting/sandbox.mdx",
    phrase: "30 seconds",
    reason: "the Docker sandbox's READ_TIMEOUT_MS; accurate, not yet pinned",
  },
  {
    file: "self-hosting/sandbox.mdx",
    phrase: "60 seconds",
    reason: "the SSH sandbox's IDLE_TIMEOUT_MS; accurate, not yet pinned",
  },
  {
    file: "self-hosting/sandbox.mdx",
    phrase: "600 seconds",
    reason: "MAX_SHELL_TIMEOUT_MS; accurate, not yet pinned",
  },
  {
    file: "self-hosting/users-and-access.mdx",
    phrase: "7 days",
    reason: "session expiresIn in the auth config; accurate, not yet pinned",
  },
];

describe("numbers with units on the docs pages", () => {
  const pinned = pinnedPhrases();
  const allowlisted = (file: string, phrase: string) =>
    UNPINNED_NUMBERS.some(
      (entry) => entry.file === file && entry.phrase === phrase,
    );
  const found: PagePhrase[] = DOCS.flatMap((file) =>
    unpinnedNumbers(
      readDoc(file),
      pinned.filter((pin) => pin.file === file).map(({ phrase }) => phrase),
    ).map((phrase) => ({ file, phrase })),
  );

  it("are each pinned or allowlisted with a reason", () => {
    expectNoViolations(
      found
        .filter(({ file, phrase }) => !allowlisted(file, phrase))
        .map(
          ({ file, phrase }) =>
            `apps/docs/content/${file} states "${phrase}", which nothing checks against the code.\n` +
            `Pin it to its source in this file, or add it to UNPINNED_NUMBERS with the reason it needs no pin.`,
        ),
    );
  });

  it("keeps UNPINNED_NUMBERS to numbers a page still states, unpinned", () => {
    expectNoViolations(
      UNPINNED_NUMBERS.filter(
        (entry) =>
          !found.some(
            ({ file, phrase }) =>
              file === entry.file && phrase === entry.phrase,
          ),
      ).map(
        ({ file, phrase }) =>
          `UNPINNED_NUMBERS lists "${phrase}" on apps/docs/content/${file}, but that page no longer states it unpinned.\n` +
          `Remove the entry.`,
      ),
    );
  });

  it("gives every UNPINNED_NUMBERS entry a reason", () => {
    expectNoViolations(
      UNPINNED_NUMBERS.filter(({ reason }) => reason.trim() === "").map(
        ({ file, phrase }) =>
          `UNPINNED_NUMBERS lists "${phrase}" on apps/docs/content/${file} with no reason.\n` +
          `Say why it needs no pin: illustrative, external, or checked against its source.`,
      ),
    );
  });
});

describe("unpinnedNumbers", () => {
  it("finds a number with a unit in prose", () => {
    expect(unpinnedNumbers("Retries after 45 seconds.", [])).toEqual([
      "45 seconds",
    ]);
  });

  it("reads number words, thousands separators and hyphenated units", () => {
    expect(
      unpinnedNumbers(
        "Wait five minutes for a 100,000-character page or a 100 000-character one, 70% full.",
        [],
      ),
    ).toEqual([
      "five minutes",
      "100,000-character",
      "100 000-character",
      "70%",
    ]);
  });

  it("skips fenced code and inline code", () => {
    expect(
      unpinnedNumbers(
        "```\nRetries after 45 seconds.\n```\nSet `45 seconds`.",
        [],
      ),
    ).toEqual([]);
  });

  it("skips a number inside a pinned phrase, even across a line wrap", () => {
    expect(
      unpinnedNumbers("It waits up to\n**30 seconds** then 45 seconds.", [
        "waits up to **30 seconds**",
      ]),
    ).toEqual(["45 seconds"]);
  });
});

// --- docker image tags -------------------------------------------------------

/**
 * The Compose page tells Operators to pin a tag. Nothing but the release
 * workflow makes those tags exist, so the page's three-way choice — `latest`,
 * the floating major, an exact version — is pinned against the workflow that
 * pushes them and against the version line the repository is actually on.
 */
const RELEASE_WORKFLOW = ".github/workflows/build-and-push.yml";
const COMPOSE_PAGE = "self-hosting/docker-compose.mdx";
const IMAGES = ["frontend", "backend"] as const;

const currentMajor = (): string => {
  const { version } = JSON.parse(readRepoFile("package.json")) as {
    version?: string;
  };
  const major = version?.match(/^(\d+)\./)?.[1];
  if (!major) {
    throw new Error(
      `No \`x.y.z\` version in the root package.json (read \`${version}\`). ` +
        `The release workflow derives every image tag from it; update this test if the scheme changed.`,
    );
  }
  return major;
};

describe("docker image tags", () => {
  const workflow = readRepoFile(RELEASE_WORKFLOW);
  const major = currentMajor();

  it("pushes latest, the exact version, and a floating major for both images", () => {
    const violations: string[] = [];

    // Both images run through one matrixed merge job, so the image name is a
    // matrix value and each tag template appears once.
    if (!workflow.includes(`image: [${IMAGES.join(", ")}]`)) {
      violations.push(
        `${RELEASE_WORKFLOW} no longer lists both images in its matrix.\n` +
          `${COMPOSE_PAGE} tells Operators both images publish the same three tags.`,
      );
    }
    const expected = [
      "willdady/platypus-${{ matrix.image }}:latest",
      "willdady/platypus-${{ matrix.image }}:${{ steps.version.outputs.version }}",
      "${{ steps.tags.outputs.major }}",
    ];
    for (const tag of expected) {
      if (!workflow.includes(tag)) {
        violations.push(
          `${RELEASE_WORKFLOW} no longer tags the images with \`${tag}\`.\n` +
            `${COMPOSE_PAGE} tells Operators all three tags exist; either restore the tag or rewrite that page.`,
        );
      }
    }

    expectNoViolations(violations);
  });

  /**
   * The page promises `:2` tracks the newest `2.x.y`. A major written into the
   * workflow by hand keeps resolving long after the repository has moved on, so
   * the claim fails silently rather than loudly. This checks the shape of the
   * tag, not the shell that builds it — how the major gets derived is the
   * workflow's business.
   */
  it("hardcodes no major in the release workflow", () => {
    const hardcoded = [
      ...workflow.matchAll(
        /willdady\/platypus-(?:frontend|backend|\$\{\{ matrix\.image \}\}):(\d[\w.]*)/g,
      ),
    ];

    expectNoViolations(
      hardcoded.map(
        ([full]) =>
          `${RELEASE_WORKFLOW} pushes \`${full}\`, a version literal.\n` +
          `Every version-bearing tag has to come from the workflow's own version output, or it stops moving with the release.`,
      ),
    );
  });

  it("shows only tags that exist, on the major line the repository is on", () => {
    const page = readDoc(COMPOSE_PAGE);
    const tags = [
      ...page.matchAll(/willdady\/platypus-(?:frontend|backend):([\w.-]+)/g),
    ];

    expect(
      tags.length,
      `Matched no image tags in ${COMPOSE_PAGE} — the page stopped naming them, or the matcher broke.`,
    ).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const [full, tag] of tags) {
      const onCurrentLine =
        tag === "latest" ||
        tag === major ||
        new RegExp(String.raw`^${major}\.\d+\.\d+$`).test(tag);
      if (!onCurrentLine) {
        violations.push(
          `${COMPOSE_PAGE} shows \`${full}\`, which is not \`:latest\`, the floating \`:${major}\`, or an exact \`${major}.y.z\`.\n` +
            `Source of truth: the root package.json version. A major bump is meant to fail here — update the page's examples with it.`,
        );
      }
    }

    expectNoViolations(violations);
  });
});

// --- internal links and heading anchors --------------------------------------

/** `content/index.mdx` → `/`, `content/foo/index.mdx` → `/foo`. */
const routeFor = (doc: string): string => {
  const withoutExtension = doc.replace(/\.mdx$/, "");
  const route = withoutExtension.replace(/(^|\/)index$/, "");
  return route === "" ? "/" : `/${route}`;
};

/** Approximate the rendered text of a heading before slugging it. */
const headingText = (raw: string): string =>
  raw
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_]{1,3}/g, "")
    .trim();

/**
 * Slug every heading the way `rehype-slug` does, duplicates included — Nextra
 * runs the same `github-slugger`, so a `-1` suffix here is a real anchor there.
 */
const headingSlugs = (content: string): Set<string> => {
  const slugger = new GithubSlugger();
  const slugs = new Set<string>();
  for (const line of withoutCodeFences(content).split("\n")) {
    const match = line.match(/^#{1,6}\s+(.*)$/);
    if (match) slugs.add(slugger.slug(headingText(match[1])));
  }
  return slugs;
};

// Git can check out CRLF on Windows, and every reader here splits on "\n" and
// anchors patterns with `$`. A trailing "\r" defeats both: the heading pattern
// matches nothing, the internal-link check collects no anchors, and every link
// is then reported as broken. Pinned because that failure names the links
// rather than the line endings, which sends a reader to the wrong place.
describe("line endings", () => {
  it("normalises CRLF, so heading anchors survive a Windows checkout", () => {
    const lf = readDoc("extending/web-search-backends.mdx");
    const crlf = lf.replace(/\n/g, "\r\n");

    expect(normalizeNewlines(crlf)).toBe(lf);
    expect([...headingSlugs(normalizeNewlines(crlf))]).toEqual([
      ...headingSlugs(lf),
    ]);
  });

  // Trivially true on an LF checkout, and that is the point: on a CRLF one this
  // is what fails if a reader stops normalising, instead of every link check.
  it("hands the checks below no carriage returns", () => {
    for (const doc of DOCS) expect(readDoc(doc)).not.toContain("\r");
  });
});

describe("internal links", () => {
  const slugsByRoute = new Map<string, Set<string>>();
  for (const doc of DOCS) {
    slugsByRoute.set(routeFor(doc), headingSlugs(readDoc(doc)));
  }

  it("resolves every internal link and heading anchor", () => {
    const violations: string[] = [];
    let checked = 0;

    for (const doc of DOCS) {
      const content = readDoc(doc);
      const scanned = withoutCodeFences(content).split("\n");

      scanned.forEach((line, index) => {
        const targets = [
          ...[...line.matchAll(/\]\((\/[^)\s]*|#[^)\s]+)\)/g)].map((m) => m[1]),
          ...[...line.matchAll(/href="(\/[^"]*|#[^"]+)"/g)].map((m) => m[1]),
        ];

        for (const target of targets) {
          checked += 1;
          const [rawPath, anchor] = target.split("#");
          const route =
            rawPath === ""
              ? routeFor(doc)
              : rawPath.length > 1
                ? rawPath.replace(/\/$/, "")
                : rawPath;
          const where = `apps/docs/content/${doc}:${index + 1}`;

          const slugs = slugsByRoute.get(route);
          if (!slugs) {
            violations.push(
              `${where} links to \`${target}\`, but no page under apps/docs/content maps to \`${route}\`.\n` +
                `Source of truth: the .mdx files on disk.`,
            );
            continue;
          }
          if (anchor && !slugs.has(anchor)) {
            violations.push(
              `${where} links to \`${target}\`, but \`${route}\` has no heading slugging to \`#${anchor}\`.\n` +
                `Source of truth: the headings in the target .mdx file.`,
            );
          }
        }
      });
    }

    expect(
      checked,
      "matched no internal links at all — the link extractor stopped working",
    ).toBeGreaterThan(0);
    expectNoViolations(violations);
  });
});
