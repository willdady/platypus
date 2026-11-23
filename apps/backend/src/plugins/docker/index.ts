import type {
  PlatypusPlugin,
  SandboxBackendContribution,
} from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import {
  createDockerSandboxBackend,
  dockerPluginConfigSchema,
  dockerSandboxConfigSchema,
  dockerSandboxCredentialsSchema,
  type DockerPluginConfig,
  type DockerSandboxConfig,
  type DockerSandboxCredentials,
} from "./backend.ts";

const dockerBackend: SandboxBackendContribution<
  DockerSandboxConfig,
  DockerSandboxCredentials,
  DockerPluginConfig
> = {
  backend: "docker",
  name: "Local Docker",
  configSchema: dockerSandboxConfigSchema,
  credentialsSchema: dockerSandboxCredentialsSchema,
  create: (config, credentials, plugin) =>
    createDockerSandboxBackend(config, credentials, plugin),
};

export const plugin: PlatypusPlugin<DockerPluginConfig> = {
  name: "@platypus/docker",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  configSchema: dockerPluginConfigSchema,
  contributes: {
    sandboxBackends: [dockerBackend],
  },
};
