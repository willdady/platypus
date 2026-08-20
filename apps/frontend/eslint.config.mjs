import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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
    },
  },
  // A write (any `fetch` call whose `method` is anything but `"GET"`) must go
  // through the typed-outcome request module (lib/api-write.ts, #563) rather
  // than a hand-rolled call — that module is the only seam that maps the
  // backend's ADR-0010 error responses consistently. A handful of call sites
  // predate the module and can't move onto it (see the comment at each): a
  // better-auth admin action needing a bespoke `Origin` header, a multipart
  // avatar upload, and one write whose 422 "blockers" checklist the module's
  // outcome type doesn't carry.
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: [
      "lib/api-write.ts",
      "components/delete-user-dialog.tsx",
      "components/change-password-dialog.tsx",
      "components/agent-form.tsx",
      "components/agents-list.tsx",
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
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
