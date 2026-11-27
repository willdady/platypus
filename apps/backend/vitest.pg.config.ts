import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// why: these tests need a real Postgres, which `pnpm test` must not need
try {
  process.loadEnvFile(fileURLToPath(new URL(".env", import.meta.url)));
} catch {
  // why: a missing .env is fine when the environment already supplies the variables
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./src/test-setup.ts"],
    env: {
      ALLOWED_ORIGINS: "http://localhost:3000",
      BETTER_AUTH_URL: "http://localhost:4001",
      FRONTEND_URL: "http://localhost:3000",
    },
    include: ["src/**/*.pg.test.ts"],
    exclude: ["node_modules", "drizzle"],
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
