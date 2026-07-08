import type {
  PlatypusPlugin,
  SandboxBackendContribution,
} from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import {
  DockerSandboxBackend,
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
  configSchema: dockerSandboxConfigSchema,
  credentialsSchema: dockerSandboxCredentialsSchema,
  create: (config, credentials) =>
    new DockerSandboxBackend(config, credentials),
};

export const plugin: PlatypusPlugin = {
  name: "@platypus/docker",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  contributes: {
    sandboxBackends: [dockerBackend],
  },
};
