import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import vitest from "@vitest/eslint-plugin";
import testingLibrary from "eslint-plugin-testing-library";
import jestDom from "eslint-plugin-jest-dom";
import betterTailwindcss from "eslint-plugin-better-tailwindcss";
import tseslint from "typescript-eslint";
import path from "node:path";
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
              ? `${count} comments, baseline allows ${allowed}. Comments are banned in apps/frontend except directives and a one-line "// why: …".`
              : `${count} comments, below the baseline of ${allowed}. Set "${file}" to ${count} in comment-baseline.json (delete the entry at 0).`,
        });
      },
    };
  },
};

const TS_FILES = ["**/*.ts", "**/*.tsx"];
const TEST_FILES = ["**/*.test.ts", "**/*.test.tsx"];

const RAW_WRITE_FETCH = {
  selector:
    "CallExpression[callee.name='fetch']:has(Property[key.name='method'][value.value!='GET'])",
  message:
    "Writes go through writeEntity()/writeAt() in lib/api-write.ts, not a raw fetch() — see ADR-0010 and #563.",
};

const HAND_BUILT_ORG_PATH = {
  selector:
    "TemplateLiteral[quasis.0.value.raw=/^\\/organizations\\//]:not(TaggedTemplateExpression > .quasi)",
  message:
    "Build backend paths with scopedUrl()/scopedPath() from lib/api-write.ts (or backendPath on the server), not a template literal.",
};

const TOP_LEVEL_FUNCTION_DECLARATIONS = {
  selector:
    ":matches(Program, Program > ExportNamedDeclaration) > VariableDeclaration > VariableDeclarator > :matches(ArrowFunctionExpression, FunctionExpression)",
  message:
    "Declare top-level functions and components with `function`, not a const arrow.",
};

const DISABLED_BADGE = {
  selector:
    ":matches(JSXElement[openingElement.name.name='Badge']:has(JSXText[value=/^\\s*Disabled\\s*$/]), JSXElement[openingElement.name.name='Badge']:has(JSXExpressionContainer > Literal[value='Disabled']))",
  message:
    "Render a disabled item's badge with DisabledBadge from components/disabled-badge, not a hand-built Badge.",
};

const HAND_BUILT_LOADING_REGION = {
  selector:
    ":matches(JSXOpeningElement:has(JSXAttribute[name.name='aria-label'][value.value=/^Loading /]), JSXOpeningElement:has(JSXAttribute[name.name='aria-label'][value.expression.quasis.0.value.raw=/^Loading /]))",
  message:
    'Wrap a skeleton in LoadingRegion from components/list-skeletons (label="Loading …"), not an aria-label of your own.',
};

const HAND_BUILT_ROW_ACTIONS_MENU = {
  selector: "JSXOpeningElement[name.name='DropdownMenu']",
  message:
    "Build a list row's ⋮ menu with RowActionsMenu from components/row-actions-menu, not DropdownMenu primitives.",
};

const INLINE_NAME_SORT = {
  selector:
    "CallExpression[callee.property.name=/^(sort|toSorted)$/]:has(CallExpression[callee.property.name='localeCompare'][callee.object.property.name='name'])",
  message:
    "Sort by name with sortByName() from lib/utils, not an inline comparator.",
};

const SYNTAX_RULES = {
  topLevelFunctions: TOP_LEVEL_FUNCTION_DECLARATIONS,
  rawWriteFetch: RAW_WRITE_FETCH,
  handBuiltOrgPath: HAND_BUILT_ORG_PATH,
  disabledBadge: DISABLED_BADGE,
  loadingRegion: HAND_BUILT_LOADING_REGION,
  rowActionsMenu: HAND_BUILT_ROW_ACTIONS_MENU,
  sortByName: INLINE_NAME_SORT,
};

function syntaxRules(...exempt) {
  return [
    "error",
    ...Object.entries(SYNTAX_RULES)
      .filter(([name]) => !exempt.includes(name))
      .map(([, rule]) => rule),
  ];
}

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: TS_FILES,
  })),
  {
    settings: {
      react: {
        // why: eslint-config-next's "detect" makes eslint-plugin-react call context.getFilename(), which ESLint 10 removed and every lint run crashes on; drop the pin once the plugin supports ESLint 10
        version: "19.2",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { ignoreRestSiblings: true },
      ],
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
  {
    plugins: { local: { rules: { "no-comments": noComments } } },
    rules: { "local/no-comments": "error" },
  },
  {
    files: TS_FILES,
    languageOptions: {
      parserOptions: {
        // why: projectService only finds a file's nearest tsconfig.json, and the app tsconfig excludes the tests, so every test file would fail to parse
        project: ["./tsconfig.json", "./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { disallowTypeAnnotations: false },
      ],
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["lib/api-write.ts"],
    rules: {
      "no-restricted-syntax": syntaxRules(),
    },
  },
  {
    files: ["lib/api-write.ts"],
    rules: {
      "no-restricted-syntax": syntaxRules("rawWriteFetch", "handBuiltOrgPath"),
    },
  },
  {
    files: ["components/disabled-badge.tsx"],
    rules: { "no-restricted-syntax": syntaxRules("disabledBadge") },
  },
  {
    files: ["components/list-skeletons.tsx"],
    rules: { "no-restricted-syntax": syntaxRules("loadingRegion") },
  },
  {
    files: ["components/row-actions-menu.tsx"],
    rules: { "no-restricted-syntax": syntaxRules("rowActionsMenu") },
  },
  {
    files: ["components/app-sidebar.tsx"],
    rules: { "no-restricted-syntax": syntaxRules("rowActionsMenu") },
  },
  {
    files: ["components/notifications-dropdown.tsx"],
    rules: { "no-restricted-syntax": syntaxRules("rowActionsMenu") },
  },
  {
    files: ["components/mode-toggle.tsx"],
    rules: { "no-restricted-syntax": syntaxRules("rowActionsMenu") },
  },
  {
    files: ["components/header.tsx"],
    rules: { "no-restricted-syntax": syntaxRules("rowActionsMenu") },
  },
  {
    files: ["components/workspace-switcher.tsx"],
    rules: { "no-restricted-syntax": syntaxRules("rowActionsMenu") },
  },
  {
    files: ["components/kanban-board.tsx"],
    rules: { "no-restricted-syntax": syntaxRules("rowActionsMenu") },
  },
  {
    files: ["components/kanban-card-dialog.tsx"],
    rules: { "no-restricted-syntax": syntaxRules("rowActionsMenu") },
  },
  {
    files: ["components/ai-elements/**"],
    rules: { "no-restricted-syntax": syntaxRules("rowActionsMenu") },
  },
  {
    files: TEST_FILES,
    rules: { "no-restricted-syntax": syntaxRules("rowActionsMenu") },
  },
  {
    files: ["lib/utils.ts"],
    rules: { "no-restricted-syntax": syntaxRules("sortByName") },
  },
  {
    files: ["lib/slash-commands.ts"],
    rules: { "no-restricted-syntax": syntaxRules("sortByName") },
  },
  {
    files: ["components/user-menu.tsx"],
    rules: {
      "no-restricted-syntax": syntaxRules("rowActionsMenu", "loadingRegion"),
    },
  },
  {
    files: ["components/model-selector-dialog.tsx"],
    rules: { "no-restricted-syntax": syntaxRules("loadingRegion") },
  },
  {
    files: ["components/manage-sharing.tsx"],
    rules: { "no-restricted-syntax": syntaxRules("loadingRegion") },
  },
  {
    files: ["app/\\[orgId\\]/workspace/\\[workspaceId\\]/(sidebar)/page.tsx"],
    rules: { "no-restricted-syntax": syntaxRules("loadingRegion") },
  },
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
  {
    files: TEST_FILES,
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
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
      "testing-library/no-node-access": "error",
      "testing-library/no-container": "error",
      "testing-library/no-unnecessary-act": "error",
      "testing-library/render-result-naming-convention": "off",
    },
  },
  {
    files: TEST_FILES,
    ...jestDom.configs["flat/recommended"],
  },
  {
    files: TEST_FILES,
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/unbound-method": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-base-to-string": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/prefer-promise-reject-errors": "error",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "coverage/**",
  ]),
]);

export default eslintConfig;
