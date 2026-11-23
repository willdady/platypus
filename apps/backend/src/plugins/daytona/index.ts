import type {
  PlatypusPlugin,
  SandboxBackendContribution,
} from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import {
  createDaytonaSandboxBackend,
  daytonaPluginConfigSchema,
  daytonaPluginCredentialsSchema,
  daytonaSandboxConfigSchema,
  daytonaSandboxCredentialsSchema,
  type DaytonaPluginConfig,
  type DaytonaPluginCredentials,
  type DaytonaSandboxConfig,
  type DaytonaSandboxCredentials,
} from "./backend.ts";

const daytonaBackend: SandboxBackendContribution<
  DaytonaSandboxConfig,
  DaytonaSandboxCredentials,
  DaytonaPluginConfig,
  DaytonaPluginCredentials
> = {
  backend: "daytona",
  name: "Daytona",
  configSchema: daytonaSandboxConfigSchema,
  credentialsSchema: daytonaSandboxCredentialsSchema,
  create: (_config, _credentials, plugin) =>
    createDaytonaSandboxBackend(plugin),
};

export const plugin: PlatypusPlugin<
  DaytonaPluginConfig,
  DaytonaPluginCredentials
> = {
  name: "@platypus/daytona",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  configSchema: daytonaPluginConfigSchema,
  credentialsSchema: daytonaPluginCredentialsSchema,
  contributes: {
    sandboxBackends: [daytonaBackend],
  },
};
