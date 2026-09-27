import type { z } from "zod";
import type { sandboxCreateSchema } from "@platypus/schemas";
import { getSandboxBackend } from "./index.ts";

// Validate adapter-specific config or credentials at write time when the
// backend is registered, so errors (e.g. a network outside the operator
// allowlist, an SSH sandbox saved without a private key) surface as an
// immediate 400 instead of silently degrading to "no sandbox tools" at
// chat-turn time. Returns the 400 message, or null when valid / backend not
// registered.
export const sandboxSchemaError = (
  backend: string,
  kind: "config" | "credentials",
  value: Record<string, unknown> | undefined,
): string | null => {
  const registration = getSandboxBackend(backend);
  if (!registration) return null;
  const schema =
    kind === "config"
      ? registration.configSchema
      : registration.credentialsSchema;
  const result = schema.safeParse(value ?? {});
  if (result.success) return null;
  return `Invalid sandbox ${kind}: ${result.error.issues.map((i) => i.message).join("; ")}`;
};

// The owner may never override an admin-set env key (ADR-0004 amendment).
// Returns the 400 message, or null when there is no overlap.
export const envCollisionError = (
  adminEnv: Record<string, string> | undefined,
  userEnv: Record<string, string> | undefined,
): string | null => {
  if (!adminEnv || !userEnv) return null;
  const adminKeys = new Set(Object.keys(adminEnv));
  const collisions = Object.keys(userEnv).filter((k) => adminKeys.has(k));
  if (collisions.length === 0) return null;
  return `userEnv may not override admin-managed keys: ${collisions.join(", ")}`;
};

/**
 * The write-time checks a new Sandbox must pass, shared by the Sandbox route
 * and Workspace creation. Returns the 400 message, or null when valid.
 */
export const sandboxCreateError = (
  data: Omit<z.infer<typeof sandboxCreateSchema>, "workspaceId">,
): string | null =>
  sandboxSchemaError(data.backend, "config", data.config) ??
  sandboxSchemaError(data.backend, "credentials", data.credentials) ??
  envCollisionError(data.adminEnv, data.userEnv);
