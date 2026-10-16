import { describe, it, expect } from "vitest";
import {
  encodeAgentSelection,
  encodeProviderSelection,
  decodeSelectionReference,
} from "./selection-reference";

describe("encodeAgentSelection", () => {
  it("prefixes the agent id", () => {
    expect(encodeAgentSelection("a1")).toBe("agent:a1");
  });
});

describe("encodeProviderSelection", () => {
  it("joins provider id and model reference", () => {
    expect(encodeProviderSelection("p1", "gpt-4o")).toBe("provider:p1:gpt-4o");
  });

  it("round-trips a model reference that itself contains a colon (a Model alias)", () => {
    expect(encodeProviderSelection("p1", "alias:flagship")).toBe(
      "provider:p1:alias:flagship",
    );
  });
});

describe("decodeSelectionReference", () => {
  it("decodes an agent reference", () => {
    expect(decodeSelectionReference("agent:a1")).toEqual({
      type: "agent",
      agentId: "a1",
    });
  });

  it("decodes a provider reference", () => {
    expect(decodeSelectionReference("provider:p1:gpt-4o")).toEqual({
      type: "provider",
      providerId: "p1",
      modelReference: "gpt-4o",
    });
  });

  it("keeps the alias prefix inside the model reference rather than splitting on every colon", () => {
    expect(decodeSelectionReference("provider:p1:alias:flagship")).toEqual({
      type: "provider",
      providerId: "p1",
      modelReference: "alias:flagship",
    });
  });

  it("round-trips encodeProviderSelection for an aliased model", () => {
    const encoded = encodeProviderSelection("p1", "alias:flagship");
    expect(decodeSelectionReference(encoded)).toEqual({
      type: "provider",
      providerId: "p1",
      modelReference: "alias:flagship",
    });
  });

  it("returns null for a value naming neither shape", () => {
    expect(decodeSelectionReference("")).toBeNull();
    expect(decodeSelectionReference("gpt-4o")).toBeNull();
  });
});
