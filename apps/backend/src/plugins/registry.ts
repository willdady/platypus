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

let loadedPlugins: readonly LoadedPlugin[] = [];
let toolSetOwners = new Map<string, string>();
let sandboxBackendOwners = new Map<string, string>();

/**
 * Record the plugins loaded at boot. Called once from the boot sequence after
 * {@link loadPlugins} succeeds; also used by tests to seed the catalog. Rebuilds
 * the id → plugin-name lookups used to annotate existing catalogs.
 */
export const setLoadedPlugins = (plugins: readonly LoadedPlugin[]): void => {
  loadedPlugins = plugins;
  toolSetOwners = new Map();
  sandboxBackendOwners = new Map();
  for (const p of plugins) {
    for (const id of p.toolSetIds) toolSetOwners.set(id, p.name);
    for (const id of p.sandboxBackendIds) sandboxBackendOwners.set(id, p.name);
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
