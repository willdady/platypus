import { defineConfig, globalIgnores } from "eslint/config";
import { baseConfig } from "../../eslint.config.base.mjs";

/**
 * Route tests still on the chainable `mockDb`, which ignores every `WHERE` and
 * answers queries in call order (#1621). Migrate a file to `seedDb()` and
 * delete it here; never add one.
 */
const POSITIONAL_DB_ROUTE_TESTS = [
  "src/routes/a2a.test.ts",
  "src/routes/attachment.test.ts",
  "src/routes/chat.test.ts",
  "src/routes/context.test.ts",
  "src/routes/dashboard.test.ts",
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
  // Generated migration artifacts and build/cache output are not source.
  globalIgnores(["drizzle/**", ".turbo/**", "dist/**"]),

  ...baseConfig(import.meta.dirname),

  {
    // A route test seeds rows with `seedDb()`, so a query that dropped its
    // filter reads the wrong row and fails, rather than stubbing results in
    // the order the route happens to query.
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
]);

export default eslintConfig;
