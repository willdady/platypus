import { createContributionRegistry } from "../registry/contribution-registry.ts";
import type { StreamCap } from "./transport.ts";
import type { SandboxBackendRegistration } from "./types.ts";

export const MAX_SHELL_OUTPUT_BYTES = 30_000;
export const SHELL_OUTPUT_HEAD_BYTES = 10_000;
export const SHELL_OUTPUT_TAIL_BYTES = 20_000;

export const SHELL_STREAM_CAP: StreamCap = {
  head: SHELL_OUTPUT_HEAD_BYTES,
  tail: SHELL_OUTPUT_TAIL_BYTES,
};

export const MAX_READ_BYTES = 1_000_000;
export const MAX_LIST_ENTRIES = 1_000;

export const MAX_DIAGNOSTIC_BYTES = 100_000;

export const MAX_LIST_OUTPUT_BYTES = 4 * 1024 * 1024;

export const DEFAULT_SHELL_TIMEOUT_MS = 60_000;
export const MAX_SHELL_TIMEOUT_MS = 600_000;

export const SANDBOX_WORKSPACE_ROOT = "/workspace";

const SANDBOX_BACKENDS = createContributionRegistry<SandboxBackendRegistration>(
  {
    noun: "Sandbox backend",
  },
);

export const registerSandboxBackend = <TConfig, TCredentials>(
  registration: SandboxBackendRegistration<TConfig, TCredentials>,
): void => {
  SANDBOX_BACKENDS.register(registration.backend, registration);
};

export const getSandboxBackend = (
  backend: string,
): SandboxBackendRegistration | undefined => SANDBOX_BACKENDS.get(backend);

export const getSandboxBackends =
  (): ReadonlyArray<SandboxBackendRegistration> => SANDBOX_BACKENDS.list();

export * from "./types.ts";
