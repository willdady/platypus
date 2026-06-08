import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

const eslintConfig = defineConfig([
  // Generated migration artifacts and build/cache output are not source.
  globalIgnores(["drizzle/**", ".turbo/**", "dist/**"]),

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        // Auto-resolves the nearest tsconfig.json (lint-only; inert at runtime
        // since Node's strip-only mode ignores tsconfig). Handles stray files
        // without a hand-maintained `include` array. `allowDefaultProject`
        // lets the flat-config file itself be linted (it isn't a `.ts` file in
        // the tsconfig's `include`, so the project service can't type it).
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Dead code is the headline requirement — make it an error. Underscore
      // prefix is the explicit "intentionally unused" escape hatch (ignored
      // params, caught-but-unused errors), and rest siblings cover the
      // destructure-to-omit pattern (`const { id, ...rest } = obj`).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],

      // `any` and its downstream effects are surfaced as warnings to burn down
      // over time, not hard errors — the existing codebase leans on `any` in
      // places (AI-SDK payloads, dynamic tool args) where typing is genuinely
      // hard. Promise-safety rules from recommendedTypeChecked (no-floating-
      // promises, no-misused-promises, await-thenable) stay as errors.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",

      // An `async` function with no `await` is valid (it just returns a
      // resolved promise); flagging it isn't dead-code or a safety issue, and
      // "fixing" it by removing `async` would change the return type and break
      // call sites. Keep as a warning, not a blocking error.
      "@typescript-eslint/require-await": "warn",

      // High false-positive rate in this codebase: fires on AI-SDK model
      // properties (typed as methods) and on test spy assertions
      // (`expect(obj.method)`) that never actually detach `this`. Warn so
      // genuine `this`-binding mistakes still surface without blocking lint.
      "@typescript-eslint/unbound-method": "warn",
    },
  },

  {
    // Tests legitimately throw/reject non-Error values to exercise error
    // handling (e.g. simulating a Postgres error object `{ code: "23505" }`,
    // or rejecting with an AbortSignal's `reason`).
    files: ["**/*.test.ts", "**/*.test-fixtures.ts", "**/test-utils.ts"],
    rules: {
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/prefer-promise-reject-errors": "off",
    },
  },
]);

export default eslintConfig;
