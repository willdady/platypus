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

// Core plugin: the SSH reference Sandbox backend (ADR-0012). Attaches to a
// pre-existing, operator-owned host — the recommended backend for
// horizontally-scaled deployments where the Docker adapter cannot run (ADR-0003).
// Stands alone as a gate-able plugin: an Operator would plausibly want to deny
// remote-host access in isolation (ADR-0013). Enable it by listing
// "@platypus/ssh" in PLATYPUS_PLUGINS; omitting it leaves the backend
// unregistered (the same degradation as any absent backend — no
// PLATYPUS_SANDBOX_SSH_ENABLED gate). The discriminator stays the unprefixed
// core id "ssh".
const sshBackend: SandboxBackendContribution<
  SshSandboxConfig,
  SshSandboxCredentials
> = {
  backend: "ssh",
  name: "SSH (Remote Host)",
  configSchema: sshSandboxConfigSchema,
  credentialsSchema: sshSandboxCredentialsSchema,
  // The third argument is the plugin's deploy-time block, and it is forwarded
  // for the logger core bound to this manifest's name: the adapter's
  // unpinned-host-key warning (ADR-0012) goes out through the same contract a
  // third-party plugin gets, not through a relative import of core's logger.
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
