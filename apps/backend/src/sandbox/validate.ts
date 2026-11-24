import type { sandboxCreateSchema } from "@platypus/schemas";
import type { z } from "zod";
import { ValidationError } from "../errors.ts";
import { flattenIssues } from "../zod-issues.ts";
import { getSandboxBackend } from "./index.ts";

export const sandboxSchemaFailure = (
  backend: string,
  kind: "config" | "credentials",
  value: Record<string, unknown> | undefined,
): ValidationError | null => {
  const registration = getSandboxBackend(backend);
  if (!registration) return null;
  const schema =
    kind === "config"
      ? registration.configSchema
      : registration.credentialsSchema;
  const result = schema.safeParse(value ?? {});
  if (result.success) return null;
  const issues = flattenIssues(result.error.issues);
  return new ValidationError(
    `Invalid sandbox ${kind}: ${issues.map((issue) => issue.message).join("; ")}`,
    issues.map((issue) => ({
      path: [
        kind,
        ...issue.path.map((segment) =>
          typeof segment === "number" ? segment : String(segment),
        ),
      ],
      message: issue.message,
    })),
  );
};

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

export const envCollisionFailure = (
  adminEnv: Record<string, string> | undefined,
  userEnv: Record<string, string> | undefined,
): ValidationError | null => {
  const message = envCollisionError(adminEnv, userEnv);
  return message ? new ValidationError(message) : null;
};

export const sandboxCreateError = (
  data: Omit<z.infer<typeof sandboxCreateSchema>, "workspaceId">,
): ValidationError | null =>
  sandboxSchemaFailure(data.backend, "config", data.config) ??
  sandboxSchemaFailure(data.backend, "credentials", data.credentials) ??
  envCollisionFailure(data.adminEnv, data.userEnv);
