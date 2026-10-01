import { defineConfig, globalIgnores } from "eslint/config";
import { baseConfig } from "../../eslint.config.base.mjs";

const eslintConfig = defineConfig([
  globalIgnores([".turbo/**", "dist/**"]),

  ...baseConfig(import.meta.dirname),
]);

export default eslintConfig;
