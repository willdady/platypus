import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * The type-checked ESLint config shared by every Node TypeScript package
 * (apps/backend and packages/*). A package's own `eslint.config.mjs` spreads
 * this and adds only what is particular to it, such as generated directories
 * to ignore. The Next.js apps use eslint-config-next instead.
 *
 * @param {string} tsconfigRootDir the package's directory — pass
 *   `import.meta.dirname` from its `eslint.config.mjs`.
 */
export function baseConfig(tsconfigRootDir) {
  return defineConfig([
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,

    {
      languageOptions: {
        globals: { ...globals.node },
        parserOptions: {
          // Auto-resolves the nearest tsconfig.json (lint-only; inert at runtime
          // since Node's strip-only mode ignores tsconfig). Handles stray files
          // without a hand-maintained `include` array.
          projectService: true,
          tsconfigRootDir,
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

        // `any` and its downstream effects were warnings while the backend was
        // burned down from ~4.2k violations to zero (incl. the typed test-mock
        // harness). Now enforced as errors — uniformly, tests included — so the
        // `any` that dominated the old test mocks can't creep back. Promise-
        // safety rules from recommendedTypeChecked (no-floating-promises,
        // no-misused-promises, await-thenable) are likewise errors.
        "@typescript-eslint/no-explicit-any": "error",
        "@typescript-eslint/no-unsafe-assignment": "error",
        "@typescript-eslint/no-unsafe-member-access": "error",
        "@typescript-eslint/no-unsafe-call": "error",
        "@typescript-eslint/no-unsafe-argument": "error",
        "@typescript-eslint/no-unsafe-return": "error",

        // An `async` function with no `await` is valid (it just returns a
        // resolved promise), but the codebase is now clean of unnecessary ones —
        // enforce as an error so new ones get an explicit decision (drop `async`
        // or add a scoped disable with a reason) rather than silently landing.
        "@typescript-eslint/require-await": "error",

        // Previously a warning for its false-positive rate on AI-SDK model
        // properties (typed as methods) and test spy assertions
        // (`expect(obj.method)`). The remaining genuine cases were resolved, so
        // enforce as an error; suppress with a scoped disable where a known
        // false positive recurs.
        "@typescript-eslint/unbound-method": "error",
      },
    },

    {
      // The flat-config file isn't in any tsconfig's `include`, and the SDK
      // packages (plugin-sdk, example-plugin) deliberately have no `@types/node`,
      // so it can't be typed
      // (`import.meta.dirname` resolves to an error type). Lint it untyped.
      files: ["**/*.mjs"],
      ...tseslint.configs.disableTypeChecked,
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
}
