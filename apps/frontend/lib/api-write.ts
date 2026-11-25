import type { z } from "zod";
import type {
  a2aEndpointCreateSchema,
  a2aEndpointUpdateSchema,
  a2aTokenCreateSchema,
  agentCreateSchema,
  agentUpdateSchema,
  artifactCreateSchema,
  artifactUpdateSchema,
  attachmentCreateSchema,
  blueprintCreateSchema,
  blueprintUpdateSchema,
  chatUpdateSchema,
  contextCreateSchema,
  contextUpdateSchema,
  invitationCreateSchema,
  kanbanBoardCreateSchema,
  kanbanBoardUpdateSchema,
  mcpCreateSchema,
  mcpUpdateSchema,
  organizationCreateSchema,
  organizationMemberUpdateSchema,
  organizationUpdateSchema,
  providerCreateSchema,
  providerUpdateSchema,
  sandboxCreateSchema,
  sandboxUpdateSchema,
  skillCreateSchema,
  skillUpdateSchema,
  triggerCreateSchema,
  triggerUpdateSchema,
  webhookCreateSchema,
  webhookUpdateSchema,
  workspaceCreateSchema,
  workspaceUpdateSchema,
  AttachmentResourceType,
  PlatypusUIMessage,
} from "@platypus/schemas";
import { joinUrl } from "./utils";
import { parseValidationErrors } from "./form-errors";

// why: an entity absent here has no schema from which to type its body
type EntityRequestSchemas = {
  agents: {
    create: typeof agentCreateSchema;
    update: typeof agentUpdateSchema;
  };
  "a2a-endpoints": {
    create: typeof a2aEndpointCreateSchema;
    update: typeof a2aEndpointUpdateSchema;
  };
  artifacts: {
    create: typeof artifactCreateSchema;
    update: typeof artifactUpdateSchema;
  };
  attachments: { create: typeof attachmentCreateSchema };
  blueprints: {
    create: typeof blueprintCreateSchema;
    update: typeof blueprintUpdateSchema;
  };
  boards: {
    create: typeof kanbanBoardCreateSchema;
    update: typeof kanbanBoardUpdateSchema;
  };
  chat: { update: typeof chatUpdateSchema };
  invitations: { create: typeof invitationCreateSchema };
  mcps: { create: typeof mcpCreateSchema; update: typeof mcpUpdateSchema };
  members: { update: typeof organizationMemberUpdateSchema };
  organizations: {
    create: typeof organizationCreateSchema;
    update: typeof organizationUpdateSchema;
  };
  providers: {
    create: typeof providerCreateSchema;
    update: typeof providerUpdateSchema;
  };
  sandbox: {
    create: typeof sandboxCreateSchema;
    update: typeof sandboxUpdateSchema;
  };
  skills: {
    create: typeof skillCreateSchema;
    update: typeof skillUpdateSchema;
  };
  tokens: { create: typeof a2aTokenCreateSchema };
  triggers: {
    create: typeof triggerCreateSchema;
    update: typeof triggerUpdateSchema;
  };
  "users/me/contexts": {
    create: typeof contextCreateSchema;
    update: typeof contextUpdateSchema;
  };
  webhooks: {
    create: typeof webhookCreateSchema;
    update: typeof webhookUpdateSchema;
  };
  workspaces: {
    create: typeof workspaceCreateSchema;
    update: typeof workspaceUpdateSchema;
  };
};

export type EntityWithRequestSchemas = keyof EntityRequestSchemas;

type EntityBody<
  TEntity extends EntityWithRequestSchemas,
  TWrite extends "create" | "update",
> = TWrite extends keyof EntityRequestSchemas[TEntity]
  ? z.input<EntityRequestSchemas[TEntity][TWrite]>
  : never;

type EntityCreateData<TEntity extends string> =
  TEntity extends EntityWithRequestSchemas
    ? EntityBody<TEntity, "create">
    : unknown;

type EntityUpdateData<TEntity extends string> =
  TEntity extends EntityWithRequestSchemas
    ? EntityBody<TEntity, "update">
    : unknown;

export type EntityPayload<TEntity extends string> =
  EntityCreateData<TEntity> | EntityUpdateData<TEntity>;

export type Scope =
  | { readonly orgId?: undefined; readonly workspaceId?: undefined }
  | { readonly orgId: string; readonly workspaceId?: undefined }
  | { readonly orgId: string; readonly workspaceId: string };

export type WriteOptions<TEntity extends string = string> =
  string extends TEntity
    ? LooseWriteOptions
    : TEntity extends EntityWithRequestSchemas
      ? EntityWriteOptions<TEntity>
      : LooseWriteOptions;

type LooseWriteOptions = {
  readonly id?: string;
  readonly data?: unknown;
  readonly method?: "PUT" | "PATCH";
};

type EntityWriteOptions<TEntity extends EntityWithRequestSchemas> =
  | {
      readonly id?: undefined;
      readonly data?: EntityCreateData<TEntity>;
      readonly method?: "PUT" | "PATCH";
    }
  | {
      readonly id: string;
      readonly data?: EntityUpdateData<TEntity>;
      readonly method?: "PUT" | "PATCH";
    };

export type Serialized<T> = T extends Date
  ? string
  : T extends string | number | boolean
    ? T
    : // why: a UI message holds no Date and is too deep to map
      T extends PlatypusUIMessage
      ? T
      : T extends object
        ? { [K in keyof T]: Serialized<T[K]> }
        : T;

export type WriteOutcome<TResult> =
  | {
      readonly outcome: "success";
      readonly data: Serialized<TResult>;
      readonly revalidateKeys: readonly string[];
    }
  | { readonly outcome: "notFound"; readonly message: string }
  | { readonly outcome: "forbidden"; readonly message: string }
  | { readonly outcome: "conflict"; readonly message: string }
  | {
      readonly outcome: "invalid";
      readonly message: string;
      readonly fieldErrors: Record<string, string>;
      readonly files?: string[];
    }
  | {
      readonly outcome: "error";
      readonly message: string;
      readonly httpStatus?: number;
    };

export type FormDraft = {
  write: (payload: Record<string, unknown>) => Promise<WriteOutcome<undefined>>;
  onBack: () => void;
  submitText: string;
};

const DEFAULT_MESSAGES = {
  notFound: "Not found",
  forbidden: "You do not have permission to do this.",
  conflict: "This operation conflicts with an existing resource",
  invalid: "Validation failed",
  error: "Request failed",
} as const;

export function scopedPath(entity: string, scope: Scope): string {
  if (!scope.orgId) return `/${entity}`;
  return scope.workspaceId
    ? `/organizations/${scope.orgId}/workspaces/${scope.workspaceId}/${entity}`
    : `/organizations/${scope.orgId}/${entity}`;
}

export function scopedUrl(
  backendUrl: string,
  entity: string,
  scope: Scope,
): string {
  return joinUrl(backendUrl, scopedPath(entity, scope));
}

export const membershipEntity = "membership";

export function workspaceEntity(workspaceId: string): string {
  return `workspaces/${workspaceId}`;
}

export function organizationEntity(orgId: string): string {
  return `organizations/${orgId}`;
}

export function attachmentsEntity(
  resourceType: AttachmentResourceType,
  resourceId: string,
): string {
  const query = new URLSearchParams({ resourceType, resourceId });
  return `attachments?${query.toString()}`;
}

export type WorkspaceScope = Extract<Scope, { readonly workspaceId: string }>;

export async function attachResource(
  backendUrl: string,
  scope: WorkspaceScope,
  resourceType: AttachmentResourceType,
  resourceId: string,
): Promise<WriteOutcome<unknown>> {
  return writeEntity(backendUrl, "attachments", scope, {
    data: { resourceType, resourceId },
  });
}

export async function detachResource(
  backendUrl: string,
  scope: WorkspaceScope,
  resourceType: AttachmentResourceType,
  resourceId: string,
): Promise<WriteOutcome<unknown>> {
  return writeEntity(backendUrl, `attachments/${resourceType}`, scope, {
    id: resourceId,
  });
}

export function chatListEntity(params?: {
  readonly limit?: number;
  readonly search?: string;
}): string {
  const query = new URLSearchParams();
  if (params?.limit !== undefined) query.set("limit", String(params.limit));
  if (params?.search) query.set("search", params.search);
  const suffix = query.toString();
  return suffix ? `chat?${suffix}` : "chat";
}

export function triggerListEntity(params?: {
  readonly includeFired?: boolean;
}): string {
  return params?.includeFired ? "triggers?includeFired=true" : "triggers";
}

export function matchesCollection(
  key: unknown,
  backendUrl: string,
  entity: string,
  scope: Scope,
): boolean {
  return (
    typeof key === "string" &&
    key.startsWith(scopedUrl(backendUrl, entity, scope))
  );
}

export function errorMessage(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const { error } = body;
    if (typeof error === "string") return error;
  }
  return undefined;
}

function errorFiles(body: unknown): string[] | undefined {
  if (body && typeof body === "object" && "files" in body) {
    const { files } = body;
    if (Array.isArray(files) && files.every((f) => typeof f === "string")) {
      return files;
    }
  }
  return undefined;
}

async function performWrite<TResult, TData>(
  url: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  data: TData | undefined,
  revalidateKeys: readonly string[],
  extraHeaders?: Record<string, string>,
): Promise<WriteOutcome<TResult>> {
  const json = data !== undefined && !(data instanceof Blob);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: "include",
      headers: json
        ? { "Content-Type": "application/json", ...extraHeaders }
        : extraHeaders,
      body:
        data === undefined
          ? undefined
          : json
            ? JSON.stringify(data)
            : (data as Blob),
    });
  } catch {
    return { outcome: "error", message: "Network request failed" };
  }

  const body: unknown = await response.json().catch(() => null);

  if (response.ok) {
    return {
      outcome: "success",
      data: body as Serialized<TResult>,
      revalidateKeys,
    };
  }

  switch (response.status) {
    case 404:
      return {
        outcome: "notFound",
        message: errorMessage(body) ?? DEFAULT_MESSAGES.notFound,
      };
    case 403:
      return {
        outcome: "forbidden",
        message: errorMessage(body) ?? DEFAULT_MESSAGES.forbidden,
      };
    case 409:
      return {
        outcome: "conflict",
        message: errorMessage(body) ?? DEFAULT_MESSAGES.conflict,
      };
    case 400: {
      const fieldErrors = parseValidationErrors(body);
      const message =
        errorMessage(body) ??
        Object.values(fieldErrors)[0] ??
        DEFAULT_MESSAGES.invalid;
      const files = errorFiles(body);
      return {
        outcome: "invalid",
        message,
        fieldErrors,
        ...(files ? { files } : {}),
      };
    }
    default:
      return {
        outcome: "error",
        message:
          (errorMessage(body) ?? response.statusText) || DEFAULT_MESSAGES.error,
        httpStatus: response.status,
      };
  }
}

// why: entity first, or naming only TResult silently loses the body check
export async function writeEntity<
  TEntity extends string = string,
  TResult = unknown,
>(
  backendUrl: string,
  entity: TEntity,
  scope: Scope,
  options?: WriteOptions<TEntity>,
): Promise<WriteOutcome<TResult>> {
  const { id, data, method: updateMethod = "PUT" } = options ?? {};
  const method: "POST" | "PUT" | "PATCH" | "DELETE" =
    id === undefined ? "POST" : data === undefined ? "DELETE" : updateMethod;

  const path = scopedPath(entity, scope);
  const collectionUrl = joinUrl(backendUrl, path);
  const url =
    id === undefined ? collectionUrl : joinUrl(backendUrl, `${path}/${id}`);
  const revalidateKeys =
    method === "POST" || method === "DELETE"
      ? [collectionUrl]
      : [collectionUrl, url];

  return performWrite<TResult, unknown>(url, method, data, revalidateKeys);
}

export type WriteAtOptions<TData> = {
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
  readonly data?: TData;
  readonly revalidateKeys?: readonly string[];
  readonly headers?: Record<string, string>;
};

export async function writeAt<TResult = unknown, TData = unknown>(
  url: string,
  options: WriteAtOptions<TData>,
): Promise<WriteOutcome<TResult>> {
  const { method, data, revalidateKeys = [], headers } = options;
  return performWrite<TResult, TData>(
    url,
    method,
    data,
    revalidateKeys,
    headers,
  );
}
