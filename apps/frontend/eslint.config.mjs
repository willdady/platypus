import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import vitest from "@vitest/eslint-plugin";
import testingLibrary from "eslint-plugin-testing-library";
import jestDom from "eslint-plugin-jest-dom";
import betterTailwindcss from "eslint-plugin-better-tailwindcss";
import tseslint from "typescript-eslint";

const TS_FILES = ["**/*.ts", "**/*.tsx"];
const TEST_FILES = ["**/*.test.ts", "**/*.test.tsx"];

const RAW_WRITE_FETCH = {
  selector:
    "CallExpression[callee.name='fetch']:has(Property[key.name='method'][value.value!='GET'])",
  message:
    "Writes go through writeEntity()/writeAt() in lib/api-write.ts, not a raw fetch() — see ADR-0010 and #563.",
};

// A backend path is built by `scopedUrl`/`scopedPath` (lib/api-write.ts), or by
// `backendPath` (lib/server-read.ts) on the server — a tagged template, so
// exempt here. A hand-built copy is a second spelling of the SWR key, and seeding
// or invalidation silently misses when the two drift (#1554).
const HAND_BUILT_ORG_PATH = {
  selector:
    "TemplateLiteral[quasis.0.value.raw=/^\\/organizations\\//]:not(TaggedTemplateExpression > .quasi)",
  message:
    "Build backend paths with scopedUrl()/scopedPath() from lib/api-write.ts (or backendPath on the server), not a template literal.",
};

// Call sites allowed a raw write `fetch()` (see the rule below).
const RAW_FETCH_EXEMPT = [
  "lib/api-write.ts",
  "components/change-password-dialog.tsx",
  "components/agent-form.tsx",
  "hooks/use-shared-resource-actions.ts",
];

// Top-level functions are declarations (`function X() {}`), not a const holding
// an arrow or function expression. `func-style: "declaration"` can't do this:
// it also flags every `const handleX = () => …` inside a component, which stay
// arrows. Lives in `no-restricted-syntax`, so every block setting that rule
// spreads it in.
const TOP_LEVEL_FUNCTION_DECLARATIONS = {
  selector:
    ":matches(Program, Program > ExportNamedDeclaration) > VariableDeclaration > VariableDeclarator > :matches(ArrowFunctionExpression, FunctionExpression)",
  message:
    "Declare top-level functions and components with `function`, not a const arrow.",
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The full type-checked preset, scoped to TypeScript so `.mjs` config files
  // stay linted without type information. It comes before every block below so
  // their settings win — notably the `no-unused-vars` warning, which the
  // preset would otherwise make an error.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: TS_FILES,
  })),
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
    files: TS_FILES,
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
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
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
    ignores: RAW_FETCH_EXEMPT,
    rules: {
      "no-restricted-syntax": [
        "error",
        TOP_LEVEL_FUNCTION_DECLARATIONS,
        RAW_WRITE_FETCH,
        HAND_BUILT_ORG_PATH,
      ],
    },
  },
  // The files exempt from the raw-fetch rule above still get the others, bar
  // lib/api-write.ts, home of the `scopedPath` everyone else must use.
  {
    files: RAW_FETCH_EXEMPT,
    ignores: ["lib/api-write.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        TOP_LEVEL_FUNCTION_DECLARATIONS,
        HAND_BUILT_ORG_PATH,
      ],
    },
  },
  {
    files: ["lib/api-write.ts"],
    rules: {
      "no-restricted-syntax": ["error", TOP_LEVEL_FUNCTION_DECLARATIONS],
    },
  },
  // Tailwind: `size-N` over a matching `h-N w-N` pair (and the other
  // shorthands), and `flex flex-col gap-*` over `space-y-*`.
  {
    plugins: { "better-tailwindcss": betterTailwindcss },
    settings: {
      "better-tailwindcss": { entryPoint: "app/globals.css" },
    },
    rules: {
      "better-tailwindcss/enforce-shorthand-classes": "error",
      "better-tailwindcss/no-restricted-classes": [
        "error",
        {
          restrict: [
            {
              pattern: "^(.*:)?space-y-.*$",
              message: "Use `flex flex-col gap-*` instead of `space-y-*`.",
            },
          ],
        },
      ],
    },
  },
  // Widgets are being removed (#1430), so they keep their old style rather
  // than being rewritten to these conventions. Delete this block with them.
  {
    files: ["components/widgets/**"],
    rules: {
      "no-restricted-syntax": ["error", RAW_WRITE_FETCH, HAND_BUILT_ORG_PATH],
      "@typescript-eslint/consistent-type-definitions": "off",
      "better-tailwindcss/enforce-shorthand-classes": "off",
      "better-tailwindcss/no-restricted-classes": "off",
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
    files: ["components/**/*.ts", "components/**/*.tsx"],
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
      // many to fix in one change (150, 31 and 23 when these rules landed),
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
  // Ratchets on the type-checked preset, for test files only: app code and
  // the `test/` helpers hold every one of these as an error. Each count is the
  // current violations, so a rule that gains one is visible in the diff. Fix
  // them as you touch a file, and make each rule an error once it reaches 0.
  // `require-await` is off outright: see the note beside it.
  {
    files: TEST_FILES,
    rules: {
      // Every occurrence is a test double that must stay `async`: React
      // Testing Library's `act(async () => …)` flushes microtasks, and a
      // mocked `Response.json()` / `next/headers` `headers()` returns a
      // Promise by contract. Removing `async` would change what the test
      // does, so this one is off rather than ratcheted.
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unsafe-member-access": "warn", // 39
      "@typescript-eslint/no-unnecessary-type-assertion": "warn", // 35
      "@typescript-eslint/no-unsafe-assignment": "warn", // 21
      "@typescript-eslint/unbound-method": "warn", // 13
      "@typescript-eslint/no-unsafe-return": "warn", // 10
      "@typescript-eslint/no-base-to-string": "warn", // 8
      "@typescript-eslint/no-unsafe-call": "warn", // 7
      "@typescript-eslint/no-unsafe-argument": "warn", // 6
      "@typescript-eslint/prefer-promise-reject-errors": "warn", // 1
    },
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
