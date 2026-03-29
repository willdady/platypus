import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

// Mock ai module
const mockGenerateText = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: any[]) => mockGenerateText(...args),
  stepCountIs: vi.fn(() => ({})),
}));

// Mock nanoid
vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "test-id-123"),
}));

// Mock chat-execution
const mockLoadTools = vi.fn();
const mockLoadSkills = vi.fn();
const mockFetchUserContexts = vi.fn();
const mockFetchFormattedMemories = vi.fn();
const mockResolveGenerationConfig = vi.fn();
const mockPrepareAgentTools = vi.fn();
vi.mock("./chat-execution.ts", () => ({
  createModel: vi.fn(() => [{}, "mock-model"]),
  loadTools: (...args: any[]) => mockLoadTools(...args),
  loadSkills: (...args: any[]) => mockLoadSkills(...args),
  fetchUserContexts: (...args: any[]) => mockFetchUserContexts(...args),
  fetchFormattedMemories: (...args: any[]) =>
    mockFetchFormattedMemories(...args),
  resolveGenerationConfig: (...args: any[]) =>
    mockResolveGenerationConfig(...args),
  prepareAgentTools: (...args: any[]) => mockPrepareAgentTools(...args),
}));

// Mock cron
vi.mock("../utils/cron.ts", () => ({
  validateCronExpression: vi.fn(
    () => new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
  ),
}));

import {
  triggerSchedule,
  updateScheduleAfterRun,
} from "./schedule-execution.ts";

const makeSchedule = (overrides: Partial<any> = {}) => ({
  id: "sched-1",
  workspaceId: "ws-1",
  agentId: "agent-1",
  instruction: "Run daily report",
  name: "Daily Report",
  cronExpression: "0 9 * * *",
  timezone: "UTC",
  maxChatsToKeep: 10,
  isOneOff: false,
  enabled: true,
  ...overrides,
});

const makeAgent = (overrides: Partial<any> = {}) => ({
  id: "agent-1",
  providerId: "provider-1",
  modelId: "gpt-4",
  maxSteps: 5,
  systemPrompt: "You are helpful",
  ...overrides,
});

const makeWorkspace = (overrides: Partial<any> = {}) => ({
  id: "ws-1",
  ownerId: "user-1",
  context: "Workspace context",
  ...overrides,
});

const makeProvider = (overrides: Partial<any> = {}) => ({
  id: "provider-1",
  providerType: "OpenAI",
  ...overrides,
});

describe("triggerSchedule", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);

    mockLoadTools.mockResolvedValue({ tools: {}, mcpClients: [] });
    mockLoadSkills.mockResolvedValue([]);
    mockFetchUserContexts.mockResolvedValue({});
    mockFetchFormattedMemories.mockResolvedValue(undefined);
    mockResolveGenerationConfig.mockResolvedValue({
      systemPrompt: "Test prompt",
    });
    mockPrepareAgentTools.mockImplementation(() => {});
  });

  it("creates run record and executes successfully", async () => {
    // Agent lookup
    mockDb.limit.mockResolvedValueOnce([makeAgent()]);
    // Workspace lookup
    mockDb.limit.mockResolvedValueOnce([makeWorkspace()]);
    // Provider lookup
    mockDb.limit.mockResolvedValueOnce([makeProvider()]);

    mockGenerateText.mockResolvedValueOnce({ text: "Report generated" });

    const chatId = await triggerSchedule(makeSchedule());

    expect(chatId).toBe("test-id-123");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    // Chat was inserted
    expect(mockDb.values).toHaveBeenCalled();
  });

  it("fails when agent not found", async () => {
    // Agent lookup returns empty
    mockDb.limit.mockResolvedValueOnce([]);

    await expect(triggerSchedule(makeSchedule())).rejects.toThrow(
      "Agent 'agent-1' not found",
    );
  });

  it("fails when workspace not found", async () => {
    // Agent found
    mockDb.limit.mockResolvedValueOnce([makeAgent()]);
    // Workspace not found
    mockDb.limit.mockResolvedValueOnce([]);

    await expect(triggerSchedule(makeSchedule())).rejects.toThrow(
      "Workspace 'ws-1' not found",
    );
  });

  it("fails when provider not found", async () => {
    // Agent found
    mockDb.limit.mockResolvedValueOnce([makeAgent()]);
    // Workspace found
    mockDb.limit.mockResolvedValueOnce([makeWorkspace()]);
    // Provider not found
    mockDb.limit.mockResolvedValueOnce([]);

    await expect(triggerSchedule(makeSchedule())).rejects.toThrow(
      "Provider 'provider-1' not found",
    );
  });

  it("handles generateText error and closes MCP clients", async () => {
    const mockClose = vi.fn();
    mockLoadTools.mockResolvedValue({
      tools: {},
      mcpClients: [{ close: mockClose }],
    });

    // Agent, workspace, provider found
    mockDb.limit.mockResolvedValueOnce([makeAgent()]);
    mockDb.limit.mockResolvedValueOnce([makeWorkspace()]);
    mockDb.limit.mockResolvedValueOnce([makeProvider()]);

    mockGenerateText.mockRejectedValueOnce(new Error("Model error"));

    await expect(triggerSchedule(makeSchedule())).rejects.toThrow(
      "Model error",
    );

    // MCP clients should be closed in finally block
    expect(mockClose).toHaveBeenCalled();
  });
});

describe("updateScheduleAfterRun", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  it("disables one-off schedules after run", async () => {
    await updateScheduleAfterRun("sched-1", 10, true, "0 9 * * *", "UTC");

    // set() was called with enabled: false
    expect(mockDb.set).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("computes next run for recurring schedules", async () => {
    await updateScheduleAfterRun("sched-1", 10, false, "0 9 * * *", "UTC");

    // set() was called with enabled: true and nextRunAt set
    expect(mockDb.set).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        nextRunAt: expect.any(Date),
      }),
    );
  });

  it("performs retention cleanup when maxChatsToKeep > 0", async () => {
    // Chats to keep
    const chatsToKeep = Array.from({ length: 10 }, (_, i) => ({
      id: `chat-${i}`,
    }));
    mockDb.limit.mockResolvedValueOnce(chatsToKeep);
    // Deleted chats
    mockDb.returning.mockResolvedValueOnce([{ id: "old-chat" }]);

    // Runs to keep
    const runsToKeep = Array.from({ length: 10 }, (_, i) => ({
      id: `run-${i}`,
    }));
    mockDb.limit.mockResolvedValueOnce(runsToKeep);
    // Deleted runs
    mockDb.returning.mockResolvedValueOnce([{ id: "old-run" }]);

    await updateScheduleAfterRun("sched-1", 10, false, "0 9 * * *", "UTC");

    // delete() was called for cleanup
    expect(mockDb.delete).toHaveBeenCalled();
  });
});
