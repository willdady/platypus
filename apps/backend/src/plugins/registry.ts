import type { LoadedPlugin } from "./loader.ts";

// Read-only observability store for the plugins loaded at boot (ADR-0013).
//
// `loadPlugins()` returns its result to the boot sequence; `index.ts` hands that
// result here once, after a successful, fail-loud load. From this single source
// the process serves the read-only `GET /plugins` catalog and annotates the
// existing catalogs (`GET /backends`, the Tools listing) with each
// contribution's originating plugin. There is deliberately no mutation path —
// enable/disable is deploy-time only (ADR-0013), so this module exposes setters
// for boot/tests and getters for request handlers, nothing more.

/**
 * Owner label for a Tool set (or Sandbox backend) that is a core built-in rather
 * than a plugin contribution — currently only the consumer-side `sandbox` Tool
 * set, which is a static registration (see `tools/index.ts`), not something any
 * plugin contributes. Catalogs annotate such entries with this so they read as
 * core/built-in instead of a blank/unknown owner (ADR-0013 observability).
 */
export const CORE_BUILTIN_OWNER = "core (built-in)";

let loadedPlugins: readonly LoadedPlugin[] = [];
let toolSetOwners = new Map<string, string>();
let sandboxBackendOwners = new Map<string, string>();
let pluginConfigs = new Map<string, unknown>();

/**
 * Record the plugins loaded at boot. Called once from the boot sequence after
 * {@link loadPlugins} succeeds; also used by tests to seed the catalog. Rebuilds
 * the id → plugin-name lookups used to annotate existing catalogs.
 */
export const setLoadedPlugins = (plugins: readonly LoadedPlugin[]): void => {
  loadedPlugins = plugins;
  toolSetOwners = new Map();
  sandboxBackendOwners = new Map();
  pluginConfigs = new Map();
  for (const p of plugins) {
    for (const id of p.toolSetIds) toolSetOwners.set(id, p.name);
    for (const id of p.sandboxBackendIds) sandboxBackendOwners.set(id, p.name);
    if (p.config !== undefined) pluginConfigs.set(p.name, p.config);
  }
};

/** The plugins loaded at boot, for the read-only `GET /plugins` catalog. */
export const getLoadedPlugins = (): readonly LoadedPlugin[] => loadedPlugins;

/**
 * The plugin that contributed a Tool set, or `undefined` when the id belongs to
 * no loaded plugin (e.g. the core-internal `sandbox` Tool set, which is a static
 * registration rather than a plugin contribution — see `tools/index.ts`).
 */
export const getToolSetPlugin = (toolSetId: string): string | undefined =>
  toolSetOwners.get(toolSetId);

/** The plugin that contributed a Sandbox backend, or `undefined` if none. */
export const getSandboxBackendPlugin = (backend: string): string | undefined =>
  sandboxBackendOwners.get(backend);

/**
 * A plugin's boot-resolved, Operator-owned deploy-time **config** (never
 * credentials), keyed by manifest name, or `undefined` when the plugin is not
 * loaded or declares no `configSchema`. Lets a request handler read a plugin's
 * resolved config without re-parsing the environment — e.g. the Docker
 * network-allowlist endpoint (ADR-0005/0013). Read-only, boot-populated.
 */
export const getPluginConfig = (name: string): unknown =>
  pluginConfigs.get(name);
