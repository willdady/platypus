export const MAX_ISSUE_LENGTH = 160;
const MAX_ISSUES = 5;
const MAX_UNION_DEPTH = 12;
const MAX_CAUSE_SEARCH_DEPTH = 5;

export type ZodLikeIssue = {
  path?: unknown[];
  message?: string;
  code?: string;
  errors?: ZodLikeIssue[][];
  expected?: unknown;
};

type UnionIssue = ZodLikeIssue & { errors: ZodLikeIssue[][] };

export type FlatIssue = { path: unknown[]; message: string };

export const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

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

const expectedType = (issue: ZodLikeIssue): string | undefined =>
  issue.code === "invalid_type" ? issue.expected?.toString() : undefined;

const mergeAlternatives = (
  branches: AnnotatedLeaf[][],
): AnnotatedLeaf[] | undefined => {
  if (branches.some((branch) => branch.length !== 1)) return undefined;
  const leaves = branches.flat();
  const [first] = leaves;
  if (!first) return undefined;

  const path = formatPath(first.path);
  if (leaves.some((leaf) => formatPath(leaf.path) !== path)) return undefined;

  const expected = leaves.map((leaf) => leaf.expected);
  if (expected.some((type) => type === undefined)) return undefined;

  const received = /received (.+)$/.exec(first.message)?.[1];
  const alternatives = [...new Set(expected)].join(" | ");
  return [
    {
      path: first.path,
      message: received
        ? `Invalid input: expected ${alternatives}, received ${received}`
        : `Invalid input: expected ${alternatives}`,
    },
  ];
};

const selectBranch = (branches: AnnotatedLeaf[][]): AnnotatedLeaf[] => {
  const candidates = branches.filter((branch) => branch.length > 0);
  if (candidates.length === 0) return [];

  const deepest = deepestPath(candidates.flat());
  const furthest = candidates.filter(
    (branch) => deepestPath(branch) === deepest,
  );
  const [first] = furthest;
  if (!first) return [];
  if (furthest.length === 1) return first;

  const merged = mergeAlternatives(furthest);
  if (merged) return merged;

  const fewest = Math.min(...furthest.map((branch) => branch.length));
  return furthest.find((branch) => branch.length === fewest) ?? first;
};

type AnnotatedLeaf = FlatIssue & { expected?: string };

const NOT_EXPANDED = "(nested unions not expanded)";

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
    return selected.length > 0 ? selected : [{ path, message }];
  });

export const flattenIssues = (issues: ZodLikeIssue[]): FlatIssue[] =>
  flatten(issues, [], 0).map(({ path, message }) => ({ path, message }));

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
