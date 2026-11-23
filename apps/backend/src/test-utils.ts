import { afterEach, beforeEach, vi, type Mock } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getStorage, resetStorage } from "./storage/index.ts";

export type { FakeDb, Row, Store } from "./fake-db.ts";
export { dbError } from "./fake-db.ts";
export {
  asDb,
  createMockDb,
  mockAuth,
  mockCreateUser,
  mockCreateUserAlreadyExists,
  mockDb,
  mockNoSession,
  mockSession,
  mockSignInEmail,
  resetMockDb,
  seedDb,
  type MockDb,
} from "./test-mocks.ts";
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

export const insertTimestamps = () => ({
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

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
