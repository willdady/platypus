import { describe, it, expect } from "vitest";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import { plugin } from "./index.ts";

describe("@platypus-examples/tool-set", () => {
  it("exports a well-formed manifest with a short namespace name", () => {
    // The manifest `name` is the namespace the loader prefixes onto every
    // contribution id for a third-party plugin — kept short and bare ("example")
    // rather than the scoped package specifier.
    expect(plugin.name).toBe("example");
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(plugin.contributes.toolSets).toHaveLength(1);
  });

  it("contributes a bare (unprefixed) tool set id", () => {
    // Authors write bare ids; core prefixes at load. The package must NOT
    // pre-namespace its own ids.
    const toolSet = plugin.contributes.toolSets?.[0];
    expect(toolSet?.id).toBe("greeting");
    expect(toolSet).not.toBeUndefined();
  });

  it("greet returns a greeting for the given name", async () => {
    const toolSet = plugin.contributes.toolSets?.[0];
    if (!toolSet || typeof toolSet.tools === "function") {
      throw new Error("expected a static tool map");
    }
    const greet = toolSet.tools.greet;
    const result = await greet.execute!(
      { name: "Ada" },
      { toolCallId: "t1", messages: [] },
    );
    expect(result).toContain("Ada");
  });
});
