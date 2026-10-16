import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// Dates render in the reader's zone, so pin one: a test that formats a time
// reads the same on a laptop in Sydney as on a CI runner. Set here, before
// Vitest spawns its workers, so every worker starts with it.
process.env.TZ = "UTC";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // Node 25+ ships its own `localStorage` global, which is undefined without
    // --localstorage-file and stops Vitest installing jsdom's in its place.
    execArgv: ["--no-experimental-webstorage"],
    // Two environments, picked by file name: `*.node.test.ts` runs in plain
    // Node (pure logic, source scans), every other test in jsdom. Each
    // project inherits the rest of this config.
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
    ],
    setupFiles: ["./vitest.setup.ts"],
    // Before each test: clear every spy's calls, restore every `vi.spyOn`,
    // and undo every `vi.stubGlobal` / `vi.stubEnv`, so no test file repeats
    // that cleanup by hand. In Vitest 4 neither clearing nor restoring
    // touches a `vi.fn()`'s implementation, so module-mock factories keep
    // working; anything stubbed in a `beforeAll` is undone before the first
    // test, so stub in `beforeEach` instead.
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
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
