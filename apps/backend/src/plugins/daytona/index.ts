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
  type DaytonaSandboxConfig,
  type DaytonaSandboxCredentials,
} from "./backend.ts";

// Core plugin: the Daytona hosted Sandbox backend. Gate-able — it sends
// Workspace commands and files to a third-party service (ADR-0013). Enable it
// by listing "@platypus/daytona" in PLATYPUS_PLUGINS and supplying the API key
// in PLATYPUS_PLUGIN_CONFIG_DAYTONA.
const daytonaBackend: SandboxBackendContribution<
  DaytonaSandboxConfig,
  DaytonaSandboxCredentials
> = {
  backend: "daytona",
  name: "Daytona",
  configSchema: daytonaSandboxConfigSchema,
  credentialsSchema: daytonaSandboxCredentialsSchema,
  // Per-Workspace config/credentials are empty; the adapter authenticates with
  // the deploy-time block, shared by every Workspace.
  create: (_config, _credentials, plugin) =>
    createDaytonaSandboxBackend(plugin),
};

export const plugin: PlatypusPlugin = {
  name: "@platypus/daytona",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  configSchema: daytonaPluginConfigSchema,
  credentialsSchema: daytonaPluginCredentialsSchema,
  contributes: {
    sandboxBackends: [daytonaBackend],
  },
};
