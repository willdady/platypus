import type {
  ContributionOwners,
  LoadedPlugin,
  LoadPluginsResult,
} from "./loader.ts";

export const CORE_BUILTIN_OWNER = "core (built-in)";

const NO_OWNERS: ContributionOwners = {
  toolSets: new Map(),
  sandboxBackends: new Map(),
  webBackends: new Map(),
  toolGates: new Map(),
};

let loadedPlugins: readonly LoadedPlugin[] = [];
let owners: ContributionOwners = NO_OWNERS;
let pluginConfigs = new Map<string, unknown>();

export const setLoadedPlugins = (result: LoadPluginsResult): void => {
  loadedPlugins = result.plugins;
  owners = result.owners;
  pluginConfigs = new Map();
  for (const p of result.plugins) pluginConfigs.set(p.name, p.config);
};

export const getLoadedPlugins = (): readonly LoadedPlugin[] => loadedPlugins;

export const getToolSetPlugin = (toolSetId: string): string | undefined =>
  owners.toolSets.get(toolSetId);

export const getSandboxBackendPlugin = (backend: string): string | undefined =>
  owners.sandboxBackends.get(backend);

export const getWebBackendPlugin = (backend: string): string | undefined =>
  owners.webBackends.get(backend);

export const getPluginConfig = <TConfig>(name: string): TConfig | undefined =>
  pluginConfigs.get(name) as TConfig | undefined;
