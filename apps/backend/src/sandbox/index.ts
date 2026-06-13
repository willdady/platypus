import type { SandboxBackendRegistration } from "./types.ts";

// Output bounds, fixed by Platypus and identical across all adapters. Adapters
// that can't honour these natively MUST truncate themselves and set the
// `truncated` flag in their response. See ADR-0002.
export const MAX_SHELL_OUTPUT_BYTES = 100_000;
export const MAX_READ_BYTES = 1_000_000;
export const MAX_LIST_ENTRIES = 1_000;

// shell.exec timeouts. The hard cap is enforced both by the input schema and
// by adapters; the default applies when the caller omits timeoutMs.
export const DEFAULT_SHELL_TIMEOUT_MS = 60_000;
export const MAX_SHELL_TIMEOUT_MS = 600_000;

// Workspace root inside every sandbox; relative paths from the model resolve
// against this. Adapters MUST mount or chroot their environment so this path
// is the user-visible root.
export const SANDBOX_WORKSPACE_ROOT = "/workspace";

// Stored at the erased (default `unknown`) parameterisation: the registry is
// heterogeneous and lookups hand back this same erased shape.
const SANDBOX_BACKEND_REGISTRY: Record<string, SandboxBackendRegistration> = {};

export const registerSandboxBackend = <TConfig, TCredentials>(
  registration: SandboxBackendRegistration<TConfig, TCredentials>,
): void => {
  if (registration.backend in SANDBOX_BACKEND_REGISTRY) {
    throw new Error(
      `Sandbox backend '${registration.backend}' has already been registered.`,
    );
  }
  SANDBOX_BACKEND_REGISTRY[registration.backend] = registration;
};

export const getSandboxBackend = (
  backend: string,
): SandboxBackendRegistration | undefined => SANDBOX_BACKEND_REGISTRY[backend];

export const getSandboxBackends =
  (): ReadonlyArray<SandboxBackendRegistration> =>
    Object.values(SANDBOX_BACKEND_REGISTRY);

export * from "./types.ts";
