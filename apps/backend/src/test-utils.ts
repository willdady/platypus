import { afterEach, beforeEach, vi, type Mock } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getStorage, resetStorage } from "./storage/index.ts";
import {
  createFakeDb,
  type FakeDb,
  type FakeDbOptions,
  type Store,
} from "./fake-db.ts";

export type { FakeDb, Row, Store } from "./fake-db.ts";
export { dbError } from "./fake-db.ts";
import type {
  PluginConfigContext,
  PluginLogger,
} from "@platypuschat/plugin-sdk";
import type {
  ContributionOwners,
  LoadedPlugin,
  LoadPluginsResult,
} from "./plugins/loader.ts";
import type {
  WebhookEventData,
  EventTriggerEventPayload,
} from "@platypus/schemas";
import type {
  InferToolInput,
  InferToolOutput,
  Tool,
  ToolExecutionOptions,
} from "ai";

const TEST_TOOL_OPTIONS: ToolExecutionOptions<unknown> = {
  toolCallId: "test",
  messages: [],
  context: undefined,
};

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

type BuilderMethodName =
  | "select"
  | "selectDistinctOn"
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

type ChainableMethod = Mock<(...args: unknown[]) => MockDb>;

export type MockDb = PromiseLike<unknown> & {
  [K in BuilderMethodName]: ChainableMethod;
} & {
  transaction: Mock<(cb: (tx: MockDb) => unknown) => unknown>;
};

// why: a hoisted declaration, so the vi.hoisted block can call it before the module body runs
function installBuilderMethods(target: MockDb): void {
  const methods: readonly BuilderMethodName[] = [
    "select",
    "selectDistinctOn",
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

export function asDb<T>(db: MockDb): T {
  return db as unknown as T;
}

export function createMockDb(): MockDb {
  const mock = {} as MockDb;
  installBuilderMethods(mock);
  return mock;
}

const { mockDb, mockAuth, dbHandle, fakeRef } = vi.hoisted(() => {
  const mock = createMockDb();

  const ref: { current: { handle: unknown } | null } = { current: null };

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

export const seedDb = (
  rows: Store = {},
  options: FakeDbOptions = {},
): FakeDb => {
  const fake = createFakeDb(rows, options);
  fakeRef.current = fake;
  return fake;
};

export const insertTimestamps = () => ({
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

export const resetMockDb = () => {
  fakeRef.current = null;
  installBuilderMethods(mockDb);
};

vi.mock("./index.ts", () => ({
  db: dbHandle,
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  // why: dynamic: this factory runs before test-utils' own imports are evaluated
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
    gte: vi.fn(markers.gte),
    lt: vi.fn(markers.lt),
    lte: vi.fn(markers.lte),
    asc: vi.fn(order.asc),
    count: vi.fn(markers.count),
    max: vi.fn(markers.max),
    desc: vi.fn(order.desc),
    isNull: vi.fn(markers.isNull),
    isNotNull: vi.fn(markers.isNotNull),
    sql: sqlMock,
  };
});

vi.mock("./auth.ts", () => ({
  auth: mockAuth,
}));

export const mockSession = (
  user: unknown = { id: "user-1", email: "test@example.com", role: "user" },
) => {
  mockAuth.api.getSession.mockResolvedValue({
    user,
    session: { id: "session-1" },
  });
};

export const mockNoSession = () => {
  mockAuth.api.getSession.mockResolvedValue(null);
};

export const mockCreateUser = (user: unknown) => {
  mockAuth.api.createUser.mockResolvedValue({ user });
};

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

export const mockSignInEmail = (
  cookies: string[] = ["better-auth.session_token=tok; Path=/"],
) => {
  mockAuth.api.signInEmail.mockResolvedValue({
    headers: { getSetCookie: () => cookies },
  });
};

export const loadedPluginsFixture = (
  plugins: LoadedPlugin[] = [],
  owners: Partial<ContributionOwners> = {},
): LoadPluginsResult => ({
  plugins,
  owners: {
    toolSets: new Map(),
    sandboxBackends: new Map(),
    webBackends: new Map(),
    toolGates: new Map(),
    ...owners,
  },
});

type PluginLoggerSpy = Mock<(objOrMsg: object | string, msg?: string) => void>;

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

export const makePluginContext = <TConfig = unknown, TCredentials = unknown>(
  over: Partial<PluginConfigContext<TConfig, TCredentials>> = {},
): PluginConfigContext<TConfig, TCredentials> => ({
  config: undefined as TConfig,
  credentials: undefined as TCredentials,
  logger: makeFakePluginLogger(),
  ...over,
});

export const cardEvent = <
  E extends "card.created" | "card.updated" | "card.moved",
>(
  event: E,
  over: Partial<WebhookEventData<E>> = {},
): EventTriggerEventPayload =>
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
  }) as EventTriggerEventPayload;

export const notificationEvent = (
  event: "notification.created" | "notification.updated",
  over: Partial<WebhookEventData<"notification.created">> = {},
): EventTriggerEventPayload => ({
  event,
  data: {
    id: "n-1",
    workspaceId: "ws-1",
    agentId: "agent-1",
    title: null,
    body: "Something happened",
    source: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  },
});

export const useTempDiskStorage = () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "platypus-storage-test-"));
    process.env.STORAGE_DISK_PATH = dir;
    resetStorage();
  });
  afterEach(async () => {
    delete process.env.STORAGE_DISK_PATH;
    resetStorage();
    await fs.rm(dir, { recursive: true, force: true });
  });
};

export const putStoredFiles = (keys: string[]) =>
  Promise.all(
    keys.map((key) => getStorage().put(key, Buffer.from(key), "image/png")),
  );

export const isStored = async (key: string) =>
  (await getStorage().get(key)) !== null;
