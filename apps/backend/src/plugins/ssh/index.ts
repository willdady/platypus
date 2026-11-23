import type {
  PlatypusPlugin,
  SandboxBackendContribution,
} from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import {
  createSshSandboxBackend,
  sshSandboxConfigSchema,
  sshSandboxCredentialsSchema,
  type SshSandboxConfig,
  type SshSandboxCredentials,
} from "./backend.ts";

const sshBackend: SandboxBackendContribution<
  SshSandboxConfig,
  SshSandboxCredentials
> = {
  backend: "ssh",
  name: "SSH (Remote Host)",
  configSchema: sshSandboxConfigSchema,
  credentialsSchema: sshSandboxCredentialsSchema,
  create: (config, credentials, plugin) =>
    createSshSandboxBackend(config, credentials, plugin),
};

export const plugin: PlatypusPlugin = {
  name: "@platypus/ssh",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  contributes: {
    sandboxBackends: [sshBackend],
  },
};
