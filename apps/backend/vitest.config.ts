import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./src/test-setup.ts"],
    // The one variable `env.ts` requires, so every module can read it.
    env: { ALLOWED_ORIGINS: "http://localhost:3000" },
    include: ["**/*.test.ts"],
    exclude: ["node_modules", "drizzle"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/**", "drizzle/**", "**/*.test.ts", "scripts/**"],
    },
  },
});
