import { defineConfig, globalIgnores } from "eslint/config";
import { baseConfig } from "../../eslint.config.base.mjs";

const DIRECTIVE = /^\s*(eslint-|@ts-|prettier-ignore|global\s)|^\/\s*</;

const noComments = {
  meta: { type: "suggestion", schema: [] },
  create(context) {
    return {
      Program() {
        for (const c of context.sourceCode.getAllComments()) {
          if (DIRECTIVE.test(c.value)) continue;
          if (c.type === "Line" && /^ why: \S/.test(c.value)) continue;
          context.report({
            loc: c.loc,
            message:
              'Comments are banned in apps/backend except directives and a one-line "// why: …".',
          });
        }
      },
    };
  },
};

const POSITIONAL_DB_ROUTE_TESTS = [
  "src/routes/a2a.test.ts",
  "src/routes/attachment.test.ts",
  "src/routes/chat.test.ts",
  "src/routes/context.test.ts",
  "src/routes/files.test.ts",
  "src/routes/hooks.test.ts",
  "src/routes/invitation-link.test.ts",
  "src/routes/invitation.test.ts",
  "src/routes/kanban.test.ts",
  "src/routes/mcp-oauth-callback.test.ts",
  "src/routes/notification.test.ts",
  "src/routes/org-blueprint.test.ts",
  "src/routes/org-inbound-trigger.test.ts",
  "src/routes/org-skill.test.ts",
  "src/routes/org-tool.test.ts",
  "src/routes/plugins.test.ts",
  "src/routes/sandbox-backends.test.ts",
  "src/routes/sandbox.test.ts",
  "src/routes/skill-bundle.test.ts",
  "src/routes/skill.test.ts",
  "src/routes/tool.test.ts",
  "src/routes/trigger-run.test.ts",
  "src/routes/trigger.test.ts",
  "src/routes/user-invitation.test.ts",
  "src/routes/web-backends.test.ts",
  "src/routes/webhook.test.ts",
];

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
    ignores: POSITIONAL_DB_ROUTE_TESTS,
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
