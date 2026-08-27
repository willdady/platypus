import type {
  SandboxBackendContribution,
  ToolSetContribution,
  WebBackendContribution,
} from "@platypuschat/plugin-sdk";
import { SEARCH_SOURCE_NATIVE, SEARCH_SOURCE_NONE } from "@platypus/schemas";
import type { SandboxBackendRegistration } from "../sandbox/index.ts";
import { composeToolSet, type ToolSetRegistration } from "../tools/index.ts";
import {
  composeWebBackend,
  MAX_WEB_TIMEOUT_MS,
  type WebBackendRegistration,
} from "../web-backends/index.ts";
import type { ExtensionPoint } from "./contribution-pipeline.ts";

// What each Extension point adds to the shared registration sequence in
// `contribution-pipeline.ts`: the noun its errors read with, the field it takes
// its id from, the shape checks the shared id/name pair does not cover, and how
// the plugin's deploy-time config block is bound into what core registers.
//
// A point is a table entry, not a loop. Adding a fourth (ADR-0013 anticipates
// them) means one more factory here and one more row in `loader.ts`'s table.
//
// Config binding is always a closure or a factory, never an object spread over
// the contribution: a class-instance contribution loses its prototype and its
// `this` when spread, and its factories must be called on the author's own
// object.

/**
 * The Tool-set point (ADR-0013). Registers core's *composed* registration — core
 * owns everything between the contribution's factory and the model — rather than
 * the raw `{ name, category, description, tools }`.
 */
export const toolSetPoint = (
  register: (id: string, registration: ToolSetRegistration) => void,
): ExtensionPoint<ToolSetRegistration> => ({
  noun: "tool set",
  idField: "id",
  validate: (contribution, { pluginName, rawId }) => {
    if (
      typeof contribution.category !== "string" ||
      contribution.category.trim() === ""
    ) {
      throw new Error(
        `Plugin "${pluginName}": tool set "${rawId}" must declare a non-empty "category".`,
      );
    }
    if (
      typeof contribution.tools !== "function" &&
      (typeof contribution.tools !== "object" ||
        contribution.tools === null ||
        Array.isArray(contribution.tools))
    ) {
      throw new Error(
        `Plugin "${pluginName}": tool set "${rawId}" must provide a "tools" object or function.`,
      );
    }
  },
  prepare: (raw, { pluginName, id, plugin, isCore }) => {
    const contribution = raw as unknown as ToolSetContribution;
    // Core wraps the contribution here, binding the same shared plugin config
    // that every other contribution factory receives. What lands in the registry
    // is the finished, guarded builder — per-turn callers never see the raw
    // `tools`. The contribution goes in by reference, with the namespaced id
    // alongside it rather than spread over it, for the same prototype/`this`
    // reason as the sandbox and web points.
    //
    // `isCore` rides along because the tool-*name* rule turns on the same origin
    // decision the namespaced id already did (issue #664), and the loader is the
    // only place that decision is made.
    return composeToolSet({ contribution, id, plugin, pluginName, isCore });
  },
  register,
});

/**
 * The Sandbox-backend point (ADR-0002/0013). Registers the contribution with its
 * `configSchema` factory form resolved away and `create` bound to the plugin's
 * config block.
 */
export const sandboxBackendPoint = (
  register: (registration: SandboxBackendRegistration) => void,
): ExtensionPoint<SandboxBackendRegistration> => ({
  noun: "sandbox backend",
  idField: "backend",
  validate: (contribution, { pluginName, rawId }) => {
    // Guaranteed by `SandboxBackendContribution`, and not guaranteed by a
    // third-party *JS* plugin: a missing `create` used to surface as a TypeError
    // at chat-turn or teardown time, naming nothing.
    if (typeof contribution.create !== "function") {
      throw new Error(
        `Plugin "${pluginName}": sandbox backend "${rawId}" must provide a "create" function.`,
      );
    }
  },
  prepare: (raw, { pluginName, id, plugin, apiVersion }) => {
    const contribution = raw as unknown as SandboxBackendContribution;

    // Resolve a factory-form configSchema against the boot-resolved plugin block
    // so the three static `configSchema.safeParse` consumers (save route,
    // teardown, tool resolver) always receive a concrete schema — they never see
    // plugin config. A plain schema passes through untouched: plugin-config-
    // agnostic backends are unaffected.
    //
    // At API v2 the factory is handed the whole `PluginConfigContext`, the same
    // object `create` gets, rather than the `config` half alone. It was the one
    // factory on this surface that could reach neither the plugin's credentials
    // nor its logger — so the one with no way to say why it refused a value.
    //
    // A v1 manifest is still inside core's window (ADR-0013's N and N−1), and
    // this is the only member whose *shape* changed across that window rather
    // than being appended to — every other v2 requirement is something core
    // always supplied, which a v1 factory may simply ignore. So a v1 factory is
    // handed what it was written against: the `config` half. Without this branch
    // it silently narrows the wrong object and builds a per-Workspace schema that
    // validates nothing it was meant to — the failure the window exists to
    // prevent, and a silent one, since a factory taking `unknown` cannot notice.
    // The branch retires itself when core reaches v3 and v1 leaves the window.
    //
    // The factory is third-party code narrowing that block itself, so it can
    // throw — a plugin that assumes an Operator supplied `config.region` raises a
    // bare `Cannot read properties of undefined` naming nothing. Attributed here
    // for the same reason the shape checks exist: the schema check below only
    // catches a factory that *returns* a non-schema, not one that throws on the
    // way there.
    let configSchema: SandboxBackendRegistration["configSchema"];
    try {
      configSchema =
        typeof contribution.configSchema === "function"
          ? // Widened to `unknown`: the two window versions pass genuinely
            // different shapes, which the v2-only SDK signature cannot express.
            (
              contribution.configSchema as (
                arg: unknown,
              ) => SandboxBackendRegistration["configSchema"]
            )(apiVersion < 2 ? plugin.config : plugin)
          : contribution.configSchema;
    } catch (cause) {
      throw new Error(
        `Plugin "${pluginName}": sandbox backend "${id}" configSchema factory threw (${
          cause instanceof Error ? cause.message : String(cause)
        }).`,
        { cause },
      );
    }

    // Checked after the factory form is resolved away, and duck-typed on
    // `safeParse` rather than `instanceof z.ZodType`, because that is exactly
    // what the three static consumers call. Without this, a contribution missing
    // either schema registers fine and fails at *save* time — a 500 on an
    // Operator's sandbox form, attributed to nothing.
    for (const [field, schema] of [
      ["configSchema", configSchema],
      ["credentialsSchema", contribution.credentialsSchema],
    ] as const) {
      if (
        typeof schema !== "object" ||
        schema === null ||
        typeof (schema as { safeParse?: unknown }).safeParse !== "function"
      ) {
        throw new Error(
          `Plugin "${pluginName}": sandbox backend "${id}" must provide a Zod "${field}".`,
        );
      }
    }

    // Bind the same shared plugin config into create() so core's per-turn
    // callers (chat resolution, teardown) keep calling create(config,
    // credentials) with the per-Workspace values only. Third-party backends also
    // register under the namespaced discriminator, so the `sandbox.backend`
    // column resolves to the prefixed id (mirroring tool sets).
    //
    // Field by field rather than spread over the contribution: `create` must be
    // called on the author's own object, or a class-instance contribution loses
    // its prototype and its `this`.
    return {
      backend: id,
      name: contribution.name,
      configSchema,
      credentialsSchema: contribution.credentialsSchema,
      create: (config, credentials) =>
        contribution.create(config, credentials, plugin),
    };
  },
  register: (_id, registration) => register(registration),
});

/**
 * The Web-search-backend point (ADR-0014). Registers core's *composed*
 * registration — core owns the model-facing Tools — rather than the raw
 * contribution.
 */
export const webBackendPoint = (
  register: (registration: WebBackendRegistration) => void,
): ExtensionPoint<WebBackendRegistration> => ({
  noun: "web backend",
  idField: "backend",
  prepare: (raw, { pluginName, id, plugin }) => {
    const contribution = raw as unknown as WebBackendContribution;

    // Checked against the *namespaced* id, not the raw one: `provider.searchSource`
    // reserves these two literals ahead of any backend id (`resolveSearchMode`
    // checks them first), and only a bare — i.e. core — id can ever collide with
    // them, since a third-party id is always prefixed with the plugin's name. A
    // backend registered under either would silently never serve a turn.
    if (id === SEARCH_SOURCE_NONE || id === SEARCH_SOURCE_NATIVE) {
      throw new Error(
        `Plugin "${pluginName}": web backend "${id}" is reserved by provider.searchSource and can never serve a turn — choose a different id.`,
      );
    }

    // A web backend supplies executors only — core builds the Tools — so a
    // missing factory means the contribution can never serve a turn. The TS type
    // says so; a third-party JS plugin can still ship it, and boot is where that
    // is caught (ADR-0014's fail-loud boot posture).
    if (typeof contribution.createExecutors !== "function") {
      throw new Error(
        `Plugin "${pluginName}": web backend "${id}" must provide a "createExecutors" function.`,
      );
    }

    // `timeoutMs` is static on the contribution, so an over-ceiling value is
    // knowable now — refused with attribution rather than silently clamped at
    // turn time, where an Operator would never see it.
    if (contribution.timeoutMs !== undefined) {
      const { timeoutMs } = contribution;
      if (
        typeof timeoutMs !== "number" ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > MAX_WEB_TIMEOUT_MS
      ) {
        throw new Error(
          `Plugin "${pluginName}": web backend "${id}" declares timeoutMs ${String(
            timeoutMs,
          )}, which must be a positive number no greater than ${MAX_WEB_TIMEOUT_MS}.`,
        );
      }
    }

    // Core wraps the executors here, binding the same shared plugin config that
    // every other contribution factory receives. What lands in the registry is
    // the finished, guarded builder — per-turn callers never see the executors.
    // The contribution goes in by reference, with the namespaced id alongside it
    // rather than spread over it, for the same prototype/`this` reason as the
    // sandbox point above.
    return composeWebBackend({
      contribution,
      backend: id,
      plugin,
      pluginName,
    });
  },
  register: (_id, registration) => register(registration),
});
