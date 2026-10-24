import { describe, it, expect } from "vitest";
import type { Experimental_DecisionModel } from "ai";
import type { ToolGateCall } from "@platypuschat/plugin-sdk";
import { plugin, judgeToolCall, type DecisionGateConfig } from "./index.ts";
import { loadPlugins } from "../loader.ts";
import { ALWAYS_ON_PLUGINS, BUILTIN_PLUGINS } from "../builtin.ts";
import type { ToolGateRegistration } from "../../tool-gates/index.ts";

const call: ToolGateCall = {
  toolName: "shellExec",
  toolDescription: "Run a shell command.",
  args: { command: "rm -rf /data" },
  orgId: "o",
  workspaceId: "w",
  attended: false,
  readOnlyHint: "undeclared",
};

/** A decision model that answers `probability` and records what it was asked. */
const stubModel = (probability: number) => {
  const asked: unknown[] = [];
  const model = {
    specificationVersion: "v4",
    provider: "stub",
    modelId: "stub",
    supportedQuestionTypes: ["boolean"],
    doDecide: (options: unknown) => {
      asked.push(options);
      return Promise.resolve({
        answers: { destructive: { type: "boolean", probability } },
        warnings: [],
      });
    },
  } as unknown as Experimental_DecisionModel;
  return { model, asked };
};

const thresholds = (
  denyThreshold: number,
  askThreshold?: number,
): DecisionGateConfig => ({
  provider: "gateway",
  denyThreshold,
  ...(askThreshold !== undefined ? { askThreshold } : {}),
});

const signal = new AbortController().signal;

describe("@platypus/decision-gate", () => {
  it.each([
    [0.95, "deny"],
    [0.9, "deny"],
    [0.7, "ask"],
    [0.5, "ask"],
    [0.49, "allow"],
  ] as const)(
    "maps a probability of %s to %s with both thresholds",
    async (probability, verdict) => {
      const result = await judgeToolCall(
        stubModel(probability).model,
        call,
        thresholds(0.9, 0.5),
        signal,
      );
      expect(result.verdict).toBe(verdict);
    },
  );

  it("has no ask band without an ask threshold", async () => {
    const result = await judgeToolCall(
      stubModel(0.89).model,
      call,
      thresholds(0.9),
      signal,
    );
    expect(result.verdict).toBe("allow");
  });

  it("gives the probability as its reason", async () => {
    const result = await judgeToolCall(
      stubModel(0.93).model,
      call,
      thresholds(0.9),
      signal,
    );
    expect(result.reason).toContain("0.93");
  });

  it("asks the model about the call alone", async () => {
    const { model, asked } = stubModel(0);
    await judgeToolCall(model, call, thresholds(0.9), signal);

    expect(JSON.stringify(asked[0])).toContain("rm -rf /data");
    expect(JSON.stringify(asked[0])).toContain("shellExec");
  });

  it.each([
    [{ provider: "openai", denyThreshold: 0.9 }, "a model id off the gateway"],
    [{ denyThreshold: 1.5 }, "a threshold above 1"],
    [{ denyThreshold: 0.5, askThreshold: 0.6 }, "an ask above the deny"],
  ] as Array<[unknown, string]>)("refuses config with %s (%s)", (config) => {
    expect(plugin.configSchema?.safeParse(config).success).toBe(false);
  });

  it("defaults to the gateway", () => {
    expect(plugin.configSchema?.parse({ denyThreshold: 0.9 })).toEqual({
      provider: "gateway",
      denyThreshold: 0.9,
    });
  });

  // The contract test: the reference gate loads through the real Tool-gate
  // point, so a change to the point that it doesn't follow fails here.
  it("is a built-in that is off by default and loads as a Tool gate", async () => {
    expect(Object.keys(BUILTIN_PLUGINS)).toContain(plugin.name);
    expect(ALWAYS_ON_PLUGINS).not.toContain(plugin.name);

    const gates: ToolGateRegistration[] = [];
    const { plugins } = await loadPlugins({
      pluginNames: [plugin.name],
      register: () => {},
      registerGate: (gate) => gates.push(gate),
      pluginConfig: {
        [plugin.name]: {
          config: { denyThreshold: 0.9 },
          credentials: { apiKey: "k" },
        },
      },
    });

    expect(plugins[0].toolGateIds).toEqual(["decision-model"]);
    expect(gates.map((g) => g.id)).toEqual(["decision-model"]);
  });
});
