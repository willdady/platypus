import type {
  PlatypusPlugin,
  ToolSetContribution,
} from "@platypuschat/plugin-sdk";
import { BUILTIN_PLUGINS } from "./builtin.ts";
import { registerToolSet } from "../tools/index.ts";

// Summary of one loaded plugin, for the boot log line and observability.
export interface LoadedPlugin {
  name: string;
  version: string;
  origin: "core" | "third-party";
  toolSetIds: string[];
}

// A module that exports a plugin manifest. Values are `unknown` until validated.
type PluginModule = { plugin?: unknown };

export interface LoadPluginsOptions {
  /** Plugin names to load. Defaults to parsing `PLATYPUS_PLUGINS`. */
  pluginNames?: string[];
  /** The core allowlist / static built-in map. Defaults to {@link BUILTIN_PLUGINS}. */
  builtinPlugins?: Record<string, () => Promise<PluginModule>>;
  /** Resolves a third-party plugin. Defaults to dynamic `import()`. */
  importPlugin?: (name: string) => Promise<PluginModule>;
  /** Registers one Tool set contribution. Defaults to the core `registerToolSet`. */
  register?: (id: string, def: Omit<ToolSetContribution, "id">) => void;
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

// Validate an imported module's `plugin` export into a typed manifest, or throw
// a plugin-named error explaining why. Shape-only for this slice — apiVersion
// compatibility windowing lands in a follow-up.
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
  return p as PlatypusPlugin;
};

/**
 * Load and register every plugin in the list. Runs before the HTTP server so
 * registries are populated by the time Chat turns resolve tools.
 *
 * Boot is fail-loud and all-or-nothing (ADR-0013): a plugin that can't resolve,
 * has an invalid manifest, or collides with another aborts startup. Runtime
 * Chat-turn resolution stays graceful and is unaffected.
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

  // Tracks contribution id -> owning plugin name for owner-attributed collisions.
  const owners = new Map<string, string>();
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
        { cause: cause instanceof Error ? cause : undefined },
      );
    }

    const manifest = validateManifest(name, mod);
    const toolSetIds: string[] = [];

    for (const contribution of manifest.contributes.toolSets ?? []) {
      const { id, name: tsName, category, description, tools } = contribution;

      const existingOwner = owners.get(id);
      if (existingOwner) {
        throw new Error(
          `Tool set id "${id}" is contributed by both "${existingOwner}" and "${manifest.name}".`,
        );
      }

      try {
        register(id, { name: tsName, category, description, tools });
      } catch (cause) {
        // A collision with a Tool set registered outside the loader (a legacy
        // static registration) surfaces here — re-throw with plugin attribution.
        throw new Error(
          `Plugin "${manifest.name}": failed to register tool set "${id}" (${
            cause instanceof Error ? cause.message : String(cause)
          }).`,
          { cause: cause instanceof Error ? cause : undefined },
        );
      }

      owners.set(id, manifest.name);
      toolSetIds.push(id);
    }

    loaded.push({
      name: manifest.name,
      version: manifest.version,
      origin,
      toolSetIds,
    });
  }

  return loaded;
}
