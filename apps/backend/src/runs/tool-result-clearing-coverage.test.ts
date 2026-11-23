import { describe, it, expect, beforeAll, vi } from "vitest";
import type { ToolSetContext } from "@platypuschat/plugin-sdk";
import {
  CLEARABLE_TOOL_INPUT_FIELDS,
  DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
} from "@platypus/schemas";
import { isClearableToolName } from "./tool-result-clearing.ts";
import { createWebFetchTools } from "../tools/fetch.ts";
import { createSandboxTools } from "../sandbox/tools.ts";
import { createLoadSkillTool } from "../tools/skill.ts";
import { DELEGATE_TOOL_NAME } from "../tools/turn-tool-names.ts";
import type { SandboxBackend, SandboxContext } from "../sandbox/types.ts";

vi.mock("../index.ts", () => {
  const query = {
    from: () => query,
    where: () => query,
    limit: () => Promise.resolve([]),
  };
  return { db: { select: () => query } };
});
vi.mock("../services/event-dispatch.ts", () => ({ dispatchEvent: vi.fn() }));
vi.mock("../services/sub-agent-validation.ts", () => ({
  validateSubAgentAssignment: vi.fn(),
}));
vi.mock("../storage/index.ts", () => ({ getStorage: vi.fn() }));

import { loadPlugins } from "../plugins/loader.ts";
import { ALWAYS_ON_PLUGINS } from "../plugins/builtin.ts";
import { getToolSets, SANDBOX_TOOLSET_ID } from "../tools/index.ts";

const CORE_PLUGIN_NAMES = ["@platypus/web-fetch"];

const STUB_CONTEXT: ToolSetContext = {
  workspaceId: "ws-1",
  agentId: "agent-1",
  orgId: "org-1",
  frontendUrl: "http://localhost:3000",
  userId: "user-1",
  timezone: "UTC",
  sessionId: "chat-1",
  registerCloser: () => {},
};

let materializedNames: string[] = [];

beforeAll(async () => {
  await loadPlugins({
    pluginNames: CORE_PLUGIN_NAMES,
    alwaysOnPlugins: ALWAYS_ON_PLUGINS,
  });

  const names = new Set<string>();

  for (const registration of getToolSets()) {
    if (registration.id === SANDBOX_TOOLSET_ID) continue;
    const tools = await registration.buildTurnTools(
      STUB_CONTEXT,
      undefined,
      () => {},
    );
    Object.keys(tools).forEach((n) => names.add(n));
  }

  const stubBackend = { fsReadBytes: () => {} } as unknown as SandboxBackend;
  const stubCtx = {} as unknown as SandboxContext;
  Object.keys(
    createSandboxTools(stubBackend, stubCtx, {}, () =>
      Promise.resolve({
        passthroughFileTypes: [],
        maxExtractedTextChars: DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
      }),
    ),
  ).forEach((n) => names.add(n));

  void createWebFetchTools;

  void createLoadSkillTool;
  names.add("loadSkill");
  names.add("readSkillFile");

  names.add(DELEGATE_TOOL_NAME);

  names.add("web_search");
  names.add("read_url");

  names.add("memorySearch");

  materializedNames = [...names];
});

const EXPECTED_CLEARABLE: Record<string, boolean> = {
  web_search: true,
  read_url: true,
  fetchUrl: true,
  fsRead: true,
  fsList: true,
  fsView: true,
  listChats: true,
  readTranscript: true,

  fsDownload: false,

  fsWrite: false,
  fsEdit: false,
  shellExec: false,

  convertTemperature: false,
  convertDistance: false,
  convertWeight: false,
  convertVolume: false,
  getCurrentTime: false,
  convertTimezone: false,
  generateUuid: false,
  generateNanoId: false,

  listBoards: false,
  getBoardState: false,
  moveCard: false,
  deleteCard: false,
  listTriggers: false,
  getTrigger: false,
  deleteTrigger: false,
  getCard: false,
  createCard: false,
  updateCard: false,
  copyCard: false,
  bulkEditCards: false,
  listComments: false,
  createComment: false,
  updateComment: false,
  deleteComment: false,
  createBoard: false,
  updateBoard: false,
  deleteBoard: false,
  createColumn: false,
  updateColumn: false,
  deleteColumn: false,
  reorderColumns: false,
  createTrigger: false,
  updateTrigger: false,
  listAgents: false,
  getAgent: false,
  listModelProviders: false,
  listToolSets: false,
  listSkills: false,
  getSkill: false,
  upsertSkill: false,
  deleteSkill: false,
  createAgent: false,
  updateAgent: false,
  deleteAgent: false,
  createNotification: false,
  listNotifications: false,
  updateNotification: false,
  deleteNotification: false,
  memorySearch: false,
  memoryGet: false,
  createArtifact: false,
  updateArtifact: false,
  readArtifact: true,
  listArtifacts: false,

  loadSkill: false,
  readSkillFile: true,

  delegate: false,
};

describe("Tool-result clearing — core tool inventory", () => {
  it("classifies every core tool name the currently-registered plugins produce", () => {
    const unclassified = materializedNames.filter(
      (name) => !(name in EXPECTED_CLEARABLE),
    );

    expect(
      unclassified,
      `Unclassified core tool name(s): ${unclassified.join(", ")}. ` +
        `Decide whether each is clearable (large, disposable, read-only) and add it ` +
        `to EXPECTED_CLEARABLE in this test, and to CLEARABLE_TOOL_NAMES in ` +
        `@platypus/schemas if it should be clearable.`,
    ).toEqual([]);
  });

  it("agrees with isClearableToolName on every classified name", () => {
    for (const [name, expected] of Object.entries(EXPECTED_CLEARABLE)) {
      expect(isClearableToolName(name), name).toBe(expected);
    }
  });

  it("names only real core tools in the Tool-input clearing allowlist", () => {
    for (const name of CLEARABLE_TOOL_INPUT_FIELDS.keys()) {
      expect(materializedNames, name).toContain(name);
    }
  });

  it("denies the pre-dispatcher sub-Agent tool names still held in stored history", () => {
    expect(isClearableToolName("delegateToResearchAgent")).toBe(false);
    expect(isClearableToolName("delegateToBillingHelper")).toBe(false);
  });
});
