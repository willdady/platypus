import { describe, it, expect, beforeAll, vi } from "vitest";
import type { ToolSetContext } from "@platypuschat/plugin-sdk";
import { isClearableToolName } from "./tool-result-clearing.ts";
import { createWebFetchTools } from "../tools/fetch.ts";
import { createSandboxTools } from "../sandbox/tools.ts";
import { createLoadSkillTool } from "../tools/skill.ts";
import { DELEGATE_TOOL_NAME } from "../tools/sub-agent.ts";
import type { SandboxBackend, SandboxContext } from "../sandbox/types.ts";

// Every core plugin the domain Tool sets transitively import the db and a few
// services; mock them the same way `tools-platform/index.test.ts` does, so
// loading the real plugins here needs no live Postgres. Factories return AI
// SDK tool maps without touching the db until a tool's `execute` runs.
vi.mock("../index.ts", () => ({ db: {} }));
vi.mock("../logger.ts", () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => child),
    },
  };
});
vi.mock("../services/event-dispatch.ts", () => ({ dispatchEvent: vi.fn() }));
vi.mock("../services/sub-agent-validation.ts", () => ({
  validateSubAgentAssignment: vi.fn(),
}));
vi.mock("../storage/index.ts", () => ({ getStorage: vi.fn() }));

import { loadPlugins } from "../plugins/loader.ts";
import { ALWAYS_ON_PLUGINS } from "../plugins/builtin.ts";
import { getToolSets, SANDBOX_TOOLSET_ID } from "../tools/index.ts";

/**
 * Tool-result clearing is deny-by-default (`CLEARABLE_TOOL_NAMES`, deliberately
 * a short allowlist). This test is the other half of that: it enumerates every
 * name the core plugins actually produce and asserts each has an intended
 * classification, so a newly added tool — in an existing core Tool set, or a
 * wholly new one — fails loudly here rather than silently defaulting to "not
 * clearable" (safe) or, worse, someone widening the allowlist without
 * thinking it through.
 *
 * Structurally exhaustive over the plugin registry: this loads the real core
 * plugins (`ALWAYS_ON_PLUGINS` — currently `@platypus/tools-basic` and
 * `@platypus/tools-platform` — plus the gated `@platypus/web-fetch`) through
 * the real loader, then reads every registered Tool set's ACTUAL
 * `buildTurnTools` output via `getToolSets()`, rather than hand-calling each
 * factory. A brand-new core Tool set that registers itself is picked up
 * automatically; the only thing this list must be kept in sync with by hand
 * is which plugin NAMES are core (mirroring `BUILTIN_PLUGINS` in
 * `plugins/builtin.ts`) — a new *gated* (non-always-on) core plugin needs its
 * name added to `CORE_PLUGIN_NAMES` below, the same way it would need adding
 * to an Operator's `PLATYPUS_PLUGINS` to run at all.
 *
 * Two exceptions, both documented at their `names.add(...)` call below:
 * `sandbox` resolves through a real Sandbox row at Chat-turn time, so its
 * registry-driven `buildTurnTools` degrades to `{}` under these DB mocks
 * (`composeToolSet`'s own try/catch) — its real tool names are read instead
 * by calling `createSandboxTools` directly with a stub backend, which needs
 * no database. `web_search` / `read_url` are built from a live Web-search
 * backend's executors inside `web-backends/index.ts` and can't be
 * materialized without one, so they are asserted by their known, grep-stable
 * literal names.
 *
 * Scope: core plugins only, matching the allowlist's own scope — an MCP or
 * third-party plugin tool is deny-by-default here too, unless its MCP
 * declared `readOnlyHint` (ADR-0021, issue #626), which this inventory does
 * not exercise: that resolver lives on the Tool session, not in
 * `isClearableToolName`'s own default. Sub-Agent delegation is one fixed tool
 * name, `delegate`, assigned ad hoc in `chat-execution.ts` like `loadSkill` —
 * the `delegateTo*` names it replaced live on only in stored Chat history.
 */

const CORE_PLUGIN_NAMES = ["@platypus/web-fetch"];

const STUB_CONTEXT: ToolSetContext = {
  workspaceId: "ws-1",
  agentId: "agent-1",
  orgId: "org-1",
  frontendUrl: "http://localhost:3000",
  userId: "user-1",
};

let materializedNames: string[] = [];

beforeAll(async () => {
  await loadPlugins({
    pluginNames: CORE_PLUGIN_NAMES,
    alwaysOnPlugins: ALWAYS_ON_PLUGINS,
  });

  const names = new Set<string>();

  for (const registration of getToolSets()) {
    // `sandbox` needs a live Sandbox row to resolve; see the doc comment
    // above. Its real names are added separately below.
    if (registration.id === SANDBOX_TOOLSET_ID) continue;
    const tools = await registration.buildTurnTools(STUB_CONTEXT);
    Object.keys(tools).forEach((n) => names.add(n));
  }

  // `sandbox`: the five tools are static per backend, not data-dependent, so a
  // stub backend/ctx (no DB) still yields the real names.
  const stubBackend = {} as unknown as SandboxBackend;
  const stubCtx = {} as unknown as SandboxContext;
  Object.keys(createSandboxTools(stubBackend, stubCtx)).forEach((n) =>
    names.add(n),
  );

  // `@platypus/web-fetch` also registers through `getToolSets()` above (it's
  // in `CORE_PLUGIN_NAMES`), so no separate call is needed here — kept as
  // documentation of where `fetchUrl` actually comes from.
  void createWebFetchTools;

  // Ad hoc: skill loading is assigned directly in `chat-execution.ts`, never
  // through the Tool-set registry.
  void createLoadSkillTool;
  names.add("loadSkill");

  // Ad hoc for the same reason: the one delegation tool is assigned directly
  // in `chat-execution.ts` when at least one sub-agent resolved.
  names.add(DELEGATE_TOOL_NAME);

  // Web-search backend (see doc comment above: can't be materialized here).
  names.add("web_search");
  names.add("read_url");

  materializedNames = [...names];
});

/**
 * Every enumerated name mapped to whether it SHOULD be clearable. Kept next to
 * the allowlist rather than inline in the assertions, so an unclassified name
 * fails with "not in this map" rather than a confusing boolean mismatch.
 */
const EXPECTED_CLEARABLE: Record<string, boolean> = {
  // Clearable: large, disposable, read-only.
  web_search: true,
  read_url: true,
  fetchUrl: true,
  fsRead: true,
  fsList: true,

  // Not clearable: mutating.
  fsWrite: false,
  fsEdit: false,
  shellExec: false,

  // Not clearable: pure utilities, results are tiny.
  convertTemperature: false,
  convertDistance: false,
  convertWeight: false,
  convertVolume: false,
  getCurrentTime: false,
  convertTimezone: false,
  generateUuid: false,
  generateNanoId: false,

  // Not clearable: Platypus-domain tools — mutating, or small/metadata-shaped
  // reads whose value is in staying visible, not in being large.
  listBoards: false,
  getBoardState: false,
  moveCard: false,
  deleteCard: false,
  listDashboards: false,
  listTriggers: false,
  getTrigger: false,
  deleteTrigger: false,
  getCard: false,
  upsertCard: false,
  copyCard: false,
  bulkEditCards: false,
  listComments: false,
  upsertComment: false,
  deleteComment: false,
  listWidgets: false,
  getWidget: false,
  updateWidgetData: false,
  upsertTrigger: false,
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

  // Not clearable: instructions the model is meant to keep following.
  loadSkill: false,

  // Not clearable: a delegation result is the whole of a sub-agent's work, and
  // re-delegating to get it back would re-run the run.
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

  // Stored Chat history keeps the pre-dispatcher names for ever, and a
  // Transcript rebuilt from it is what clearing runs over.
  it("denies the pre-dispatcher sub-Agent tool names still held in stored history", () => {
    expect(isClearableToolName("delegateToResearchAgent")).toBe(false);
    expect(isClearableToolName("delegateToBillingHelper")).toBe(false);
  });
});
