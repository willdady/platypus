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
 * - It only checks what someone encoded. The ~150 bolded UI labels across
 *   `building-with-platypus/` have no anchor at all — rename a button and
 *   nothing here complains. A green suite is not a correct docs site.
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
  agentSchema,
  dashboardCreateSchema,
  DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
  kanbanBoardSchema,
  mcpSchema,
  modelConfigSchema,
  skillSchema,
  triggerSchema,
  webhookEventSchema,
  workspaceSchema,
} from "@platypus/schemas";

const CONTENT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(CONTENT_DIR, "..", "..", "..");

// --- reading -----------------------------------------------------------------

const readRepoFile = (repoRelativePath: string): string =>
  readFileSync(join(REPO_ROOT, repoRelativePath), "utf8");

const readDoc = (contentRelativePath: string): string =>
  readFileSync(join(CONTENT_DIR, contentRelativePath), "utf8");

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
  ".env.example": ENV_REFERENCE_PAGES,
  "apps/backend/.env.example": [BACKEND_REFERENCE_PAGE],
  "apps/frontend/.env.example": [FRONTEND_REFERENCE_PAGE],
};

const ENV_EXAMPLE_NAMES = Object.keys(ENV_EXAMPLE_FILES);

/**
 * Variables a reference page deliberately still names after they stopped
 * existing. Empty on purpose: "Reference describes the present tense" is now a
 * stated section rule (`reference/index.mdx`), so where a removed setting went
 * is told on the upgrade page instead, which no check here reads.
 *
 * An entry earns its place back only if a reference table itself needs to name a
 * variable that no `.env.example` ships any more.
 */
const REMOVED_VARS = new Set<string>([]);

/**
 * Real variables that no `.env.example` ships, so the reference page is their
 * only home. Both are read by the frontend (`next.config.ts` and the About
 * page) and neither is something a deployment normally sets.
 */
const VARS_WITHOUT_ENV_EXAMPLE_ENTRY = new Set([
  "ALLOWED_DEV_ORIGINS",
  "NEXT_PUBLIC_APP_VERSION",
]);

/**
 * Assignments in a `.env.example`, including commented-out ones — a `# VAR=`
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

  it("gives every variable the .env.example files ship a row on its own page", () => {
    const violations: string[] = [];
    for (const [name, { origin, pages }] of declared) {
      if (pages.some((page) => rowsByPage.get(page)?.has(name))) continue;

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

  it("names no variable the .env.example files do not ship", () => {
    const violations: string[] = [];
    for (const [page, rows] of rowsByPage) {
      for (const [name, line] of rows) {
        if (declared.has(name)) continue;
        if (REMOVED_VARS.has(name)) continue;
        if (VARS_WITHOUT_ENV_EXAMPLE_ENTRY.has(name)) continue;
        violations.push(
          `apps/docs/content/${page}:${line} has a row for \`${name}\`, which no .env.example assigns.\n` +
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
    doc: "building-with-platypus/skills.mdx",
    anchor: "**Name** — a kebab-case identifier",
    source: "packages/schemas/index.ts (skillSchema.name)",
    expected: stringField(skillSchema, "name"),
  },
  {
    doc: "building-with-platypus/skills.mdx",
    anchor: "**Description** — a brief summary of what the Skill does",
    source: "packages/schemas/index.ts (skillSchema.description)",
    expected: stringField(skillSchema, "description"),
  },
  {
    doc: "building-with-platypus/skills.mdx",
    anchor: "**Body** — the full instructions",
    source: "packages/schemas/index.ts (skillSchema.body)",
    expected: stringField(skillSchema, "body"),
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
 * The units a limit can be stated in. A character count and a token count are
 * both bounds a reader is rejected by, and neither page would thank us for
 * restating its number in the other's unit.
 */
const LIMIT_UNIT = "(?:characters|tokens)";

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

    for (const image of IMAGES) {
      const expected = [
        `willdady/platypus-${image}:latest`,
        `willdady/platypus-${image}:\${{ steps.version.outputs.version }}`,
        `\${{ steps.tags.outputs.${image}_major }}`,
      ];
      for (const tag of expected) {
        if (!workflow.includes(tag)) {
          violations.push(
            `${RELEASE_WORKFLOW} no longer tags the ${image} image with \`${tag}\`.\n` +
              `${COMPOSE_PAGE} tells Operators all three tags exist; either restore the tag or rewrite that page.`,
          );
        }
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
        /willdady\/platypus-(?:frontend|backend):(\d[\w.]*)/g,
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
