import { beforeEach, vi } from "vitest";

/**
 * Shared backend test mocks, installed once for every test file via
 * `test.setupFiles` in `vitest.config.ts`.
 *
 * A test that asserts on either mock imports the exported spy instead of
 * re-declaring its own `vi.mock`, so the whole suite agrees on one logger and
 * one deterministic `nanoid` — and one DNS, so the egress guard never resolves
 * a real name. `child` is part of the logger because the plugin
 * loader derives each plugin's own logger from it.
 */
const { mockLogger, mockNanoid, mockLookup } = vi.hoisted(() => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
  return {
    mockLogger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(() => child),
    },
    // A deterministic 21-character id, matching real `nanoid()`'s default
    // length so tests that assert on id shape (e.g. an invitation token) still
    // hold. Tests that need a specific id override it with `mockReturnValue`.
    mockNanoid: vi.fn(() => "test-id-1234567890abc"),
    // The egress guard resolves every hostname. `localhost` is loopback, a name
    // starting `internal` is the metadata service, a `.invalid` name does not
    // resolve, and any other name is a public address. Called as
    // `lookup(name, { all: true })`.
    mockLookup: vi.fn((hostname: string) =>
      hostname.endsWith(".invalid")
        ? Promise.reject(new Error(`getaddrinfo ENOTFOUND ${hostname}`))
        : Promise.resolve([
            {
              address:
                hostname === "localhost"
                  ? "127.0.0.1"
                  : hostname.startsWith("internal")
                    ? "169.254.169.254"
                    : "93.184.215.14",
              family: 4,
            },
          ]),
    ),
  };
});

vi.mock("./logger.ts", () => ({ logger: mockLogger }));
// Partial mock: keep `customAlphabet` (and any future export) real, override
// only the default `nanoid()` the deterministic-id tests rely on.
vi.mock("nanoid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nanoid")>();
  return { ...actual, nanoid: mockNanoid };
});

vi.mock("node:dns/promises", () => ({ lookup: mockLookup }));

// These mocks live for the whole file, so clear their call history between
// tests: the per-file copies they replace were fresh per file, and a test that
// spies on the logger assumes a clean slate.
beforeEach(() => {
  for (const spy of Object.values(mockLogger)) {
    spy.mockClear();
  }
  mockNanoid.mockClear();
  mockLookup.mockClear();
});

export { mockLogger, mockNanoid, mockLookup };
