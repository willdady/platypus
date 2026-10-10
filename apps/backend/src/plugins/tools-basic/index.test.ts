import { describe, it, expect } from "vitest";
import {
  PLUGIN_API_VERSION,
  type ToolSetContext,
} from "@platypuschat/plugin-sdk";
import type { Tool } from "ai";
import { callTool } from "../../test-utils.ts";
import { plugin } from "./index.ts";

describe("@platypus/tools-basic plugin manifest", () => {
  it("declares its identity and API version", () => {
    expect(plugin.name).toBe("@platypus/tools-basic");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it("contributes the math-conversions, time and identifiers tool sets with unprefixed ids", () => {
    const ids = (plugin.contributes.toolSets ?? []).map((t) => t.id);
    expect(ids).toEqual(["math-conversions", "time", "identifiers"]);
  });

  it("exposes the expected tools", () => {
    const [math, time, identifiers] = plugin.contributes.toolSets ?? [];

    expect(typeof math.tools).not.toBe("function");
    expect(Object.keys(math.tools as Record<string, unknown>)).toEqual([
      "convertTemperature",
      "convertDistance",
      "convertWeight",
      "convertVolume",
    ]);

    // A factory, so getCurrentTime reports in the acting User's timezone
    expect(typeof time.tools).toBe("function");

    expect(typeof identifiers.tools).not.toBe("function");
    expect(Object.keys(identifiers.tools as Record<string, unknown>)).toEqual([
      "generateUuid",
      "generateNanoId",
    ]);
  });

  it("builds the time tools in the context's timezone", async () => {
    const time = (plugin.contributes.toolSets ?? []).find(
      (t) => t.id === "time",
    )!;
    // The plugin argument goes unread by core's own factories
    const factory = time.tools as (ctx: ToolSetContext) => Record<string, Tool>;
    const tools = factory({
      workspaceId: "ws",
      agentId: "agent",
      orgId: "org",
      frontendUrl: undefined,
      userId: "user",
      timezone: "Asia/Tokyo",
      registerCloser: () => {},
    });

    expect(Object.keys(tools)).toEqual(["getCurrentTime", "convertTimezone"]);
    expect(await callTool(tools.getCurrentTime, {})).toMatchObject({
      timezone: "Asia/Tokyo",
    });
  });
});
