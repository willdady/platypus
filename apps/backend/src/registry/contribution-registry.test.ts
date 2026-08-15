import { describe, it, expect } from "vitest";
import { createContributionRegistry } from "./contribution-registry.ts";

// The three Extension-point registries (Tool sets, Sandbox backends, Web-search
// backends) are instances of this one factory, so the contract every one of them
// honours is tested here once. Each registry module keeps a thin suite of its
// own covering only what it adds — the id it keys on, and the entries it
// registers at import time.

type Entry = { label: string };

const makeRegistry = () =>
  createContributionRegistry<Entry>({ noun: "Tool set" });

describe("createContributionRegistry", () => {
  it("registers an entry and serves it by id", () => {
    const registry = makeRegistry();
    registry.register("alpha", { label: "Alpha" });
    expect(registry.get("alpha")).toEqual({ label: "Alpha" });
  });

  it("returns the registered entry from register()", () => {
    const registry = makeRegistry();
    const entry = { label: "Alpha" };
    expect(registry.register("alpha", entry)).toBe(entry);
  });

  it("returns undefined for an id nothing registered", () => {
    expect(makeRegistry().get("absent")).toBeUndefined();
  });

  it("answers has() for registered and unregistered ids", () => {
    const registry = makeRegistry();
    registry.register("alpha", { label: "Alpha" });
    expect(registry.has("alpha")).toBe(true);
    expect(registry.has("absent")).toBe(false);
  });

  it("does not resolve Object.prototype members as registered entries", () => {
    // Every one of these ids reaches a lookup from request data — `toolSetId`
    // from `agent.toolSetIds`, `backend` from a save-route body and from the
    // `sandbox.backend` / `provider.searchSource` columns. A plain-object store
    // answered `"toString" in store` with true and handed back
    // `Object.prototype.toString`: truthy, with no `tools` and no
    // `configSchema`, so a Chat turn silently resolved no tools and the save
    // route threw a TypeError instead of reporting an unregistered backend.
    const registry = makeRegistry();
    for (const id of [
      "toString",
      "constructor",
      "__proto__",
      "valueOf",
      "hasOwnProperty",
    ]) {
      expect(registry.get(id)).toBeUndefined();
      expect(registry.has(id)).toBe(false);
    }
  });

  it("stores an entry under an Object.prototype-shaped id without leaking it", () => {
    const registry = makeRegistry();
    registry.register("toString", { label: "Odd" });
    expect(registry.get("toString")).toEqual({ label: "Odd" });
    expect(registry.get("valueOf")).toBeUndefined();
  });

  it("rejects a duplicate id, naming the registry's noun", () => {
    const registry = makeRegistry();
    registry.register("alpha", { label: "Alpha" });
    expect(() => registry.register("alpha", { label: "Again" })).toThrow(
      "Tool set 'alpha' has already been registered.",
    );
  });

  it("keeps the first registration when a duplicate is rejected", () => {
    const registry = makeRegistry();
    registry.register("alpha", { label: "Alpha" });
    expect(() => registry.register("alpha", { label: "Again" })).toThrow();
    expect(registry.get("alpha")).toEqual({ label: "Alpha" });
  });

  it("lists entries in registration order", () => {
    const registry = makeRegistry();
    registry.register("alpha", { label: "Alpha" });
    registry.register("beta", { label: "Beta" });
    expect(registry.list().map((e) => e.label)).toEqual(["Alpha", "Beta"]);
  });

  it("lists nothing before anything registers", () => {
    expect(makeRegistry().list()).toEqual([]);
  });

  it("empties on clear() so a test can re-register the same id", () => {
    const registry = makeRegistry();
    registry.register("alpha", { label: "Alpha" });
    registry.clear();
    expect(registry.get("alpha")).toBeUndefined();
    expect(registry.list()).toEqual([]);
    expect(() => registry.register("alpha", { label: "Again" })).not.toThrow();
  });

  it("keeps instances independent", () => {
    const one = makeRegistry();
    const two = makeRegistry();
    one.register("alpha", { label: "Alpha" });
    expect(two.get("alpha")).toBeUndefined();
  });
});
