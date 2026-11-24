import { describe, it, expect, beforeAll } from "vitest";
import type { ToolSetContext } from "@platypuschat/plugin-sdk";
import {
  CLEARABLE_TOOL_INPUT_FIELDS,
  DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
} from "@platypus/schemas";
import { isClearableToolName } from "./tool-result-clearing.ts";
import { createSandboxTools } from "../sandbox/tools.ts";
import type { SandboxBackend, SandboxContext } from "../sandbox/types.ts";
import { loadPlugins } from "../plugins/loader.ts";
import { ALWAYS_ON_PLUGINS, BUILTIN_PLUGINS } from "../plugins/builtin.ts";
import { MEMORY_TOOLSET_ID, type ToolSetRegistration } from "../tools/index.ts";
import type { WebBackendRegistration } from "../web-backends/index.ts";
import {
  DELEGATE_TOOL_NAME,
  SKILL_TOOL_NAMES,
  WEB_BACKEND_TOOL_NAMES,
} from "../tools/turn-tool-names.ts";
import { MEMORY_TOOL_NAMES } from "../tools/memory.ts";

// why: derived from BUILTIN_PLUGINS so a new core plugin's tools are audited without a hand list
const GATED_CORE_PLUGIN_NAMES = Object.keys(BUILTIN_PLUGINS).filter(
  (name) => !ALWAYS_ON_PLUGINS.includes(name),
);

// why: these plugins' schemas require credentials, but materialising their tool sets needs no live row
const PLUGIN_FIXTURES: Record<string, string> = {
  PLATYPUS_PLUGIN_CONFIG_EXA: JSON.stringify({
    credentials: { apiKey: "fixture" },
  }),
  PLATYPUS_PLUGIN_CONFIG_DAYTONA: JSON.stringify({
    credentials: { apiKey: "fixture" },
  }),
  PLATYPUS_PLUGIN_CONFIG_DECISION_GATE: JSON.stringify({
    config: { denyThreshold: 0.5 },
    credentials: { apiKey: "fixture" },
  }),
};

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

const sandboxToolNames = (): string[] => {
  const stubBackend = { fsReadBytes: () => {} } as unknown as SandboxBackend;
  const stubCtx = {} as unknown as SandboxContext;
  return Object.keys(
    createSandboxTools(stubBackend, stubCtx, {}, () =>
      Promise.resolve({
        passthroughFileTypes: [],
        maxExtractedTextChars: DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
      }),
    ),
  );
};

let materializedNames: string[] = [];
const failedFactories: string[] = [];

beforeAll(async () => {
  // why: a local registry plus fixtures replace global db mocks; memory needs a live row so its static names are read instead
  const registrations: ToolSetRegistration[] = [];
  const webBackends: WebBackendRegistration[] = [];
  await loadPlugins({
    pluginNames: GATED_CORE_PLUGIN_NAMES,
    alwaysOnPlugins: ALWAYS_ON_PLUGINS,
    register: (_id, registration) => {
      registrations.push(registration);
    },
    registerSandbox: () => {},
    registerWeb: (registration) => {
      webBackends.push(registration);
    },
    registerGate: () => {},
    env: PLUGIN_FIXTURES,
  });

  const names = new Set<string>(sandboxToolNames());

  for (const registration of registrations) {
    if (registration.id === MEMORY_TOOLSET_ID) continue;
    const tools = await registration.buildTurnTools(
      STUB_CONTEXT,
      undefined,
      () => {
        failedFactories.push(registration.id);
      },
    );
    Object.keys(tools).forEach((name) => names.add(name));
  }

  if (webBackends.length > 0) {
    for (const name of WEB_BACKEND_TOOL_NAMES) names.add(name);
  }
  if (registrations.some(({ id }) => id === MEMORY_TOOLSET_ID)) {
    for (const name of MEMORY_TOOL_NAMES) names.add(name);
  }
  for (const name of SKILL_TOOL_NAMES) names.add(name);
  names.add(DELEGATE_TOOL_NAME);

  materializedNames = [...names];
});

// why: keys are the wire names on purpose — reading them from constants would let a constant rename pass unclassified
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
  it("materialises every tool set it audits", () => {
    expect(failedFactories).toEqual([]);
  });

  it("classifies exactly the core tool names the currently-registered plugins produce", () => {
    const unclassified = materializedNames.filter(
      (name) => !(name in EXPECTED_CLEARABLE),
    );
    const unseen = Object.keys(EXPECTED_CLEARABLE).filter(
      (name) => !materializedNames.includes(name),
    );

    expect(
      { unclassified, unseen },
      `Unclassified core tool name(s): ${unclassified.join(", ") || "none"}. ` +
        `Decide whether each is clearable (large, disposable, read-only) and add it ` +
        `to EXPECTED_CLEARABLE in this test, and to CLEARABLE_TOOL_NAMES in ` +
        `@platypus/schemas if it should be clearable. ` +
        `Classified core tool name(s) no longer produced: ${unseen.join(", ") || "none"}. ` +
        `A rename must update both the Tool's name and its entry in EXPECTED_CLEARABLE.`,
    ).toEqual({ unclassified: [], unseen: [] });
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
