import { beforeEach, vi } from "vitest";

const { mockLogger, mockLookup } = vi.hoisted(() => {
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

vi.mock("node:dns/promises", () => ({ lookup: mockLookup }));

beforeEach(() => {
  for (const spy of Object.values(mockLogger)) {
    spy.mockClear();
  }
  mockLookup.mockClear();
});

export { mockLogger, mockLookup };
