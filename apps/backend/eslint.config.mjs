import { defineConfig, globalIgnores } from "eslint/config";
import { baseConfig } from "../../eslint.config.base.mjs";

const eslintConfig = defineConfig([
  // Generated migration artifacts and build/cache output are not source.
  globalIgnores(["drizzle/**", ".turbo/**", "dist/**"]),

  ...baseConfig(import.meta.dirname),

  {
    // The production tsconfig excludes these (they type-check without
    // `noUncheckedIndexedAccess`), so the project service would find no
    // project for them. Point them at the test tsconfig instead.
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
