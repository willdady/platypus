import { describe, expect, it } from "vitest";
import type { Tool } from "ai";
import { wrapToolExecutes } from "./tool-execution.ts";
import {
  capToolResults,
  normalizeToolResults,
} from "../services/tool-result.ts";
import { wrapToolsWithActivity } from "../services/tool-activity.ts";

const methodTool = () =>
  ({
    secret: "sibling state",
    execute() {
      return (this as { secret: string }).secret;
    },
  }) as unknown as Tool;

describe("wrapToolExecutes", () => {
  it("leaves a tool with no execute exactly as it was", () => {
    const providerTool = { description: "native" } as unknown as Tool;
    const wrapped = wrapToolExecutes({ search: providerTool }, () => () => 1);
    expect(wrapped.search).toBe(providerTool);
  });

  it.each([
    ["normalizeToolResults", normalizeToolResults],
    ["capToolResults", capToolResults],
    [
      "wrapToolsWithActivity",
      (tools: Record<string, Tool>) => wrapToolsWithActivity(tools, () => {}),
    ],
  ])("%s calls execute with the tool as its receiver", async (_l, wrap) => {
    const { lookup } = wrap({ lookup: methodTool() });
    const execute = lookup.execute as (a: unknown, o: unknown) => unknown;
    expect(await execute({}, {})).toBe("sibling state");
  });
});
