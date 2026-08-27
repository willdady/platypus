import { describe, it, expect } from "vitest";
import {
  PLUGIN_API_VERSION,
  type PluginConfigContext,
} from "@platypuschat/plugin-sdk";
import {
  registerContributions,
  type ContributionIdentity,
  type ExtensionPoint,
  type RawContribution,
} from "./contribution-pipeline.ts";
import { makeFakePluginLogger } from "../test-utils.ts";

// Every Extension point runs the same seven steps over its slice of a manifest —
// shape check, id and name checks, namespacing, owner-attributed collision
// check, attributed registration, bookkeeping. They are tested once here,
// against a stand-in point, so `loader.test.ts` is left testing what each real
// point *adds* rather than re-testing this sequence three times.

const PLUGIN: PluginConfigContext = {
  config: { key: "k" },
  credentials: {},
  logger: makeFakePluginLogger(),
};

type Widget = { id: string; label: string; plugin: PluginConfigContext };

// A point with no extras: the pipeline's behaviour with everything optional
// left out.
const makePoint = (
  overrides: Partial<ExtensionPoint<Widget>> = {},
): {
  point: ExtensionPoint<Widget>;
  registered: Array<{ id: string; registration: Widget }>;
} => {
  const registered: Array<{ id: string; registration: Widget }> = [];
  const point: ExtensionPoint<Widget> = {
    noun: "widget",
    idField: "id",
    prepare: (contribution, ctx) => ({
      id: ctx.id,
      label: String(contribution.name),
      plugin: ctx.plugin,
    }),
    register: (id, registration) => {
      registered.push({ id, registration });
    },
    ...overrides,
  };
  return { point, registered };
};

const run = (
  contributions: readonly unknown[],
  options: {
    point?: ExtensionPoint<Widget>;
    pluginName?: string;
    contributionId?: (id: string) => string;
    isCore?: boolean;
    apiVersion?: number;
    owners?: Map<string, string>;
  } = {},
) =>
  registerContributions({
    point: options.point ?? makePoint().point,
    contributions,
    pluginName: options.pluginName ?? "acme",
    plugin: PLUGIN,
    contributionId: options.contributionId ?? ((id) => id),
    isCore: options.isCore ?? false,
    apiVersion: options.apiVersion ?? PLUGIN_API_VERSION,
    owners: options.owners ?? new Map<string, string>(),
  });

const widget = (id: string) => ({ id, name: `Widget ${id}` });

describe("registerContributions", () => {
  it("registers each contribution and returns the ids it registered", () => {
    const { point, registered } = makePoint();
    const ids = run([widget("a"), widget("b")], { point });

    expect(ids).toEqual(["a", "b"]);
    expect(registered.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("registers nothing for an empty contribution list", () => {
    const { point, registered } = makePoint();
    expect(run([], { point })).toEqual([]);
    expect(registered).toEqual([]);
  });

  it("namespaces the id and trims it first", () => {
    // `acme. my widget ` must never reach a registry or a persisted column, so
    // the raw id is trimmed before the plugin prefix is composed onto it.
    const { point, registered } = makePoint();
    const ids = run([{ id: "  spaced  ", name: "W" }], {
      point,
      contributionId: (id) => `acme.${id}`,
    });

    expect(ids).toEqual(["acme.spaced"]);
    expect(registered[0].registration.id).toBe("acme.spaced");
  });

  it("records each registered id against its owning plugin", () => {
    const owners = new Map<string, string>();
    run([widget("a")], { owners, pluginName: "acme" });
    expect(owners.get("a")).toBe("acme");
  });

  it("aborts on an id already owned by another plugin, naming both", () => {
    const owners = new Map([["a", "first"]]);
    expect(() => run([widget("a")], { owners, pluginName: "second" })).toThrow(
      'Widget id "a" is contributed by both "first" and "second".',
    );
  });

  it("aborts on two contributions in one manifest sharing an id", () => {
    expect(() => run([widget("a"), widget("a")])).toThrow(
      'Widget id "a" is contributed by both "acme" and "acme".',
    );
  });

  it.each([
    ["a null entry", null],
    ["a string entry", "broken"],
    ["a number entry", 7],
    ["an array entry", []],
  ])(
    "aborts (plugin-named) on %s, naming the index",
    (_label, contribution) => {
      expect(() => run([widget("fine"), contribution])).toThrow(
        'Plugin "acme": every widget contribution must be an object (at index 1).',
      );
    },
  );

  it.each([
    ["a missing id", { name: "W" }],
    ["a non-string id", { id: 7, name: "W" }],
    ["a whitespace-only id", { id: "   ", name: "W" }],
  ])(
    "aborts (plugin-named) on %s, naming the index",
    (_label, contribution) => {
      // The checks that run before an id is known carry the array index: on a
      // plugin contributing several entries it is the only thing an Operator can
      // use to find the offending one.
      expect(() => run([widget("fine"), contribution])).toThrow(
        'Plugin "acme": every widget must declare a non-empty "id" (at index 1).',
      );
    },
  );

  it("names the point's own id field in the missing-id error", () => {
    const { point } = makePoint({
      noun: "sandbox backend",
      idField: "backend",
      prepare: (_c, ctx) => ({ id: ctx.id, label: "", plugin: ctx.plugin }),
    });
    expect(() => run([{ name: "W" }], { point })).toThrow(
      'Plugin "acme": every sandbox backend must declare a non-empty "backend" (at index 0).',
    );
  });

  it.each([
    ["a missing name", { id: "a" }],
    ["a non-string name", { id: "a", name: 7 }],
    ["a whitespace-only name", { id: "a", name: "  " }],
  ])("aborts (plugin-named) on %s, naming the id", (_label, contribution) => {
    expect(() => run([contribution])).toThrow(
      'Plugin "acme": widget "a" must declare a non-empty "name".',
    );
  });

  it("stops at the first bad entry, leaving the ones ahead of it registered", () => {
    // Entries validate and register in the same pass, so a good entry ahead of
    // a bad one is already registered. That is not a leak: the throw aborts
    // boot, so the half-filled registry never serves a turn.
    const { point, registered } = makePoint();
    expect(() => run([widget("fine"), null], { point })).toThrow();
    expect(registered.map((r) => r.id)).toEqual(["fine"]);
  });

  it("runs the point's own validator against the un-namespaced contribution", () => {
    // The validator is handed the id the plugin author wrote, not the
    // namespaced one, so its messages read with the id they would recognise.
    const seen: Array<{
      contribution: RawContribution;
      identity: ContributionIdentity;
    }> = [];
    const { point } = makePoint({
      validate: (contribution, identity) => {
        seen.push({ contribution, identity });
      },
    });
    run([{ id: "  a  ", name: "Widget a" }], {
      point,
      contributionId: (id) => `acme.${id}`,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].contribution).toMatchObject({ id: "  a  " });
    expect(seen[0].identity).toEqual({ pluginName: "acme", rawId: "  a  " });
  });

  it("lets the point's validator abort the load", () => {
    const { point, registered } = makePoint({
      validate: () => {
        throw new Error('Plugin "acme": widget "a" is missing its widgetry.');
      },
    });
    expect(() => run([widget("a")], { point })).toThrow("missing its widgetry");
    expect(registered).toEqual([]);
  });

  it("hands prepare the namespaced id and the plugin's shared config block", () => {
    const { point, registered } = makePoint();
    run([widget("a")], { point, contributionId: (id) => `acme.${id}` });

    expect(registered[0].registration).toEqual({
      id: "acme.a",
      label: "Widget a",
      plugin: PLUGIN,
    });
    // The same block every contribution of this plugin is bound to — object
    // identity IS "one credential block per plugin" (ADR-0013).
    expect(registered[0].registration.plugin).toBe(PLUGIN);
  });

  // The Tool-set point namespaces tool *names* by origin as well as ids (issue
  // #664), so the loader's origin decision has to reach `prepare` rather than
  // being re-derived from the plugin name there.
  it.each([true, false])(
    "hands prepare the origin decision (isCore=%s)",
    (isCore) => {
      const seen: boolean[] = [];
      const { point } = makePoint({
        prepare: (_c, ctx) => {
          seen.push(ctx.isCore);
          return { id: ctx.id, label: "", plugin: ctx.plugin };
        },
      });
      run([widget("a")], { point, isCore });
      expect(seen).toEqual([isCore]);
    },
  );

  it("re-throws a registry collision with plugin attribution", () => {
    // A registry that rejects the id (an already-registered core built-in, say)
    // throws without knowing which plugin asked. Attribution is added here.
    const { point } = makePoint({
      register: () => {
        throw new Error("Widget 'a' has already been registered.");
      },
    });
    expect(() => run([widget("a")], { point })).toThrow(
      'Plugin "acme": failed to register widget "a" (Widget \'a\' has already been registered.).',
    );
  });

  it("keeps the registry's own failure as the cause", () => {
    const cause = new Error("Widget 'a' has already been registered.");
    const { point } = makePoint({
      register: () => {
        throw cause;
      },
    });
    expect(() => run([widget("a")], { point })).toThrow(
      expect.objectContaining({ cause }),
    );
  });

  it("does not record an owner for a contribution the registry refused", () => {
    const owners = new Map<string, string>();
    const { point } = makePoint({
      register: () => {
        throw new Error("nope");
      },
    });
    expect(() => run([widget("a")], { point, owners })).toThrow();
    expect(owners.has("a")).toBe(false);
  });
});
