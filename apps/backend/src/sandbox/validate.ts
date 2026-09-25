import type { z } from "zod";
import type { sandboxCreateSchema } from "@platypus/schemas";
import { getSandboxBackend } from "./index.ts";

// Validate adapter-specific config at write time when the backend is
// registered, so errors (e.g. a network outside the operator allowlist, a
// malformed extraHosts entry) surface as an immediate 400 instead of silently
// degrading to "no sandbox tools" at chat-turn time. Returns an error message
// string, or null when valid / backend not registered.
export const validateSandboxConfig = (
  backend: string,
  config: Record<string, unknown> | undefined,
): string | null => {
  const registration = getSandboxBackend(backend);
  if (!registration) return null;
  const result = registration.configSchema.safeParse(config ?? {});
  if (result.success) return null;
  return result.error.issues.map((i) => i.message).join("; ");
};

// Validate adapter-specific credentials at write time, same rationale as
// {@link validateSandboxConfig}: catch e.g. an SSH sandbox saved without a
// private key as an immediate 400 rather than a silent "no sandbox tools" at
// chat-turn time. Returns an error message, or null when valid / backend not
// registered. Callers pass `undefined` to skip (a PUT that preserves stored
// credentials, which GET never returns).
export const validateSandboxCredentials = (
  backend: string,
  credentials: Record<string, unknown> | undefined,
): string | null => {
  const registration = getSandboxBackend(backend);
  if (!registration) return null;
  const result = registration.credentialsSchema.safeParse(credentials ?? {});
  if (result.success) return null;
  return result.error.issues.map((i) => i.message).join("; ");
};

// The owner may never override an admin-set env key (ADR-0004 amendment).
// Returns the colliding keys, or [] when there is no overlap.
export const envCollisions = (
  adminEnv: Record<string, string> | undefined,
  userEnv: Record<string, string> | undefined,
): string[] => {
  if (!adminEnv || !userEnv) return [];
  const adminKeys = new Set(Object.keys(adminEnv));
  return Object.keys(userEnv).filter((k) => adminKeys.has(k));
};

/**
 * The write-time checks a new Sandbox must pass, shared by the Sandbox route
 * and Workspace creation. Returns the 400 message, or null when valid.
 */
export const sandboxCreateError = (
  data: Omit<z.infer<typeof sandboxCreateSchema>, "workspaceId">,
): string | null => {
  const configError = validateSandboxConfig(data.backend, data.config);
  if (configError) return `Invalid sandbox config: ${configError}`;

  const credentialsError = validateSandboxCredentials(
    data.backend,
    data.credentials,
  );
  if (credentialsError)
    return `Invalid sandbox credentials: ${credentialsError}`;

  const collisions = envCollisions(data.adminEnv, data.userEnv);
  if (collisions.length > 0) {
    return `userEnv may not override admin-managed keys: ${collisions.join(", ")}`;
  }
  return null;
};
