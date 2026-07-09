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
  },
  globalIgnores([
    ".next/**",
    ".open-next/**",
    "public/_pagefind/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
