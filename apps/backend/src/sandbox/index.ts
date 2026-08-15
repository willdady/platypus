import { createContributionRegistry } from "../registry/contribution-registry.ts";
import type { SandboxBackendRegistration } from "./types.ts";

// Output bounds, fixed by Platypus and identical across all adapters (ADR-0002).
// An adapter built on `createPosixSandbox` gets these applied for it — core
// passes the caps down and sets `truncated` itself. One implementing
// `SandboxBackend` directly MUST truncate to them and set the flag on its own.
export const MAX_SHELL_OUTPUT_BYTES = 100_000;
export const MAX_READ_BYTES = 1_000_000;
export const MAX_LIST_ENTRIES = 1_000;

// Byte cap on the raw `find` output behind `fs.list`. Larger than
// MAX_SHELL_OUTPUT_BYTES because a recursive listing of up to MAX_LIST_ENTRIES
// rows legitimately exceeds the shell-output cap. This only bounds memory —
// truncation to MAX_LIST_ENTRIES is the authoritative limit.
export const MAX_LIST_OUTPUT_BYTES = 4 * 1024 * 1024;

// shell.exec timeouts. The input schema bounds what a model may ask for and
// `createPosixSandbox` clamps what an adapter will actually wait for; the
// default applies when the caller omits timeoutMs.
export const DEFAULT_SHELL_TIMEOUT_MS = 60_000;
export const MAX_SHELL_TIMEOUT_MS = 600_000;

// Workspace root inside every sandbox; relative paths from the model resolve
// against this. Adapters MUST mount or chroot their environment so this path
// is the user-visible root.
export const SANDBOX_WORKSPACE_ROOT = "/workspace";

// The Sandbox-backend instance of the shared Extension-point registry. Entries
// are stored at the erased (default `unknown`) parameterisation: the registry is
// heterogeneous and lookups hand back this same erased shape.
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

/** The backend registered under `backend`, or `undefined` if none is. */
export const getSandboxBackend = (
  backend: string,
): SandboxBackendRegistration | undefined => SANDBOX_BACKENDS.get(backend);

/** Every registered Sandbox backend, in registration order. */
export const getSandboxBackends =
  (): ReadonlyArray<SandboxBackendRegistration> => SANDBOX_BACKENDS.list();

/** Test-only reset — see {@link createContributionRegistry}. */
export const clearSandboxBackends = (): void => SANDBOX_BACKENDS.clear();

export * from "./types.ts";
