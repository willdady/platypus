import { describe, it, expect, beforeEach } from "vitest";
import { mockScopedSWR, resetListHarness, swrMock } from "./list-test-harness";

const useSWR = swrMock.default;

describe("swrMock", () => {
  beforeEach(() => resetListHarness());

  it("falls back to an empty list for an unregistered read by default", () => {
    mockScopedSWR({ "/agents": [] });
    expect(useSWR("http://test/ws1/skills").data).toEqual({ results: [] });
  });

  describe("strict", () => {
    it("throws on a read no fragment matches, naming its key", () => {
      mockScopedSWR({ "/agents": [] }, { strict: true });
      expect(() => useSWR("http://test/ws1/agnets")).toThrow(
        /http:\/\/test\/ws1\/agnets/,
      );
    });

    it("returns the registered response for a matching read", () => {
      mockScopedSWR({ "/agents": [{ id: "a1" }] }, { strict: true });
      expect(useSWR("http://test/ws1/agents").data).toEqual({
        results: [{ id: "a1" }],
      });
    });

    it("lets a conditional read that is switched off (a null key) through", () => {
      mockScopedSWR({ "/agents": [] }, { strict: true });
      expect(useSWR(null).data).toEqual({ results: [] });
    });

    it("is switched off again by resetListHarness", () => {
      mockScopedSWR({ "/agents": [] }, { strict: true });
      resetListHarness();
      expect(useSWR("http://test/ws1/skills").data).toEqual({ results: [] });
    });
  });
});
