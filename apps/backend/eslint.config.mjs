import path from "node:path";
import { defineConfig, globalIgnores } from "eslint/config";
import { baseConfig } from "../../eslint.config.base.mjs";
import commentBaseline from "./comment-baseline.json" with { type: "json" };

const DIRECTIVE = /^\s*(eslint-|@ts-|prettier-ignore|global\s)|^\/\s*</;

const noComments = {
  meta: { type: "suggestion", schema: [] },
  create(context) {
    return {
      Program(node) {
        const file = path.relative(import.meta.dirname, context.filename);
        const count = context.sourceCode
          .getAllComments()
          .filter(
            (c) =>
              !DIRECTIVE.test(c.value) &&
              !(c.type === "Line" && /^ why: \S/.test(c.value)),
          ).length;
        const allowed = commentBaseline[file] ?? 0;
        if (count === allowed) return;
        context.report({
          node,
          loc: { line: 1, column: 0 },
          message:
            count > allowed
              ? `${count} comments, baseline allows ${allowed}. Comments are banned in apps/backend except a one-line "// why: …"; run /delete-comment.`
              : `${count} comments, below the baseline of ${allowed}. Set "${file}" to ${count} in comment-baseline.json (delete the entry at 0).`,
        });
      },
    };
  },
};

const eslintConfig = defineConfig([
  globalIgnores(["drizzle/**", ".turbo/**", "dist/**"]),

  ...baseConfig(import.meta.dirname),

  {
    plugins: { local: { rules: { "no-comments": noComments } } },
    rules: {
      "local/no-comments": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  {
    files: ["src/routes/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Identifier[name='mockDb']",
          message:
            "Seed rows with seedDb() instead of stubbing the chainable mockDb.",
        },
        {
          selector: "Identifier[name=/^mock(Resolved|Rejected)ValueOnce$/]",
          message:
            "Seed rows with seedDb() instead of stubbing results in call order; fail a query with onQuery and dbError().",
        },
      ],
    },
  },

  {
    files: [
      "**/*.test.ts",
      "**/*.test-fixtures.ts",
      "src/test-utils.ts",
      "src/test-mocks.ts",
      "src/fake-db.ts",
      "src/test-setup.ts",
      "vitest.config.ts",
    ],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: "./tsconfig.test.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);

export default eslintConfig;
