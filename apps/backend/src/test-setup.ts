import { beforeEach, vi } from "vitest";

/**
 * Shared backend test mocks, installed once for every test file via
 * `test.setupFiles` in `vitest.config.ts`.
 *
 * A test that asserts on either mock imports the exported spy instead of
 * re-declaring its own `vi.mock`, so the whole suite agrees on one logger and
 * one deterministic `nanoid`. `child` is part of the logger because the plugin
 * loader derives each plugin's own logger from it.
 */
const { mockLogger, mockNanoid } = vi.hoisted(() => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    mockLogger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => child),
    },
    // A deterministic 21-character id, matching real `nanoid()`'s default
    // length so tests that assert on id shape (e.g. an invitation token) still
    // hold. Tests that need a specific id override it with `mockReturnValue`.
    mockNanoid: vi.fn(() => "test-id-1234567890abc"),
  };
});

vi.mock("./logger.ts", () => ({ logger: mockLogger }));
// Partial mock: keep `customAlphabet` (and any future export) real, override
// only the default `nanoid()` the deterministic-id tests rely on.
vi.mock("nanoid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nanoid")>();
  return { ...actual, nanoid: mockNanoid };
});

// These mocks live for the whole file, so clear their call history between
// tests: the per-file copies they replace were fresh per file, and a test that
// spies on the logger assumes a clean slate.
beforeEach(() => {
  for (const spy of Object.values(mockLogger)) {
    spy.mockClear();
  }
  mockNanoid.mockClear();
});

export { mockLogger, mockNanoid };
