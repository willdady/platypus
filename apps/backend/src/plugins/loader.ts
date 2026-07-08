import {
  OLDEST_SUPPORTED_API_VERSION,
  PLUGIN_API_VERSION,
  type PlatypusPlugin,
  type PluginConfigContext,
  type SandboxBackendContribution,
  type ToolSetContribution,
} from "@platypuschat/plugin-sdk";
import { BUILTIN_PLUGINS } from "./builtin.ts";
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
  if (typeof m.apiVersion !== "number" || !Number.isFinite(m.apiVersion)) {
    throw new Error(
      `Plugin "${name}": manifest "apiVersion" must be a number.`,
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
 * Load and register every plugin in the list. Runs before the HTTP server so
 * registries are populated by the time Chat turns resolve tools.
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
 */
export async function loadPlugins(
  opts: LoadPluginsOptions = {},
): Promise<LoadedPlugin[]> {
  const names =
    opts.pluginNames ?? parsePluginList(process.env.PLATYPUS_PLUGINS);
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

    // Resolve the plugin's deploy-time config/credentials once (fail-loud) and
    // share the single block across every contribution factory below — this
    // object identity IS the "one credential block per plugin" of ADR-0013.
    const pluginCtx = resolvePluginConfig(
      manifest,
      pluginConfig[manifest.name] ?? {},
    );

    const toolSetIds: string[] = [];

    for (const contribution of manifest.contributes.toolSets ?? []) {
      const { id, name: tsName, category, description, tools } = contribution;

      const existingOwner = owners.get(id);
      if (existingOwner) {
        throw new Error(
          `Tool set id "${id}" is contributed by both "${existingOwner}" and "${manifest.name}".`,
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
        register(id, {
          name: tsName,
          category,
          description,
          tools: boundTools,
        });
      } catch (cause) {
        // A collision with a Tool set registered outside the loader (a legacy
        // static registration) surfaces here — re-throw with plugin attribution.
        throw new Error(
          `Plugin "${manifest.name}": failed to register tool set "${id}" (${
            cause instanceof Error ? cause.message : String(cause)
          }).`,
          { cause },
        );
      }

      owners.set(id, manifest.name);
      toolSetIds.push(id);
    }

    const sandboxBackendIds: string[] = [];

    for (const contribution of manifest.contributes.sandboxBackends ?? []) {
      const { backend } = contribution;

      const existingOwner = sandboxOwners.get(backend);
      if (existingOwner) {
        throw new Error(
          `Sandbox backend id "${backend}" is contributed by both "${existingOwner}" and "${manifest.name}".`,
        );
      }

      // Bind the same shared plugin config into create() so core's per-turn
      // callers (chat resolution, teardown) keep calling create(config,
      // credentials) with the per-Workspace values only.
      const boundContribution: SandboxBackendContribution = {
        ...contribution,
        create: (config, credentials) =>
          contribution.create(config, credentials, pluginCtx),
      };

      try {
        registerSandbox(boundContribution);
      } catch (cause) {
        // A collision with a backend registered outside the loader surfaces
        // here — re-throw with plugin attribution.
        throw new Error(
          `Plugin "${manifest.name}": failed to register sandbox backend "${backend}" (${
            cause instanceof Error ? cause.message : String(cause)
          }).`,
          { cause },
        );
      }

      sandboxOwners.set(backend, manifest.name);
      sandboxBackendIds.push(backend);
    }

    loaded.push({
      name: manifest.name,
      version: manifest.version,
      origin,
      toolSetIds,
      sandboxBackendIds,
    });
  }

  return loaded;
}
