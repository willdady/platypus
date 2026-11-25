import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./src/test-setup.ts"],
    env: {
      ALLOWED_ORIGINS: "http://localhost:3000",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/platypus",
      BETTER_AUTH_URL: "http://localhost:4001",
      FRONTEND_URL: "http://localhost:3000",
    },
    include: ["**/*.test.ts"],
    // why: the .pg tests need a real Postgres; vitest.pg.config.ts runs them
    exclude: ["node_modules", "drizzle", "**/*.pg.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/**", "drizzle/**", "**/*.test.ts", "scripts/**"],
    },
  },
});
