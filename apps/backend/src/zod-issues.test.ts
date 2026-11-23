import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  findIssues,
  flattenIssues,
  formatIssues,
  formatPath,
} from "./zod-issues.ts";

const issuesFor = (schema: z.ZodType, value: unknown) => {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("expected the parse to fail");
  return result.error.issues;
};

describe("formatPath", () => {
  it.each([
    [[], "(root)"],
    [["body"], "body"],
    [["items", 2, "id"], "items[2].id"],
    [[0, "content", 0, "output"], "[0].content[0].output"],
  ])("renders %j as %s", (path, expected) => {
    expect(formatPath(path)).toBe(expected);
  });
});

describe("flattenIssues", () => {
  it("leaves a non-union issue alone", () => {
    const issues = issuesFor(z.object({ body: z.string() }), { body: 1 });
    const flat = flattenIssues(issues);

    expect(flat).toHaveLength(1);
    expect(formatPath(flat[0].path)).toBe("body");
  });

  it("descends a union and reports the absolute path of the offending field", () => {
    const schema = z.array(
      z.union([
        z.string(),
        z.object({ id: z.string(), meta: z.object({ at: z.string() }) }),
      ]),
    );
    const flat = flattenIssues(
      issuesFor(schema, [{ id: "a", meta: { at: new Date() } }]),
    );

    expect(flat.map((issue) => formatPath(issue.path))).toContain(
      "[0].meta.at",
    );
  });

  it("keeps the branch that got furthest and discards the rest of the search space", () => {
    const schema = z.union([
      z.object({
        kind: z.literal("a"),
        nested: z.object({ value: z.string() }),
      }),
      z.object({ kind: z.literal("b"), other: z.string() }),
    ]);
    const flat = flattenIssues(
      issuesFor(schema, { kind: "a", nested: { value: 1 } }),
    );

    expect(flat).toHaveLength(1);
    expect(formatPath(flat[0].path)).toBe("nested.value");
    expect(JSON.stringify(flat)).not.toContain("kind");
  });

  it("merges equally-shallow alternatives into one issue naming every accepted type", () => {
    const schema = z.object({
      at: z.union([z.null(), z.string(), z.number(), z.boolean()]),
    });
    const flat = flattenIssues(issuesFor(schema, { at: new Date() }));

    expect(flat).toHaveLength(1);
    expect(formatPath(flat[0].path)).toBe("at");
    expect(flat[0].message).toContain("null");
    expect(flat[0].message).toContain("string");
    expect(flat[0].message).toContain("number");
    expect(flat[0].message).toContain("boolean");
    expect(flat[0].message).toContain("Date");
  });

  it("prefers the branch that objected least when two reach the same depth", () => {
    const schema = z.union([
      z.object({
        kind: z.literal("tool"),
        nested: z.object({ at: z.string() }),
      }),
      z.object({
        kind: z.literal("assistant"),
        nested: z.object({ at: z.string() }),
      }),
    ]);
    const flat = flattenIssues(
      issuesFor(schema, { kind: "tool", nested: { at: new Date() } }),
    );

    expect(flat).toHaveLength(1);
    expect(formatPath(flat[0].path)).toBe("nested.at");
    expect(JSON.stringify(flat)).not.toContain("assistant");
  });

  it("never emits the union search space itself", () => {
    const schema = z.array(
      z.union([
        z.object({ kind: z.literal("a"), at: z.union([z.null(), z.string()]) }),
        z.object({ kind: z.literal("b") }),
      ]),
    );
    const flat = flattenIssues(
      issuesFor(schema, [{ kind: "a", at: new Date() }]),
    );

    expect(JSON.stringify(flat)).not.toContain("invalid_union");
  });

  it("reports each offending field once per occurrence", () => {
    const schema = z.object({
      rows: z.array(z.object({ at: z.union([z.null(), z.string()]) })),
    });
    const flat = flattenIssues(
      issuesFor(schema, {
        rows: [{ at: new Date() }, { at: new Date() }, { at: new Date() }],
      }),
    );

    expect(flat.map((issue) => formatPath(issue.path))).toEqual([
      "rows[0].at",
      "rows[1].at",
      "rows[2].at",
    ]);
  });

  it("keeps the union's own message when no branch reported anything", () => {
    const flat = flattenIssues([
      {
        code: "invalid_union",
        path: ["a"],
        errors: [[], []],
        message: "Invalid input",
      },
    ]);

    expect(flat).toHaveLength(1);
    expect(formatPath(flat[0].path)).toBe("a");
    expect(flat[0].message).toBe("Invalid input");
  });

  it("marks the point where it stopped descending a self-referential tree", () => {
    const issue: Record<string, unknown> = {
      code: "invalid_union",
      path: ["a"],
      message: "Invalid input",
    };
    issue.errors = [[issue]];

    const flat = flattenIssues([issue]);

    expect(flat.length).toBeGreaterThan(0);
    expect(flat.at(-1)?.message).toContain("not expanded");
  });
});

describe("formatIssues", () => {
  it("descends a union so the line names the field that failed", () => {
    const schema = z.object({
      payload: z.union([
        z.object({
          kind: z.literal("a"),
          items: z.array(z.object({ id: z.string() })),
        }),
        z.object({ kind: z.literal("b"), value: z.number() }),
      ]),
    });

    expect(
      formatIssues(
        issuesFor(schema, { payload: { kind: "a", items: [{ id: 42 }] } }),
      ),
    ).toBe(
      "payload.items[0].id: Invalid input: expected string, received number",
    );
  });

  it("renders an already-flattened list the same way", () => {
    const schema = z.object({ rows: z.array(z.object({ at: z.string() })) });
    const issues = issuesFor(schema, { rows: [{ at: 1 }] });

    expect(formatIssues(flattenIssues(issues))).toBe(formatIssues(issues));
  });

  it("marks the issues it dropped rather than trimming silently", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      path: ["rows", index, "at"],
      message: "Invalid input",
    }));

    const formatted = formatIssues(many);

    expect(formatted).toContain("rows[0].at");
    expect(formatted).toContain("(+4 more)");
  });

  it("marks a message it had to shorten", () => {
    const formatted = formatIssues([
      { path: ["body"], message: "x".repeat(400) },
    ]);

    expect(formatted).toContain("…");
    expect(formatted.length).toBeLessThan(400);
  });
});

describe("findIssues", () => {
  it("finds issues nested behind a cause chain", () => {
    const zodError = new Error("inner") as Error & { issues: unknown[] };
    zodError.issues = [{ path: ["body"], message: "nope" }];
    const wrapped = new Error("outer", {
      cause: new Error("mid", { cause: zodError }),
    });

    expect(findIssues(wrapped)).toHaveLength(1);
  });

  it("returns undefined when nothing in the chain carries issues", () => {
    expect(
      findIssues(new Error("outer", { cause: new Error("inner") })),
    ).toBeUndefined();
  });

  it("reads issues even though zod makes them non-enumerable", () => {
    const parsed = z.object({ body: z.string() }).safeParse({ body: 1 });
    const error = (parsed as { error: unknown }).error;

    expect(Object.keys(error as object)).not.toContain("issues");
    expect(findIssues(error)).toHaveLength(1);
  });
});
