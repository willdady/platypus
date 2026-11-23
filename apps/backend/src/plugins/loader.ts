import {
  OLDEST_SUPPORTED_API_VERSION,
  PLUGIN_API_VERSION,
  type PlatypusPlugin,
  type PluginConfigContext,
  type PluginLogger,
} from "@platypuschat/plugin-sdk";
import { MAX_PLUGIN_NAME_LENGTH } from "@platypus/schemas";
import { logger } from "../logger.ts";
import { ALWAYS_ON_PLUGINS, BUILTIN_PLUGINS } from "./builtin.ts";
import { registerToolSet, type ToolSetRegistration } from "../tools/index.ts";
import {
  registerSandboxBackend,
  type SandboxBackendRegistration,
} from "../sandbox/index.ts";
import {
  registerWebBackend,
  type WebBackendRegistration,
} from "../web-backends/index.ts";
import {
  registerToolGate,
  type ToolGateRegistration,
} from "../tool-gates/index.ts";
import {
  registerContributions,
  type ExtensionPoint,
} from "./contribution-pipeline.ts";
import {
  sandboxBackendPoint,
  toolGatePoint,
  toolSetPoint,
  webBackendPoint,
} from "./extension-points.ts";
import { errorMessage } from "../utils/error-message.ts";
import { isRecord } from "../utils/is-record.ts";

export interface LoadedPlugin {
  name: string;
  version: string;
  origin: "core" | "third-party";
  toolSetIds: string[];
  sandboxBackendIds: string[];
  webBackendIds: string[];
  toolGateIds: string[];
  config: unknown;
}

export interface ContributionOwners {
  toolSets: ReadonlyMap<string, string>;
  sandboxBackends: ReadonlyMap<string, string>;
  webBackends: ReadonlyMap<string, string>;
  toolGates: ReadonlyMap<string, string>;
}

export interface LoadPluginsResult {
  plugins: LoadedPlugin[];
  owners: ContributionOwners;
}

type PluginModule = { plugin?: unknown };

interface LoaderExtensionPoint {
  contributions: (manifest: PlatypusPlugin) => readonly unknown[] | undefined;
  reportAs:
    "toolSetIds" | "sandboxBackendIds" | "webBackendIds" | "toolGateIds";
  point: ExtensionPoint;
  owners: Map<string, string>;
}

interface RawPluginConfig {
  config?: unknown;
  credentials?: unknown;
}

export interface PluginLoggerParent {
  child(bindings: Record<string, unknown>): PluginLogger;
}

export interface LoadPluginsOptions {
  pluginNames?: string[];
  alwaysOnPlugins?: readonly string[];
  builtinPlugins?: Record<string, () => Promise<PluginModule>>;
  importPlugin?: (name: string) => Promise<PluginModule>;
  register?: (id: string, registration: ToolSetRegistration) => void;
  registerSandbox?: (registration: SandboxBackendRegistration) => void;
  registerWeb?: (registration: WebBackendRegistration) => void;
  registerGate?: (registration: ToolGateRegistration) => void;
  env?: Record<string, string | undefined>;
  baseLogger?: PluginLoggerParent;
}

export const parsePluginList = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const parseJsonObject = (
  varName: string,
  raw: string,
  expected: string,
): object => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${varName} is not valid JSON (${errorMessage(cause)}).`, {
      cause,
    });
  }
  if (!isRecord(parsed)) {
    throw new Error(`${varName} must be a JSON object ${expected}.`);
  }
  return parsed;
};

const PER_PLUGIN_CONFIG_PREFIX = "PLATYPUS_PLUGIN_CONFIG_";

const pluginConfigVar = (manifestName: string): string =>
  PER_PLUGIN_CONFIG_PREFIX +
  manifestName
    .replace(/^@platypus\//, "")
    .toUpperCase()
    .replaceAll("-", "_");

const parsePerPluginConfig = (
  env: Record<string, string | undefined>,
): Map<string, RawPluginConfig> => {
  const map = new Map<string, RawPluginConfig>();
  for (const [varName, raw] of Object.entries(env)) {
    if (!varName.startsWith(PER_PLUGIN_CONFIG_PREFIX)) continue;
    const trimmed = (raw ?? "").trim();
    if (trimmed.length === 0) continue;
    const { config, credentials } = parseJsonObject(
      varName,
      trimmed,
      'with optional "config" / "credentials"',
    ) as RawPluginConfig;
    map.set(varName, { config, credentials });
  }
  return map;
};

const resolvePluginConfig = (
  manifest: PlatypusPlugin,
  raw: RawPluginConfig,
  baseLogger: PluginLoggerParent,
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
    logger: baseLogger.child({ plugin: manifest.name }),
  };
};

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
  if (
    contributes.webBackends !== undefined &&
    !Array.isArray(contributes.webBackends)
  ) {
    throw new Error(
      `Plugin "${name}": "contributes.webBackends" must be an array.`,
    );
  }
  if (
    contributes.toolGates !== undefined &&
    !Array.isArray(contributes.toolGates)
  ) {
    throw new Error(
      `Plugin "${name}": "contributes.toolGates" must be an array.`,
    );
  }
  return p as PlatypusPlugin;
};

export async function loadPlugins(
  opts: LoadPluginsOptions = {},
): Promise<LoadPluginsResult> {
  const listedNames =
    opts.pluginNames ?? parsePluginList(process.env.PLATYPUS_PLUGINS);
  const alwaysOn =
    opts.alwaysOnPlugins ??
    (opts.pluginNames === undefined ? ALWAYS_ON_PLUGINS : []);

  for (const listed of listedNames) {
    if (alwaysOn.includes(listed)) {
      throw new Error(
        `Plugin "${listed}" is always-on (loaded unconditionally) and must not appear in PLATYPUS_PLUGINS. Remove it from the list.`,
      );
    }
  }

  const names = [...alwaysOn, ...listedNames];
  const builtins = opts.builtinPlugins ?? BUILTIN_PLUGINS;
  const importPlugin =
    opts.importPlugin ??
    ((name: string) => import(name) as Promise<PluginModule>);
  const register = opts.register ?? registerToolSet;
  const registerSandbox = opts.registerSandbox ?? registerSandboxBackend;
  const registerWeb = opts.registerWeb ?? registerWebBackend;
  const registerGate = opts.registerGate ?? registerToolGate;
  const env = opts.env ?? process.env;
  if (env.PLATYPUS_PLUGIN_CONFIG?.trim()) {
    throw new Error(
      'PLATYPUS_PLUGIN_CONFIG is no longer supported. Move each of its keys into that plugin\'s own PLATYPUS_PLUGIN_CONFIG_<NAME> variable (the manifest name without "@platypus/", uppercased, with "-" as "_", e.g. PLATYPUS_PLUGIN_CONFIG_DOCKER), then unset PLATYPUS_PLUGIN_CONFIG.',
    );
  }
  const perPluginConfig = parsePerPluginConfig(env);
  const baseLogger = opts.baseLogger ?? logger;

  const toolSetOwners = new Map<string, string>();
  const sandboxOwners = new Map<string, string>();
  const webOwners = new Map<string, string>();
  const gateOwners = new Map<string, string>();

  const manifestNameOwners = new Map<string, string>();

  const configVarOwners = new Map<string, string>();

  const points: readonly LoaderExtensionPoint[] = [
    {
      contributions: (m) => m.contributes.toolSets,
      reportAs: "toolSetIds",
      point: toolSetPoint(register),
      owners: toolSetOwners,
    },
    {
      contributions: (m) => m.contributes.sandboxBackends,
      reportAs: "sandboxBackendIds",
      point: sandboxBackendPoint(registerSandbox),
      owners: sandboxOwners,
    },
    {
      contributions: (m) => m.contributes.webBackends,
      reportAs: "webBackendIds",
      point: webBackendPoint(registerWeb),
      owners: webOwners,
    },
    {
      contributions: (m) => m.contributes.toolGates,
      reportAs: "toolGateIds",
      point: toolGatePoint(registerGate),
      owners: gateOwners,
    },
  ];

  const loaded: LoadedPlugin[] = [];

  for (const name of names) {
    const isCore = Object.prototype.hasOwnProperty.call(builtins, name);
    const origin: LoadedPlugin["origin"] = isCore ? "core" : "third-party";

    let mod: PluginModule;
    try {
      const builtin = isCore ? builtins[name] : undefined;
      mod = builtin ? await builtin() : await importPlugin(name);
    } catch (cause) {
      throw new Error(
        `Plugin "${name}": failed to resolve (${errorMessage(cause)}).`,
        { cause },
      );
    }

    const manifest = validateManifest(name, mod);

    if (!isCore && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name)) {
      throw new Error(
        `Plugin "${name}": third-party manifest name "${manifest.name}" must be a url-safe slug (lowercase letters, digits, and hyphens) — it becomes the contribution-id prefix. Rename it in the manifest.`,
      );
    }

    if (!isCore && manifest.name.length > MAX_PLUGIN_NAME_LENGTH) {
      throw new Error(
        `Plugin "${name}": third-party manifest "name" is ${manifest.name.length} characters ("${manifest.name}"), over the cap of ${MAX_PLUGIN_NAME_LENGTH} characters — it becomes the namespace on every tool name this plugin contributes. Rename it in the manifest.`,
      );
    }

    const nameOwner = manifestNameOwners.get(manifest.name);
    if (nameOwner !== undefined) {
      throw new Error(
        nameOwner === name
          ? `Plugin "${name}" is listed more than once in PLATYPUS_PLUGINS. Remove the duplicate entry.`
          : `Manifest name "${manifest.name}" is declared by both "${nameOwner}" and "${name}". A manifest name is the key for a plugin's deploy-time config and credentials, so two plugins sharing one would be handed the same credential block. Rename one of them in its manifest.`,
      );
    }
    manifestNameOwners.set(manifest.name, name);

    const configVar = pluginConfigVar(manifest.name);
    const configVarOwner = configVarOwners.get(configVar);
    if (configVarOwner !== undefined) {
      throw new Error(
        `Plugins "${configVarOwner}" and "${manifest.name}" both read their deploy-time config from ${configVar}, so neither could be configured on its own. One is core and one is third-party; remove the third-party one from PLATYPUS_PLUGINS.`,
      );
    }
    configVarOwners.set(configVar, manifest.name);

    const pluginCtx = resolvePluginConfig(
      manifest,
      perPluginConfig.get(configVar) ?? {},
      baseLogger,
    );

    const contributionId = (id: string): string =>
      isCore ? id : `${manifest.name}.${id}`;

    const registeredIds: Record<LoaderExtensionPoint["reportAs"], string[]> = {
      toolSetIds: [],
      sandboxBackendIds: [],
      webBackendIds: [],
      toolGateIds: [],
    };
    for (const entry of points) {
      registeredIds[entry.reportAs] = registerContributions({
        point: entry.point,
        contributions: entry.contributions(manifest) ?? [],
        pluginName: manifest.name,
        plugin: pluginCtx,
        contributionId,
        isCore,
        owners: entry.owners,
      });
    }

    loaded.push({
      name: manifest.name,
      version: manifest.version,
      origin,
      ...registeredIds,
      config: pluginCtx.config,
    });
  }

  for (const varName of perPluginConfig.keys()) {
    if (!configVarOwners.has(varName)) {
      throw new Error(
        `${varName} is set, but no loaded plugin maps to it. The name is the plugin's manifest name uppercased with "-" as "_" (and "@platypus/" dropped) — check for a typo, or a plugin missing from PLATYPUS_PLUGINS.`,
      );
    }
  }

  return {
    plugins: loaded,
    owners: {
      toolSets: toolSetOwners,
      sandboxBackends: sandboxOwners,
      webBackends: webOwners,
      toolGates: gateOwners,
    },
  };
}
