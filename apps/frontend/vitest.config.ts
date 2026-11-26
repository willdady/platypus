import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

process.env.TZ = "UTC";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // why: Node 25 ships a localStorage global that stops Vitest installing jsdom's
    execArgv: ["--no-experimental-webstorage"],
    projects: [
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["**/*.test.ts", "**/*.test.tsx"],
          exclude: ["**/*.node.test.ts", "**/node_modules/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["**/*.node.test.ts"],
          exclude: ["**/node_modules/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "types",
          include: [],
          typecheck: {
            enabled: true,
            only: true,
            tsconfig: "./tsconfig.test.json",
          },
        },
      },
    ],
    setupFiles: ["./vitest.setup.ts"],
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    env: { BACKEND_URL: "http://localhost:4001" },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      include: [
        "app/**/*.{ts,tsx}",
        "components/**/*.{ts,tsx}",
        "hooks/**/*.{ts,tsx}",
        "lib/**/*.{ts,tsx}",
        "instrumentation*.ts",
      ],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/*.test-d.ts", "test/**"],
      thresholds: {
        statements: 79,
        branches: 76,
        functions: 72,
        lines: 80,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
      "server-only": path.resolve(
        __dirname,
        "node_modules/server-only/empty.js",
      ),
    },
  },
});
