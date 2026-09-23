import { vi, type Mock } from "vitest";
import {
  createFakeDb,
  type FakeDb,
  type FakeDbOptions,
  type Store,
} from "./fake-db.ts";

export type { FakeDb, Row, Store } from "./fake-db.ts";
import type {
  PluginConfigContext,
  PluginLogger,
} from "@platypuschat/plugin-sdk";
import type {
  ContributionOwners,
  LoadedPlugin,
  LoadPluginsResult,
} from "./plugins/loader.ts";
import type { WebhookEventData, WebhookEventPayload } from "@platypus/schemas";
import type {
  InferToolInput,
  InferToolOutput,
  Tool,
  ToolExecutionOptions,
} from "ai";

/** Default tool-call context for tests; tools rarely read these fields. */
const TEST_TOOL_OPTIONS: ToolExecutionOptions<unknown> = {
  toolCallId: "test",
  messages: [],
  context: undefined,
};

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
  options: ToolExecutionOptions<unknown> = TEST_TOOL_OPTIONS,
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
  options: ToolExecutionOptions<unknown> = TEST_TOOL_OPTIONS,
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
  | "for"
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
    "for",
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

const { mockDb, mockAuth, dbHandle, fakeRef } = vi.hoisted(() => {
  const mock = createMockDb();

  /**
   * Which handle the mocked `db` module currently stands for: the chainable
   * mock by default, a {@link seedDb} fake while one is installed.
   */
  const ref: { current: { handle: unknown } | null } = { current: null };

  /**
   * The object every module's `import { db }` binds to. It forwards each
   * property access to whichever handle is installed *at call time*, so a test
   * can swap in a seeded fake after the routes have already been imported —
   * and every test file that stubs the chainable mock keeps reaching it.
   */
  const handle = new Proxy(
    {},
    {
      get(_target, property) {
        const current: object = ref.current
          ? (ref.current.handle as object)
          : mock;
        const value = Reflect.get(current, property) as unknown;
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(current)
          : value;
      },
      has(_target, property) {
        const current: object = ref.current
          ? (ref.current.handle as object)
          : mock;
        return Reflect.has(current, property);
      },
    },
  );

  // Auth mock
  const authMock = {
    api: {
      getSession: vi.fn(),
      createUser: vi.fn(),
      signInEmail: vi.fn(),
    },
    $Infer: {
      Session: {
        user: {} as unknown,
        session: {} as unknown,
      },
    },
  };

  return { mockDb: mock, mockAuth: authMock, dbHandle: handle, fakeRef: ref };
});

export { mockDb, mockAuth };

/**
 * Seeds an in-memory fake query executor and installs it as the `db` every
 * module imports, for this test. Unlike the chainable `mockDb` — whose
 * `.where()` throws its argument away — the fake reads the predicate a query
 * builds, so a lookup that dropped its Workspace or Organization column finds
 * the wrong fixture row and the test fails.
 *
 * Rows are keyed by Postgres table name (`seedDb({ workspace: [...] })`), and
 * the returned handle's `tables` are live: assert on them to see what a write
 * did. Call {@link resetMockDb} (usually in `beforeEach`) to uninstall it and
 * return to the chainable mock.
 */
export const seedDb = (
  rows: Store = {},
  options: FakeDbOptions = {},
): FakeDb => {
  const fake = createFakeDb(rows, options);
  fakeRef.current = fake;
  return fake;
};

/**
 * Resets the shared `mockDb` to fresh chainable mocks, clearing stubbed state —
 * and uninstalls any {@link seedDb} fake, so a file mixing the two starts each
 * test on the chainable mock.
 */
export const resetMockDb = () => {
  fakeRef.current = null;
  installBuilderMethods(mockDb);
};

// Mock the database module
vi.mock("./index.ts", () => ({
  db: dbHandle,
}));

/**
 * Mock drizzle-orm.
 *
 * Each operator is a spy — tests assert on what a query asked for — wrapping
 * the introspectable marker from `fake-db.ts`, so the condition a route builds
 * survives to `.where()` and a {@link seedDb} fake can evaluate it. The
 * chainable `mockDb` still ignores the argument, so a test file that stubs
 * queries positionally behaves exactly as before.
 */
vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  // Dynamic so this factory, which runs before the module body, does not depend
  // on test-utils' own imports having been evaluated. `fake-db.ts` imports
  // nothing from `drizzle-orm`, so there is no cycle back into this mock.
  const { markerOperators, orderOperators, sqlMarker } =
    await import("./fake-db.ts");
  const markers = markerOperators();
  const order = orderOperators();
  const sqlMock = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
      sqlMarker(strings, values),
    ),
    {
      raw: vi.fn((query: string) => ({ getSQL: () => ({ query }) })),
    },
  );
  return {
    ...actual,
    eq: vi.fn(markers.eq),
    and: vi.fn(markers.and),
    or: vi.fn(markers.or),
    inArray: vi.fn(markers.inArray),
    notInArray: vi.fn(markers.notInArray),
    ne: vi.fn(markers.ne),
    gt: vi.fn(markers.gt),
    lt: vi.fn(markers.lt),
    lte: vi.fn(markers.lte),
    asc: vi.fn(order.asc),
    count: vi.fn(markers.count),
    max: vi.fn(markers.max),
    desc: vi.fn(order.desc),
    isNull: vi.fn(markers.isNull),
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

/**
 * Helper to mock `auth.api.createUser` — the administrative create-user call
 * the invitation-link registration route uses (see `invitation-link.ts`).
 */
export const mockCreateUser = (user: unknown) => {
  mockAuth.api.createUser.mockResolvedValue({ user });
};

/** Helper to mock `auth.api.createUser` rejecting because the email already has an account. */
export const mockCreateUserAlreadyExists = () => {
  mockAuth.api.createUser.mockRejectedValue(
    Object.assign(new Error("User already exists. Use another email."), {
      status: "BAD_REQUEST",
      body: {
        code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
        message: "User already exists. Use another email.",
      },
    }),
  );
};

/**
 * Helper to mock `auth.api.signInEmail({ asResponse: true })` — the shape the
 * invitation-link registration route reads to relay the fresh session cookie.
 */
export const mockSignInEmail = (
  cookies: string[] = ["better-auth.session_token=tok; Path=/"],
) => {
  mockAuth.api.signInEmail.mockResolvedValue({
    headers: { getSetCookie: () => cookies },
  });
};

/**
 * A {@link setLoadedPlugins} argument for tests. The loader hands the registry
 * both the loaded plugins and the id → plugin-name maps it built while
 * registering; a test states only the owner maps for the point it exercises and
 * gets empty ones for the rest.
 */
export const loadedPluginsFixture = (
  plugins: LoadedPlugin[] = [],
  owners: Partial<ContributionOwners> = {},
): LoadPluginsResult => ({
  plugins,
  owners: {
    toolSets: new Map(),
    sandboxBackends: new Map(),
    webBackends: new Map(),
    ...owners,
  },
});

/**
 * One level of a spy-backed {@link PluginLogger}. Typed to accept either call
 * shape the contract declares — `(fields, msg)` and `(msg)` — because a spy
 * typed to only the first is not assignable to the overloaded member and every
 * call site would need a cast.
 */
type PluginLoggerSpy = Mock<(objOrMsg: object | string, msg?: string) => void>;

/**
 * A spy-backed {@link PluginLogger}: the seam core injects on a plugin's
 * deploy-time block (ADR-0013). Tests for a built-in plugin assert on this
 * rather than on core's logger, which the plugin no longer writes to.
 */
export interface FakePluginLogger extends PluginLogger {
  debug: PluginLoggerSpy;
  info: PluginLoggerSpy;
  warn: PluginLoggerSpy;
  error: PluginLoggerSpy;
}

export const makeFakePluginLogger = (): FakePluginLogger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

/**
 * A plugin's deploy-time block, as core resolves it once per plugin and hands to
 * every one of that plugin's contribution factories (ADR-0013).
 *
 * Required on all three factories as of API v2, so a test that composes a
 * contribution supplies one rather than omitting it. `config` and `credentials`
 * default to `undefined` — what a manifest declaring no schema resolves to — and
 * the logger is a spy, so a test can assert on what the contribution wrote.
 */
export const makePluginContext = (
  over: Partial<PluginConfigContext> = {},
): PluginConfigContext => ({
  config: undefined,
  credentials: undefined,
  logger: makeFakePluginLogger(),
  ...over,
});

/**
 * A `card.*` event with its declared payload. The Card record is the stored row
 * spread whole, so a test that cares about one field supplies that field and
 * takes the rest as given.
 */
export const cardEvent = <
  E extends "card.created" | "card.updated" | "card.moved",
>(
  event: E,
  over: Partial<WebhookEventData<E>> = {},
): WebhookEventPayload =>
  ({
    event,
    data: {
      id: "c1",
      boardId: "board-1",
      columnId: "col-1",
      title: "A card",
      body: null,
      labelIds: [],
      assignees: [],
      dueDate: null,
      priority: "none",
      position: 1024,
      createdByUserId: "user-1",
      createdByAgentId: null,
      lastEditedByUserId: null,
      lastEditedByAgentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...(event === "card.updated" ? { changedFields: [] } : {}),
      ...(event === "card.moved" ? { previousColumnId: "col-0" } : {}),
      ...over,
    },
  }) as WebhookEventPayload;

/** A `notification.created`/`notification.updated` event and its record. */
export const notificationEvent = (
  event: "notification.created" | "notification.updated",
  over: Partial<WebhookEventData<"notification.created">> = {},
): WebhookEventPayload => ({
  event,
  data: {
    id: "n-1",
    workspaceId: "ws-1",
    agentId: "agent-1",
    title: null,
    body: "Something happened",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  },
});
