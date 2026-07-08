import { describe, it, expect } from "vitest";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import { plugin } from "./index.ts";

describe("@platypus/tools-basic plugin manifest", () => {
  it("declares its identity and API version", () => {
    expect(plugin.name).toBe("@platypus/tools-basic");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it("contributes the math-conversions and time tool sets with unprefixed ids", () => {
    const ids = (plugin.contributes.toolSets ?? []).map((t) => t.id);
    expect(ids).toEqual(["math-conversions", "time"]);
  });

  it("exposes the expected tools as static maps", () => {
    const [math, time] = plugin.contributes.toolSets ?? [];

    expect(typeof math.tools).not.toBe("function");
    expect(Object.keys(math.tools as Record<string, unknown>)).toEqual([
      "convertTemperature",
      "convertDistance",
      "convertWeight",
      "convertVolume",
    ]);

    expect(typeof time.tools).not.toBe("function");
    expect(Object.keys(time.tools as Record<string, unknown>)).toEqual([
      "getCurrentTime",
      "convertTimezone",
    ]);
  });
});
