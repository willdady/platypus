/**
 * Reducing a Zod validation failure to the few lines that identify it.
 *
 * Shared by two surfaces with the same problem and different audiences: the
 * user-facing stream error text, and the serializer that writes errors to the
 * log. Kept free of any logger dependency so the logger can import it.
 */

/** How much of a single validation issue is worth repeating back. */
export const MAX_ISSUE_LENGTH = 160;
/** Beyond a handful of issues the list stops being diagnostic. */
export const MAX_ISSUES = 5;
/** A union nested past this is a pathological schema, not a diagnosable one. */
const MAX_UNION_DEPTH = 12;
/** How far down a `cause` chain a Zod failure is worth looking for. */
const MAX_CAUSE_SEARCH_DEPTH = 5;

/** A Zod issue, structurally — avoids coupling to a specific zod version. */
export type ZodLikeIssue = {
  path?: unknown[];
  message?: string;
  code?: string;
  /** Present on `invalid_union`: one issue list per rejected branch. */
  errors?: ZodLikeIssue[][];
  /** Present on `invalid_type`: the type that branch was hoping for. */
  expected?: unknown;
};

/** A union issue, whose `errors` holds one issue list per rejected branch. */
type UnionIssue = ZodLikeIssue & { errors: ZodLikeIssue[][] };

/** An issue reduced to an absolute path and a single line of prose. */
export type FlatIssue = { path: unknown[]; message: string };

export const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * Walk an error's `cause` chain looking for Zod's `issues` array.
 *
 * The SDK nests these two deep — `InvalidToolInputError` → `TypeValidationError`
 * → `ZodError` — and the depth is an implementation detail we shouldn't encode,
 * so this searches rather than reaching through a fixed path.
 *
 * Reads `issues` by property access on purpose: zod defines it non-enumerably,
 * so anything driven by `Object.keys` finds nothing.
 */
export const findIssues = (
  error: unknown,
  depth = 0,
): ZodLikeIssue[] | undefined => {
  if (
    depth > MAX_CAUSE_SEARCH_DEPTH ||
    error == null ||
    typeof error !== "object"
  )
    return undefined;
  const issues = (error as { issues?: unknown }).issues;
  if (Array.isArray(issues) && issues.length > 0)
    return issues as ZodLikeIssue[];
  return findIssues((error as { cause?: unknown }).cause, depth + 1);
};

/** `["body"]` → `body`, `["items", 2, "id"]` → `items[2].id`, `[]` → `(root)`. */
export const formatPath = (path: unknown[] | undefined): string => {
  if (!path || path.length === 0) return "(root)";
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") return `${acc}[${segment}]`;
    return acc ? `${acc}.${String(segment)}` : String(segment);
  }, "");
};

const isUnionIssue = (issue: ZodLikeIssue): issue is UnionIssue =>
  issue.code === "invalid_union" && Array.isArray(issue.errors);

const deepestPath = (issues: FlatIssue[]): number =>
  issues.reduce((max, issue) => Math.max(max, issue.path.length), 0);

/** The type a branch was hoping for, when the branch failed on type alone. */
const expectedType = (issue: ZodLikeIssue): string | undefined =>
  issue.code === "invalid_type" ? issue.expected?.toString() : undefined;

/**
 * Collapse branches that all failed the same way at the same place.
 *
 * A `Date` checked against a JSON value union fails all six branches at one
 * path. Keeping the first alone reads as "expected null", which implies null
 * was the only option; keeping all six is the same sentence six times. Naming
 * every accepted type in one line is both shorter and true.
 */
const mergeAlternatives = (
  branches: AnnotatedLeaf[][],
): AnnotatedLeaf[] | undefined => {
  if (branches.some((branch) => branch.length !== 1)) return undefined;
  const leaves = branches.map((branch) => branch[0]);

  const path = formatPath(leaves[0].path);
  if (leaves.some((leaf) => formatPath(leaf.path) !== path)) return undefined;

  const expected = leaves.map((leaf) => leaf.expected);
  if (expected.some((type) => type === undefined)) return undefined;

  // Every branch rejected the same value, so any branch's message names it.
  const received = /received (.+)$/.exec(leaves[0].message)?.[1];
  const alternatives = [...new Set(expected)].join(" | ");
  return [
    {
      path: leaves[0].path,
      message: received
        ? `Invalid input: expected ${alternatives}, received ${received}`
        : `Invalid input: expected ${alternatives}`,
    },
  ];
};

/**
 * Pick the branch that got furthest into the value.
 *
 * A union reports why *every* branch failed, which is the validator's search
 * space rather than the user's mistake. The branch that reached deepest is the
 * one the value was actually trying to be — for a tool message, the branch that
 * matched `role: "tool"` and then choked on a `Date` twelve levels down, not
 * the five that stopped at `role`.
 */
const selectBranch = (branches: AnnotatedLeaf[][]): AnnotatedLeaf[] => {
  const candidates = branches.filter((branch) => branch.length > 0);
  if (candidates.length === 0) return [];

  const deepest = deepestPath(candidates.flat());
  const furthest = candidates.filter(
    (branch) => deepestPath(branch) === deepest,
  );
  if (furthest.length === 1) return furthest[0];

  const merged = mergeAlternatives(furthest);
  if (merged) return merged;

  // Two branches reached the same depth, so depth alone can't separate them —
  // a tool message also satisfies the shape of an assistant message carrying a
  // tool result, and both descend to the same offending field. The branch that
  // objected least is the closer match: it agreed on everything the other one
  // additionally complained about, such as the discriminating `role`.
  const fewest = Math.min(...furthest.map((branch) => branch.length));
  return furthest.find((branch) => branch.length === fewest) ?? furthest[0];
};

/** A leaf carrying the `expected` type through branch selection. */
type AnnotatedLeaf = FlatIssue & { expected?: string };

/** Appended where a union was too deeply nested to be worth descending. */
const NOT_EXPANDED = "(nested unions not expanded)";

/** One issue's prose, collapsed to a single line. */
const issueText = (issue: ZodLikeIssue): string =>
  (issue.message ?? "invalid").replace(/\s+/g, " ").trim();

const flatten = (
  issues: ZodLikeIssue[],
  base: unknown[],
  depth: number,
): AnnotatedLeaf[] =>
  issues.flatMap((issue) => {
    const path = [...base, ...(issue.path ?? [])];
    const message = issueText(issue);

    if (!isUnionIssue(issue)) {
      return [{ path, message, expected: expectedType(issue) }];
    }
    if (depth >= MAX_UNION_DEPTH) {
      return [{ path, message: `${message} ${NOT_EXPANDED}` }];
    }

    const selected = selectBranch(
      issue.errors.map((branch) => flatten(branch, path, depth + 1)),
    );
    // A union whose branches reported nothing still knows that this field
    // failed. Returning the empty selection would drop that last record, and
    // losing the one line that names the failure is the bug being fixed, not a
    // corner worth cutting.
    return selected.length > 0 ? selected : [{ path, message }];
  });

/**
 * Reduce a Zod issue tree to concrete failures with absolute paths.
 *
 * The path of a union's branch issue is relative to the union node, so the only
 * actionable path — `content[0].output.value.columns[2].createdAt` — exists
 * nowhere in the tree until the descent concatenates it.
 */
export const flattenIssues = (issues: ZodLikeIssue[]): FlatIssue[] =>
  flatten(issues, [], 0).map(({ path, message }) => ({ path, message }));

/**
 * Render issues as one capped line per failing field.
 *
 * Flattens first, so a union renders as the absolute path of the field that
 * actually failed rather than the useless `payload: Invalid input` the union
 * node carries. Doing it here rather than at the call sites is what keeps the
 * two surfaces — the log entry and the text the user and the model read — from
 * disagreeing about the same failure.
 *
 * Deliberately does NOT include the rejected value. The SDK's own message
 * embeds the entire value plus the serialized `ZodError`, which is how a
 * single over-long field became several thousand characters of unreadable
 * output for the user and the model alike (issue #406).
 */
export const formatIssues = (issues: ZodLikeIssue[]): string => {
  const flat = flattenIssues(issues);
  const shown = flat
    .slice(0, MAX_ISSUES)
    .map(
      (issue) =>
        `${formatPath(issue.path)}: ${truncate(issueText(issue), MAX_ISSUE_LENGTH)}`,
    );
  const omitted = flat.length - shown.length;
  return shown.join("; ") + (omitted > 0 ? ` (+${omitted} more)` : "");
};
