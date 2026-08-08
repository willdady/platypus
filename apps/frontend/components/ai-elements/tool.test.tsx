import { describe, it, expect } from "vitest";
import { humanizeToolType } from "./tool";

// The header label is the only place a tool name is shown as prose, and the names
// reaching it are not all camelCase: provider-native search and the Web-search
// backend tools are snake_case by design (ADR-0014), and most MCP servers namespace
// with underscores too.
describe("humanizeToolType", () => {
  it.each([
    ["tool-getBoardState", "Get board state"],
    ["tool-web_search", "Web search"],
    ["tool-read_url", "Read url"],
    ["tool-fsRead", "Fs read"],
    // MCP servers commonly join a namespace with a double underscore.
    ["tool-github__create_issue", "Github create issue"],
    // The prefix is optional: `dynamic-tool` parts pass a bare tool name.
    ["web_search", "Web search"],
  ])("renders %s as %s", (type, expected) => {
    expect(humanizeToolType(type)).toBe(expected);
  });
});
