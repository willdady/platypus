import { vi, type Mock } from "vitest";
import {
  createFakeDb,
  type FakeDb,
  type FakeDbOptions,
  type Store,
} from "./fake-db.ts";

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

export const resetMockDb = () => {
  fakeRef.current = null;
  installBuilderMethods(mockDb);
};

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

vi.mock("./index.ts", () => ({
  db: dbHandle,
}));

// why: tests that run real Drizzle against PGlite unmock this module themselves
vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  // why: dynamic: this factory runs before the module's own imports are evaluated
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
