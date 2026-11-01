import { describe, it, expect } from "vitest";
import {
  namespaceMcpTestToolNames,
  resolveMcpTestToolNames,
} from "./mcp-test-tools.ts";

describe("namespaceMcpTestToolNames", () => {
  it("namespaces every raw tool name under the slug", () => {
    const result = namespaceMcpTestToolNames("acme", ["search", "fetch"]);
    expect(result.toolNames).toEqual(["acme__search", "acme__fetch"]);
    expect(result.invalidToolNames).toEqual([]);
  });

  it("flags a namespaced name that exceeds the model-provider name limit", () => {
    const longSlug = "a".repeat(60);
    const result = namespaceMcpTestToolNames(longSlug, [
      "ok",
      "thisNameIsWayTooLongToFitOnceNamespaced",
    ]);
    expect(result.toolNames).toEqual([`${longSlug}__ok`]);
    expect(result.invalidToolNames).toEqual([
      `${longSlug}__thisNameIsWayTooLongToFitOnceNamespaced`,
    ]);
  });

  it("does not strip a raw tool name that already looks namespaced", () => {
    const result = namespaceMcpTestToolNames("github", ["github__pull"]);
    expect(result.toolNames).toEqual(["github__github__pull"]);
  });
});

describe("resolveMcpTestToolNames", () => {
  it("namespaces under the given name, without consulting the stored name", () => {
    const result = resolveMcpTestToolNames(
      ["search"],
      "My Server",
      "Stored Name",
    );
    expect(result.toolNames).toEqual(["my_server__search"]);
  });

  it("falls back to the stored name when none is given", () => {
    const result = resolveMcpTestToolNames(
      ["search"],
      undefined,
      "Stored Name",
    );
    expect(result.toolNames).toEqual(["stored_name__search"]);
  });

  it("leaves names unnamespaced when neither a name nor a stored name is given", () => {
    const result = resolveMcpTestToolNames(["search"], undefined, undefined);
    expect(result).toEqual({ toolNames: ["search"], invalidToolNames: [] });
  });
});
