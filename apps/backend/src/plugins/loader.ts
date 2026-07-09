import {
  OLDEST_SUPPORTED_API_VERSION,
  PLUGIN_API_VERSION,
  type PlatypusPlugin,
  type PluginConfigContext,
  type SandboxBackendContribution,
  type ToolSetContribution,
} from "@platypuschat/plugin-sdk";
import { ALWAYS_ON_PLUGINS, BUILTIN_PLUGINS } from "./builtin.ts";
import { registerToolSet } from "../tools/index.ts";
import { registerSandboxBackend } from "../sandbox/index.ts";

// Summary of one loaded plugin, for the boot log line and observability.
export interface LoadedPlugin {
  name: string;
  version: string;
  origin: "core" | "third-party";
  toolSetIds: string[];
  sandboxBackendIds: string[];
}

// A module that exports a plugin manifest. Values are `unknown` until validated.
type PluginModule = { plugin?: unknown };

// Deploy-time config/credentials the Operator supplies for one plugin. Both
// halves are optional and opaque until validated against the manifest's
// plugin-level schemas at boot.
export interface RawPluginConfig {
  config?: unknown;
  credentials?: unknown;
}

// The full Operator-supplied config map, keyed by plugin name (`manifest.name`).
// Parsed from `PLATYPUS_PLUGIN_CONFIG` (see {@link parsePluginConfig}).
export type PluginConfigMap = Record<string, RawPluginConfig>;

export interface LoadPluginsOptions {
  /** Plugin names to load. Defaults to parsing `PLATYPUS_PLUGINS`. */
  pluginNames?: string[];
  /**
   * Core plugins loaded unconditionally, ahead of the gate-able list. Defaults
   * to {@link ALWAYS_ON_PLUGINS} on the env-default path (when `pluginNames` is
   * unset) and to `[]` when a caller supplies an explicit `pluginNames` (so the
   * caller owns both lists). Listing any of these in the gate-able list is a
   * fail-loud misconfiguration (they are not enable switches).
   */
  alwaysOnPlugins?: readonly string[];
  /** The core allowlist / static built-in map. Defaults to {@link BUILTIN_PLUGINS}. */
  builtinPlugins?: Record<string, () => Promise<PluginModule>>;
  /** Resolves a third-party plugin. Defaults to dynamic `import()`. */
  importPlugin?: (name: string) => Promise<PluginModule>;
  /** Registers one Tool set contribution. Defaults to the core `registerToolSet`. */
  register?: (id: string, def: Omit<ToolSetContribution, "id">) => void;
  /** Registers one Sandbox-backend contribution. Defaults to core `registerSandboxBackend`. */
  registerSandbox?: (contribution: SandboxBackendContribution) => void;
  /**
   * Deploy-time plugin config/credentials keyed by plugin name. Defaults to
   * parsing `PLATYPUS_PLUGIN_CONFIG` (see {@link parsePluginConfig}).
   */
  pluginConfig?: PluginConfigMap;
}

/**
 * Parse the comma-separated `PLATYPUS_PLUGINS` value into a clean name list.
 * Trims whitespace and drops empty entries; an unset/empty value yields `[]`.
 */
export const parsePluginList = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Parse the `PLATYPUS_PLUGIN_CONFIG` value — a JSON object keyed by plugin name,
 * each value an optional `{ config?, credentials? }` — into a {@link
 * PluginConfigMap}. Plugin names carry `@scope/name` slashes, so a single JSON
 * blob keyed by name is the one config namespace (ADR-0013), not per-plugin env
 * vars. An unset/empty value yields `{}`. Fail-loud: malformed JSON, a non-object
 * root, or a non-object entry aborts boot.
 */
export const parsePluginConfig = (raw: string | undefined): PluginConfigMap => {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    throw new Error(
      `PLATYPUS_PLUGIN_CONFIG is not valid JSON (${
        cause instanceof Error ? cause.message : String(cause)
      }).`,
      { cause },
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `PLATYPUS_PLUGIN_CONFIG must be a JSON object keyed by plugin name.`,
    );
  }

  const map: PluginConfigMap = {};
  for (const [pluginName, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `PLATYPUS_PLUGIN_CONFIG["${pluginName}"] must be an object with optional "config" / "credentials".`,
      );
    }
    const { config, credentials } = entry as RawPluginConfig;
    map[pluginName] = { config, credentials };
  }
  return map;
};

/**
 * Resolve one plugin's deploy-time config/credentials into the {@link
 * PluginConfigContext} injected into its contribution factories. Each half is
 * validated against the manifest's plugin-level schema when declared (fail-loud,
 * plugin-named); when no schema is declared the raw Operator value passes
 * through untouched (`undefined` when absent — nothing to validate against).
 */
const resolvePluginConfig = (
  manifest: PlatypusPlugin,
  raw: RawPluginConfig,
): PluginConfigContext => {
  const resolveOne = (
    kind: "config" | "credentials",
    schema: PlatypusPlugin["configSchema"],
    value: unknown,
  ): unknown => {
    if (!schema) return value;
    const result = schema.safeParse(value ?? {});
    if (!result.success) {
      throw new Error(
        `Plugin "${manifest.name}": deploy-time ${kind} failed validation (${result.error.message}).`,
        { cause: result.error },
      );
    }
    return result.data;
  };

  return {
    config: resolveOne("config", manifest.configSchema, raw.config),
    credentials: resolveOne(
      "credentials",
      manifest.credentialsSchema,
      raw.credentials,
    ),
  };
};

// Validate an imported module's `plugin` export into a typed manifest, or throw
// a plugin-named error explaining why. Covers manifest shape and the ADR-0013
// apiVersion compatibility window (N and N−1): a plugin needing a newer API than
// core provides, or targeting a dropped major, is rejected fail-loud at boot.
const validateManifest = (name: string, mod: PluginModule): PlatypusPlugin => {
  const p = mod.plugin;
  if (!p || typeof p !== "object") {
    throw new Error(
      `Plugin "${name}": module does not export a "plugin" manifest object.`,
    );
  }
  const m = p as Record<string, unknown>;
  if (typeof m.name !== "string" || m.name.length === 0) {
    throw new Error(`Plugin "${name}": manifest is missing a "name".`);
  }
  if (typeof m.version !== "string" || m.version.length === 0) {
    throw new Error(`Plugin "${name}": manifest is missing a "version".`);
  }
  if (
    typeof m.apiVersion !== "number" ||
    !Number.isInteger(m.apiVersion) ||
    m.apiVersion < 1
  ) {
    throw new Error(
      `Plugin "${name}": manifest "apiVersion" must be a positive integer (it names a major API version).`,
    );
  }
  // Compatibility window (ADR-0013): apiVersion is a *minimum*. Core supports the
  // current major and one previous (N and N−1). Reject only outside that window.
  if (m.apiVersion > PLUGIN_API_VERSION) {
    throw new Error(
      `Plugin "${name}": needs API v${m.apiVersion}, but core supports up to v${PLUGIN_API_VERSION}. Upgrade core.`,
    );
  }
  if (m.apiVersion < OLDEST_SUPPORTED_API_VERSION) {
    throw new Error(
      `Plugin "${name}": targets API v${m.apiVersion}, below the oldest core supports (v${OLDEST_SUPPORTED_API_VERSION}). Core supports v${OLDEST_SUPPORTED_API_VERSION}–v${PLUGIN_API_VERSION} (N and N−1).`,
    );
  }
  if (!m.contributes || typeof m.contributes !== "object") {
    throw new Error(
      `Plugin "${name}": manifest is missing a "contributes" object.`,
    );
  }
  const contributes = m.contributes as Record<string, unknown>;
  if (
    contributes.toolSets !== undefined &&
    !Array.isArray(contributes.toolSets)
  ) {
    throw new Error(
      `Plugin "${name}": "contributes.toolSets" must be an array.`,
    );
  }
  if (
    contributes.sandboxBackends !== undefined &&
    !Array.isArray(contributes.sandboxBackends)
  ) {
    throw new Error(
      `Plugin "${name}": "contributes.sandboxBackends" must be an array.`,
    );
  }
  return p as PlatypusPlugin;
};

/**
 * Load and register every plugin. Runs before the HTTP server so registries are
 * populated by the time Chat turns resolve tools.
 *
 * The always-on core set ({@link ALWAYS_ON_PLUGINS}) loads first and
 * unconditionally — independent of `PLATYPUS_PLUGINS` (ADR-0013 amendment) — so
 * a deployment always has Platypus's essential tools even with an empty list.
 * `PLATYPUS_PLUGINS` gates only the deny-worthy core plugins and third-party
 * ones. Listing an always-on plugin there is a fail-loud misconfiguration.
 *
 * Boot is fail-loud and all-or-nothing (ADR-0013): a plugin that can't resolve,
 * has an invalid manifest, whose deploy-time config/credentials fail schema
 * validation, or collides with another aborts startup. Runtime Chat-turn
 * resolution stays graceful and is unaffected.
 *
 * Deploy-time plugin config/credentials (keyed by plugin name) are resolved once
 * per plugin and the single shared block is injected into every one of that
 * plugin's contribution factories, alongside the existing per-Workspace config.
 *
 * Resolution differs by origin: core plugins (present in the built-in map) load
 * via their static thunk; third-party plugins load via dynamic `import()`.
 * "Loaded identically" means an identical manifest → register flow, not
 * identical module resolution.
 *
 * Contribution ids are namespaced by origin (ADR-0013): core keeps flat, bare
 * ids; third-party ids are auto-prefixed with the plugin's manifest `name`
 * (`example.<id>`). The built-in map is the sole authority for "core", so a
 * package borrowing an `@platypus/*` name but absent from the map is treated as
 * third-party and prefixed.
 */
export async function loadPlugins(
  opts: LoadPluginsOptions = {},
): Promise<LoadedPlugin[]> {
  const listedNames =
    opts.pluginNames ?? parsePluginList(process.env.PLATYPUS_PLUGINS);
  // The always-on core set is injected on the env-default path (production,
  // where `pluginNames` is unset). A caller that supplies an explicit
  // `pluginNames` also owns its always-on set — it defaults to none — so tests
  // and embedders load exactly what they pass unless they opt in via
  // `alwaysOnPlugins`.
  const alwaysOn =
    opts.alwaysOnPlugins ??
    (opts.pluginNames === undefined ? ALWAYS_ON_PLUGINS : []);

  // Always-on core plugins load unconditionally, so listing one in
  // PLATYPUS_PLUGINS is a misconfiguration — the list is not their enable switch.
  // Fail-loud (ADR-0013 amendment): a listed always-on name aborts boot rather
  // than double-loading (which would collide) or being silently ignored.
  for (const listed of listedNames) {
    if (alwaysOn.includes(listed)) {
      throw new Error(
        `Plugin "${listed}" is always-on (loaded unconditionally) and must not appear in PLATYPUS_PLUGINS. Remove it from the list.`,
      );
    }
  }

  // Compose the load order: the always-on core set first, then the Operator's
  // gate-able list. Duplicate ids across the combined set still fail-loud below.
  const names = [...alwaysOn, ...listedNames];
  const builtins = opts.builtinPlugins ?? BUILTIN_PLUGINS;
  const importPlugin =
    opts.importPlugin ??
    ((name: string) => import(name) as Promise<PluginModule>);
  const register = opts.register ?? registerToolSet;
  const registerSandbox = opts.registerSandbox ?? registerSandboxBackend;
  const pluginConfig =
    opts.pluginConfig ?? parsePluginConfig(process.env.PLATYPUS_PLUGIN_CONFIG);

  // Tracks contribution id -> owning plugin name for owner-attributed collisions.
  // Tool sets and Sandbox backends live in separate registries, so each keeps
  // its own owner map (a Tool set and a backend may share a bare id).
  const owners = new Map<string, string>();
  const sandboxOwners = new Map<string, string>();
  const loaded: LoadedPlugin[] = [];

  for (const name of names) {
    // The static built-in map IS the core allowlist and the SOLE authority for
    // "core" (ADR-0013): membership here — not the `@platypus/*` scope on the
    // package or the manifest name — decides origin. A package that borrows an
    // `@platypus/*` name but is absent from the map is third-party, so scope
    // impersonation cannot smuggle a package in as core.
    const isCore = Object.prototype.hasOwnProperty.call(builtins, name);
    const origin: LoadedPlugin["origin"] = isCore ? "core" : "third-party";

    let mod: PluginModule;
    try {
      mod = isCore ? await builtins[name]() : await importPlugin(name);
    } catch (cause) {
      throw new Error(
        `Plugin "${name}": failed to resolve (${
          cause instanceof Error ? cause.message : String(cause)
        }).`,
        { cause },
      );
    }

    const manifest = validateManifest(name, mod);

    // A third-party manifest name becomes the contribution-id prefix
    // (`${name}.${id}`), so it must be a clean, url-safe slug — no `.`, `/`, `@`,
    // or whitespace to muddle the `name.id` boundary or a URL path. Core plugins
    // are exempt: their `@platypus/*` names are logical ids reached through the
    // built-in map and never used as a prefix.
    if (!isCore && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name)) {
      throw new Error(
        `Plugin "${name}": third-party manifest name "${manifest.name}" must be a url-safe slug (lowercase letters, digits, and hyphens) — it becomes the contribution-id prefix. Rename it in the manifest.`,
      );
    }

    // Resolve the plugin's deploy-time config/credentials once (fail-loud) and
    // share the single block across every contribution factory below — this
    // object identity IS the "one credential block per plugin" of ADR-0013.
    const pluginCtx = resolvePluginConfig(
      manifest,
      pluginConfig[manifest.name] ?? {},
    );

    // Core Contributions keep their flat, bare ids (no data migration — every
    // persisted `agent.toolSetIds` / `sandbox.backend` reference keeps working).
    // Third-party Contributions are auto-namespaced by the plugin's manifest
    // `name` (`example.<id>`): authors write bare ids, core prefixes at load so a
    // third-party id can never collide with a current or future core built-in.
    const contributionId = (id: string): string =>
      isCore ? id : `${manifest.name}.${id}`;

    const toolSetIds: string[] = [];

    for (const contribution of manifest.contributes.toolSets ?? []) {
      const { id, name: tsName, category, description, tools } = contribution;
      const effectiveId = contributionId(id);

      const existingOwner = owners.get(effectiveId);
      if (existingOwner) {
        throw new Error(
          `Tool set id "${effectiveId}" is contributed by both "${existingOwner}" and "${manifest.name}".`,
        );
      }

      // Bind the shared plugin config into the factory so core's registry and
      // its Chat-turn callers stay ignorant of it: they invoke the stored
      // factory with only the ToolSetContext, as before. A static-map tool set
      // has no factory to inject into and is registered untouched.
      const boundTools =
        typeof tools === "function"
          ? (ctx: Parameters<typeof tools>[0]) => tools(ctx, pluginCtx)
          : tools;

      try {
        register(effectiveId, {
          name: tsName,
          category,
          description,
          tools: boundTools,
        });
      } catch (cause) {
        // A collision with a Tool set registered outside the loader (a legacy
        // static registration) surfaces here — re-throw with plugin attribution.
        throw new Error(
          `Plugin "${manifest.name}": failed to register tool set "${effectiveId}" (${
            cause instanceof Error ? cause.message : String(cause)
          }).`,
          { cause },
        );
      }

      owners.set(effectiveId, manifest.name);
      toolSetIds.push(effectiveId);
    }

    const sandboxBackendIds: string[] = [];

    for (const contribution of manifest.contributes.sandboxBackends ?? []) {
      const effectiveBackend = contributionId(contribution.backend);

      const existingOwner = sandboxOwners.get(effectiveBackend);
      if (existingOwner) {
        throw new Error(
          `Sandbox backend id "${effectiveBackend}" is contributed by both "${existingOwner}" and "${manifest.name}".`,
        );
      }

      // Bind the same shared plugin config into create() so core's per-turn
      // callers (chat resolution, teardown) keep calling create(config,
      // credentials) with the per-Workspace values only. Third-party backends
      // also register under the namespaced discriminator, so the
      // `sandbox.backend` column resolves to the prefixed id (mirroring tool sets).
      const boundContribution: SandboxBackendContribution = {
        ...contribution,
        backend: effectiveBackend,
        create: (config, credentials) =>
          contribution.create(config, credentials, pluginCtx),
      };

      try {
        registerSandbox(boundContribution);
      } catch (cause) {
        // A collision with a backend registered outside the loader surfaces
        // here — re-throw with plugin attribution.
        throw new Error(
          `Plugin "${manifest.name}": failed to register sandbox backend "${effectiveBackend}" (${
            cause instanceof Error ? cause.message : String(cause)
          }).`,
          { cause },
        );
      }

      sandboxOwners.set(effectiveBackend, manifest.name);
      sandboxBackendIds.push(effectiveBackend);
    }

    loaded.push({
      name: manifest.name,
      version: manifest.version,
      origin,
      toolSetIds,
      sandboxBackendIds,
    });
  }

  // Fail-loud (ADR-0013) on deploy-time config that targets no loaded plugin.
  // PLATYPUS_PLUGIN_CONFIG is keyed by manifest name; a key matching nothing is
  // almost always a typo or a plugin missing from PLATYPUS_PLUGINS — silently
  // dropping the block (so a credential never reaches its factory) is exactly the
  // kind of quiet misconfiguration the fail-loud boot posture exists to catch.
  const loadedNames = new Set(loaded.map((p) => p.name));
  for (const key of Object.keys(pluginConfig)) {
    if (!loadedNames.has(key)) {
      throw new Error(
        `PLATYPUS_PLUGIN_CONFIG has an entry for "${key}", but no loaded plugin has that name. Config is keyed by the plugin's manifest name — check for a typo, or a plugin missing from PLATYPUS_PLUGINS.`,
      );
    }
  }

  return loaded;
}
