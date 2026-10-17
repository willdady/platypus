import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import vitest from "@vitest/eslint-plugin";
import testingLibrary from "eslint-plugin-testing-library";
import jestDom from "eslint-plugin-jest-dom";

const TEST_FILES = ["**/*.test.ts", "**/*.test.tsx"];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // eslint-config-next sets `settings.react.version = "detect"`, which makes
  // eslint-plugin-react@7.37.5 call the `context.getFilename()` API that was
  // removed in ESLint 10, crashing every lint run. Pin an explicit version to
  // skip auto-detection. Remove once eslint-plugin-react ships ESLint 10 support.
  {
    settings: {
      react: {
        version: "19.2",
      },
    },
    rules: {
      // Allow the destructure-to-omit pattern (e.g. `const { id, ...rest } = obj`)
      // where the named siblings are intentionally discarded.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { ignoreRestSiblings: true },
      ],
      // next/core-web-vitals ships only a handful of jsx-a11y rules. These
      // catch the mouse-only controls and unlabelled fields #1481 found by
      // hand: a click handler on a non-interactive element with no keyboard
      // equivalent, and a label tied to nothing.
      "jsx-a11y/click-events-have-key-events": "error",
      "jsx-a11y/no-static-element-interactions": "error",
      "jsx-a11y/label-has-associated-control": [
        "error",
        {
          labelComponents: ["Label", "FieldLabel"],
          assert: "htmlFor",
        },
      ],
      "jsx-a11y/no-autofocus": "warn",
    },
  },
  // Type-aware rules for TypeScript files. `project` lists both tsconfigs
  // rather than using `projectService`: the app tsconfig excludes the tests,
  // and `projectService` only finds a file's nearest `tsconfig.json`, so every
  // test file would fail to parse.
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `typeof import("…")` stays allowed: it's Vitest's idiom for typing
      // `importOriginal`/`vi.importActual` inside a `vi.mock` factory.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { disallowTypeAnnotations: false },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      // React ignores the promise an event handler returns, so `onClick={async
      // () => …}` is fine; wrapping each in `void` would only add noise.
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  // A write (any `fetch` call whose `method` is anything but `"GET"`) must go
  // through the typed-outcome request module (lib/api-write.ts, #563) rather
  // than a hand-rolled call — that module is the only seam that maps the
  // backend's ADR-0010 error responses consistently. A handful of call sites
  // predate the module and can't move onto it (see the comment at each): a
  // better-auth admin action needing a bespoke `Origin` header, a multipart
  // avatar upload, and the shared Promote write (every Shared resource's) whose
  // 422 "blockers" checklist the module's outcome type doesn't carry.
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: [
      "lib/api-write.ts",
      "components/change-password-dialog.tsx",
      "components/agent-form.tsx",
      "hooks/use-shared-resource-actions.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name='fetch']:has(Property[key.name='method'][value.value!='GET'])",
          message:
            "Writes go through writeEntity()/writeAt() in lib/api-write.ts, not a raw fetch() — see ADR-0010 and #563.",
        },
      ],
    },
  },
  // The frontend never compiles backend source: the Chat UI message contract
  // it shares with the backend lives in `@platypus/schemas` (#1505).
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@platypus/backend", "@platypus/backend/*"],
              message:
                "The frontend must not import backend source; shared types live in @platypus/schemas.",
            },
            {
              regex: "^(\\.\\./)+(apps/)?backend(/|$)",
              message:
                "The frontend must not import backend source; shared types live in @platypus/schemas.",
            },
          ],
        },
      ],
    },
  },
  // A hook lives in `hooks/`, not in a component module. The exceptions pair a
  // hook with the context it reads, which their module keeps private; `ui/`
  // and `ai-elements/` are vendored (shadcn, AI Elements).
  {
    files: ["components/**/*.tsx"],
    ignores: [
      ...TEST_FILES,
      "components/auth-provider.tsx",
      "components/unsaved-changes-guard.tsx",
      "components/ui/**",
      "components/ai-elements/**",
    ],
    rules: {
      "no-restricted-exports": [
        "error",
        { restrictedNamedExportsPattern: "^use[A-Z]" },
      ],
    },
  },
  // `lib/` holds plain helpers; a component (a PascalCase export) belongs in
  // `components/`.
  {
    files: ["lib/**/*.ts", "lib/**/*.tsx"],
    ignores: TEST_FILES,
    rules: {
      "no-restricted-exports": [
        "error",
        { restrictedNamedExportsPattern: "^[A-Z][a-z]" },
      ],
    },
  },
  // Test files: Vitest, Testing Library and jest-dom rules.
  {
    files: TEST_FILES,
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      // A helper named `expect…` (e.g. `expectThemedSpinner`) asserts too.
      "vitest/expect-expect": [
        "error",
        { assertFunctionNames: ["expect", "expect*"] },
      ],
      "vitest/no-focused-tests": "error",
    },
  },
  {
    files: TEST_FILES,
    ...testingLibrary.configs["flat/react"],
  },
  {
    files: TEST_FILES,
    rules: {
      "testing-library/prefer-screen-queries": "error",
      // Ratchets: warnings, not errors, because the existing tests have too
      // many to fix in one change (132, 30 and 23 when these rules landed),
      // and many need an accessible name or role the component lacks. Fix
      // them as you touch a file, and make each an error once it reaches 0.
      "testing-library/no-node-access": "warn",
      "testing-library/no-container": "warn",
      "testing-library/no-unnecessary-act": "warn",
      // Flags any variable a `render…` helper's result is assigned to, which
      // misfires on our own helpers that return something else (a spy, a
      // list of forms).
      "testing-library/render-result-naming-convention": "off",
    },
  },
  {
    files: TEST_FILES,
    ...jestDom.configs["flat/recommended"],
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vitest's coverage report. Generated JavaScript, and it carries its own
    // `eslint-disable` headers that this config then reports as unused — so a
    // developer who has run `test:coverage` lints a different set of warnings
    // from CI, which has no such directory.
    "coverage/**",
  ]),
]);

export default eslintConfig;
