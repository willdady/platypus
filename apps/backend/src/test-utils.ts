import { vi } from "vitest";

// Set environment variables for tests
process.env.ALLOWED_ORIGINS = "http://localhost:3000";
process.env.DATABASE_URL = "postgres://localhost:5432/test";

const { mockDb, mockAuth } = vi.hoisted(() => {
  // Create a mock db object that allows chaining
  const mock: any = {};
  
  const methods = [
    'select', 'from', 'where', 'limit', 'offset', 
    'orderBy', 'innerJoin', 'leftJoin', 'rightJoin',
    'insert', 'values', 'update', 'set', 'delete', 
    'returning', 'execute', 'inArray'
  ];

  methods.forEach(method => {
    mock[method] = vi.fn().mockImplementation(() => mock);
  });

  // Transaction special handling
  mock.transaction = vi.fn((cb) => cb(mock));

  // Auth mock
  const authMock = {
    api: {
      getSession: vi.fn(),
    },
    $Infer: {
      Session: {
        user: {} as any,
        session: {} as any,
      },
    },
  };

  return { mockDb: mock, mockAuth: authMock };
});

export { mockDb, mockAuth };

export const resetMockDb = () => {
  const methods = [
    'select', 'from', 'where', 'limit', 'offset', 
    'orderBy', 'innerJoin', 'leftJoin', 'rightJoin',
    'insert', 'values', 'update', 'set', 'delete', 
    'returning', 'execute', 'inArray'
  ];

  methods.forEach(method => {
    // Re-assign a fresh mock function to ensure no state leaks
    mockDb[method] = vi.fn().mockImplementation(() => mockDb);
  });
  
  mockDb.transaction = vi.fn((cb: any) => cb(mockDb));
};

// Mock the database module
vi.mock("./index.ts", () => ({
  db: mockDb,
}));

// Mock drizzle-orm
vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
    inArray: vi.fn(),
    desc: vi.fn(),
    sql: vi.fn(),
  };
});

// Mock auth
vi.mock("./auth.ts", () => ({
  auth: mockAuth,
}));

import { auth } from "./auth.ts";

/**
 * Helper to mock a successful session
 */
export const mockSession = (user: any = { id: "user-1", email: "test@example.com", role: "user" }) => {
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
