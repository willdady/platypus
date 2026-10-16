import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    // Node 25+ ships its own `localStorage` global, which is undefined without
    // --localstorage-file and stops Vitest installing jsdom's in its place.
    execArgv: ["--no-experimental-webstorage"],
    include: ["**/*.test.ts", "**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
    // What `lib/env.ts` validates; a real deployment must set it too.
    env: { BACKEND_URL: "http://localhost:4001" },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      // Every source file counts, imported by a test or not — without an
      // `include`, a file no test touches is left out and the total reads
      // high.
      include: [
        "app/**/*.{ts,tsx}",
        "components/**/*.{ts,tsx}",
        "hooks/**/*.{ts,tsx}",
        "lib/**/*.{ts,tsx}",
        "instrumentation*.ts",
      ],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "test/**"],
      // A ratchet: each is the measured total rounded down. Raise them when
      // coverage goes up; a change that lowers coverage fails `test:coverage`.
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
      // Tests run outside React's server condition, where `server-only`
      // throws on import. Resolve it to the no-op Server Components get.
      "server-only": path.resolve(
        __dirname,
        "node_modules/server-only/empty.js",
      ),
    },
  },
});
