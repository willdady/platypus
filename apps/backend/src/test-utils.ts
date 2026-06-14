import { vi, type Mock } from "vitest";
import type {
  InferToolInput,
  InferToolOutput,
  Tool,
  ToolCallOptions,
} from "ai";

/** Default tool-call context for tests; tools rarely read these fields. */
const TEST_TOOL_OPTIONS: ToolCallOptions = { toolCallId: "test", messages: [] };

/**
 * Invokes a tool's `execute` in tests. The AI SDK types `execute` as optional
 * and lets it return an `AsyncIterable` (streaming) alongside the plain result,
 * so calling it directly trips `tsc --noEmit`. Our non-streaming tools always
 * resolve to a value, so this asserts `execute` exists and narrows away the
 * streaming branch, returning the awaited result.
 */
export async function callTool<TOOL extends Tool>(
  tool: TOOL,
  input: InferToolInput<TOOL>,
  options: ToolCallOptions = TEST_TOOL_OPTIONS,
): Promise<Exclude<InferToolOutput<TOOL>, AsyncIterable<unknown>>> {
  if (typeof tool.execute !== "function") {
    throw new Error("Tool has no execute function");
  }
  const result: unknown = await tool.execute(input, options);
  return result as Exclude<InferToolOutput<TOOL>, AsyncIterable<unknown>>;
}

/**
 * Narrows a tool result to its success branch, throwing if the tool returned an
 * `{ error }` payload. Tools that can fail return `Success | { error: string }`;
 * tests that expect success use this to drop the error branch.
 */
export function expectOk<T>(result: T): Exclude<T, { error: string }> {
  if (result && typeof result === "object" && "error" in result) {
    throw new Error(
      `Expected a success result but got an error: ${String(
        (result as { error: unknown }).error,
      )}`,
    );
  }
  return result as Exclude<T, { error: string }>;
}

/** Convenience: invoke a tool and narrow the result to its success branch. */
export async function callOkTool<TOOL extends Tool>(
  tool: TOOL,
  input: InferToolInput<TOOL>,
  options: ToolCallOptions = TEST_TOOL_OPTIONS,
): Promise<
  Exclude<InferToolOutput<TOOL>, AsyncIterable<unknown> | { error: string }>
> {
  return expectOk(await callTool(tool, input, options)) as Exclude<
    InferToolOutput<TOOL>,
    AsyncIterable<unknown> | { error: string }
  >;
}

// Set environment variables for tests
process.env.ALLOWED_ORIGINS = "http://localhost:3000";
process.env.DATABASE_URL = "postgres://localhost:5432/test";
process.env.STORAGE_BACKEND = "disk";

/**
 * The chainable Drizzle query-builder methods exposed by the mock. Every method
 * is a vitest `Mock` that returns the same mock instance, so a full chain like
 * `db.select().from(...).where(...).limit(1)` resolves back to the same object.
 */
type BuilderMethodName =
  | "select"
  | "from"
  | "where"
  | "limit"
  | "offset"
  | "orderBy"
  | "innerJoin"
  | "leftJoin"
  | "rightJoin"
  | "insert"
  | "values"
  | "update"
  | "set"
  | "delete"
  | "returning"
  | "execute"
  | "inArray"
  | "groupBy"
  | "onConflictDoNothing"
  | "onConflictDoUpdate";

/** A single chainable builder method: callable with anything, returns the mock. */
type ChainableMethod = Mock<(...args: unknown[]) => MockDb>;

/**
 * A chainable, awaitable Drizzle query-builder mock.
 *
 * Every builder method returns the same typed mock so chains type-check without
 * `any`. The mock is `PromiseLike` so `await db.select()...` resolves: the
 * awaited result is `unknown`, which lets tests stub a terminal link with
 * `.mockResolvedValueOnce([...])` returning arbitrary rows.
 */
export type MockDb = PromiseLike<unknown> & {
  [K in BuilderMethodName]: ChainableMethod;
} & {
  transaction: Mock<(cb: (tx: MockDb) => unknown) => unknown>;
};

/**
 * (Re)installs fresh chainable builder mocks on `target`. Each method returns
 * `target` itself so the chain stays anchored to the same instance — tests stub
 * terminal links (e.g. `mockDb.limit`) and the chain resolves through them.
 *
 * Declared as a hoisted function (with a function-local method list) so the
 * `vi.hoisted` block below can call it before the module body — and its
 * dependencies — have initialised.
 */
function installBuilderMethods(target: MockDb): void {
  const methods: readonly BuilderMethodName[] = [
    "select",
    "from",
    "where",
    "limit",
    "offset",
    "orderBy",
    "innerJoin",
    "leftJoin",
    "rightJoin",
    "insert",
    "values",
    "update",
    "set",
    "delete",
    "returning",
    "execute",
    "inArray",
    "groupBy",
    "onConflictDoNothing",
    "onConflictDoUpdate",
  ];
  for (const method of methods) {
    target[method] = vi.fn((..._args: unknown[]) => target);
  }
  target.transaction = vi.fn((cb: (tx: MockDb) => unknown) => cb(target));
}

/**
 * Casts the chainable mock to whatever concrete Drizzle `db`/transaction type a
 * function under test expects. The mock is structurally a query builder but not
 * a `NodePgDatabase`/`PgTransaction`, so call sites pass `asDb(mockDb)` and let
 * the target parameter's type drive inference of `T`.
 */
export function asDb<T>(db: MockDb): T {
  return db as unknown as T;
}

/**
 * Creates a fresh, fully typed chainable query-builder mock. Use this when a
 * test needs an isolated `db` mock; the shared `mockDb` export covers the common
 * case where the module-level `db` is mocked.
 */
export function createMockDb(): MockDb {
  const mock = {} as MockDb;
  installBuilderMethods(mock);
  return mock;
}

const { mockDb, mockAuth } = vi.hoisted(() => {
  const mock = createMockDb();

  // Auth mock
  const authMock = {
    api: {
      getSession: vi.fn(),
    },
    $Infer: {
      Session: {
        user: {} as unknown,
        session: {} as unknown,
      },
    },
  };

  return { mockDb: mock, mockAuth: authMock };
});

export { mockDb, mockAuth };

/** Resets the shared `mockDb` to fresh chainable mocks, clearing stubbed state. */
export const resetMockDb = () => {
  installBuilderMethods(mockDb);
};

// Mock the database module
vi.mock("./index.ts", () => ({
  db: mockDb,
}));

// Mock drizzle-orm
vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  const sqlMock = Object.assign(
    vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => ({
      getSQL: () => ({ query: strings.join("?") }),
      mapWith: vi.fn(),
    })),
    {
      raw: vi.fn((query: string) => ({ getSQL: () => ({ query }) })),
    },
  );
  return {
    ...actual,
    eq: vi.fn(),
    and: vi.fn((...args: unknown[]) => args.filter(Boolean)), // Return non-null args
    or: vi.fn(),
    inArray: vi.fn(),
    asc: vi.fn(),
    count: vi.fn(),
    max: vi.fn(),
    desc: vi.fn(),
    isNull: vi.fn(),
    sql: sqlMock,
  };
});

// Mock auth
vi.mock("./auth.ts", () => ({
  auth: mockAuth,
}));

/**
 * Helper to mock a successful session
 */
export const mockSession = (
  user: unknown = { id: "user-1", email: "test@example.com", role: "user" },
) => {
  mockAuth.api.getSession.mockResolvedValue({
    user,
    session: { id: "session-1" },
  });
};

/**
 * Helper to mock no session
 */
export const mockNoSession = () => {
  mockAuth.api.getSession.mockResolvedValue(null);
};
