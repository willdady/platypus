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
  type DockerSandboxConfig,
  type DockerSandboxCredentials,
} from "./backend.ts";

// Core plugin: the Docker reference Sandbox backend (ADR-0003). Stands alone —
// an Operator would plausibly want to deny infra access in isolation (ADR-0013).
// Enable it by listing "@platypus/docker" in PLATYPUS_PLUGINS; omitting it
// leaves the backend unregistered (its opt-in posture, formerly the
// PLATYPUS_SANDBOX_DOCKER_ENABLED gate). The backend discriminator stays the
// unprefixed core id "docker", so existing `sandbox` rows resolve unchanged.
const dockerBackend: SandboxBackendContribution<
  DockerSandboxConfig,
  DockerSandboxCredentials
> = {
  backend: "docker",
  name: "Local Docker",
  // Factory form (ADR-0013): the per-Workspace config schema is derived from the
  // Operator's `allowedNetworks`, resolved by the loader against this plugin's
  // deploy-time config (below) at load time.
  configSchema: dockerSandboxConfigSchema,
  credentialsSchema: dockerSandboxCredentialsSchema,
  // The third argument is the plugin's deploy-time block, and it is forwarded
  // for the logger core bound to this manifest's name: the adapter writes its
  // image-pull and teardown lines through the same contract a third-party
  // plugin gets, not through a relative import of core's logger.
  create: (config, credentials, plugin) =>
    createDockerSandboxBackend(config, credentials, plugin),
};

export const plugin: PlatypusPlugin = {
  name: "@platypus/docker",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  // Plugin-level, Operator-owned config (ADR-0013): the network allowlist is
  // declared here as `allowedNetworks` and consumed via PLATYPUS_PLUGIN_CONFIG.
  // No credentialsSchema — Docker has no plugin-level secrets.
  configSchema: dockerPluginConfigSchema,
  contributes: {
    sandboxBackends: [dockerBackend],
  },
};
