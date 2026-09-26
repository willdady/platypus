import { joinUrl } from "./utils";
import { parseValidationErrors } from "./form-errors";

/**
 * A write's target scope (ADR-0007): an Organization-level (Shared) resource,
 * a resource inside one Workspace, or — when `orgId` itself is omitted — the
 * root `/organizations` collection, for writes to an Organization itself.
 * Presence of `workspaceId` is what distinguishes the scoped two — there is
 * deliberately no separate discriminant to get out of sync with it.
 */
export type Scope =
  | { readonly orgId?: undefined; readonly workspaceId?: undefined }
  | { readonly orgId: string; readonly workspaceId?: undefined }
  | { readonly orgId: string; readonly workspaceId: string };

export interface WriteOptions<TData> {
  /** Omit to create; provide to update or delete an existing entity. */
  readonly id?: string;
  /** Omit only when `id` is set and the write is a delete. */
  readonly data?: TData;
}

/**
 * The outcomes the backend's central `onError` (ADR-0010) can produce for a
 * write, plus the field-level shape `sValidator` returns for a 400 before it
 * ever reaches that seam. A caller destructures `outcome` and TypeScript
 * won't let it skip a case, so the five failure modes this ticket exists to
 * stop callers from re-deriving from a raw status code can't be missed.
 *
 * `forbidden` covers every 403, whether it's a `LockedError` (resource-state,
 * ADR-0010) or a middleware authorization refusal (ADR-0006) — the wire
 * envelope for both is `{ error: string }` with no field distinguishing them
 * (see ADR-0010's "Authorization is unchanged" note), so this outcome can't
 * claim to know which one occurred. Its default message stays neutral; a
 * backend message (locked or otherwise) always passes through unchanged.
 */
export type WriteOutcome<TResult> =
  | {
      readonly outcome: "success";
      readonly data: TResult;
      /** SWR keys this write should invalidate — the caller still calls `mutate`. */
      readonly revalidateKeys: readonly string[];
    }
  | { readonly outcome: "notFound"; readonly message: string }
  | { readonly outcome: "forbidden"; readonly message: string }
  | { readonly outcome: "conflict"; readonly message: string }
  | {
      readonly outcome: "invalid";
      readonly message: string;
      /** Dot-path keyed, same convention as `parseValidationErrors`. */
      readonly fieldErrors: Record<string, string>;
      /** Present only for a `FileValidationError` 400 — the offending files. */
      readonly files?: string[];
    }
  | {
      readonly outcome: "error";
      readonly message: string;
      readonly httpStatus?: number;
    };

/**
 * Hands a form's payload to `write` instead of saving it, for a form that is
 * one step of a larger write — the Workspace wizard collects a Provider and a
 * Sandbox and creates them with the Workspace. The outcome `write` returns is
 * shown on the form as a save's would be; success keeps the user on it.
 */
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

/**
 * The Organization-vs-Workspace path shape (ADR-0007), exported so a caller
 * resolves it once per component and reuses it for both the list's read and
 * every write, instead of re-deriving the branch at each call site.
 */
export function scopedPath(entity: string, scope: Scope): string {
  if (!scope.orgId) return `/${entity}`;
  return scope.workspaceId
    ? `/organizations/${scope.orgId}/workspaces/${scope.workspaceId}/${entity}`
    : `/organizations/${scope.orgId}/${entity}`;
}

/**
 * The read-side counterpart to `writeEntity`'s path resolution: the same
 * base URL and Organization-vs-Workspace path shape, for a caller that only
 * needs a key to fetch (typically as an SWR key via `useScopedSWR`) rather
 * than a full write outcome.
 */
export function scopedUrl(
  backendUrl: string,
  entity: string,
  scope: Scope,
): string {
  return joinUrl(backendUrl, scopedPath(entity, scope));
}

/**
 * The two rows the auth shell reads and pages reuse. Named here, beside the
 * path resolution they feed, so the provider's key and a page's key can't
 * drift onto two cache entries.
 */
export const membershipEntity = "membership";

export function workspaceEntity(workspaceId: string): string {
  return `workspaces/${workspaceId}`;
}

/**
 * One Organization row, read from the root `/organizations` collection — so
 * it pairs with the `{}` scope, not with `{ orgId }`, which would nest it
 * under the Organization it *is*.
 */
export function organizationEntity(orgId: string): string {
  return `organizations/${orgId}`;
}

/**
 * One Shared resource's attachment list, keyed by the query parameters that
 * select it. Four surfaces ask for it — the badge, the manage dialog, and the
 * pre-delete count check on each of the Agent and Skill lists — so the
 * spelling lives here rather than in each of them.
 */
export function attachmentsEntity(
  resourceType: string,
  resourceId: string,
): string {
  const query = new URLSearchParams({ resourceType, resourceId });
  return `attachments?${query.toString()}`;
}

/**
 * The chat list's key, with the query parameters the callers vary it by.
 * Defined here so the sidebar's searched-and-limited read, a page's unpaged
 * count, and the prefix `mutate` that revalidates every variant of it can't
 * drift onto different spellings of the same collection. Parameterless it is
 * exactly that prefix — hence the params appended in a fixed order.
 */
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

export function errorMessage(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const { error } = body as { error: unknown };
    if (typeof error === "string") return error;
  }
  return undefined;
}

function errorFiles(body: unknown): string[] | undefined {
  if (body && typeof body === "object" && "files" in body) {
    const { files } = body as { files: unknown };
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
  // A Blob (a picked File) is sent as the raw body, typed by the browser.
  const json = method !== "DELETE" && !(data instanceof Blob);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: "include",
      headers: json
        ? { "Content-Type": "application/json", ...extraHeaders }
        : extraHeaders,
      ...(method === "DELETE"
        ? {}
        : { body: data instanceof Blob ? data : JSON.stringify(data) }),
    });
  } catch {
    return { outcome: "error", message: "Network request failed" };
  }

  const body: unknown = await response.json().catch(() => null);

  if (response.ok) {
    return { outcome: "success", data: body as TResult, revalidateKeys };
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

/**
 * Owns a single write (create, update, or delete) to the Platypus API: the
 * base URL, the Organization-vs-Workspace path shape, credentials, the HTTP
 * method, and the outcome mapping that mirrors the backend's ADR-0010 error
 * seam. Callers pass `id`/`data` rather than a method: `id` absent means
 * create (POST), `id` present with `data` means update (PUT), `id` present
 * without `data` means delete (DELETE).
 */
export async function writeEntity<TResult = unknown, TData = unknown>(
  backendUrl: string,
  entity: string,
  scope: Scope,
  options: WriteOptions<TData> = {},
): Promise<WriteOutcome<TResult>> {
  const { id, data } = options;
  const method: "POST" | "PUT" | "DELETE" =
    id === undefined ? "POST" : data === undefined ? "DELETE" : "PUT";

  const path = scopedPath(entity, scope);
  const collectionUrl = joinUrl(backendUrl, path);
  const url =
    id === undefined ? collectionUrl : joinUrl(backendUrl, `${path}/${id}`);
  const revalidateKeys =
    method === "PUT" ? [collectionUrl, url] : [collectionUrl];

  return performWrite<TResult, TData>(url, method, data, revalidateKeys);
}

export interface WriteAtOptions<TData> {
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
  /** Omit only when the write is a DELETE. A `Blob` is sent as the raw body. */
  readonly data?: TData;
  /** SWR keys this write should invalidate. Defaults to none. */
  readonly revalidateKeys?: readonly string[];
  /**
   * Extra request headers, merged over the JSON `Content-Type`. For the
   * better-auth admin actions that must echo the browser's `Origin`.
   */
  readonly headers?: Record<string, string>;
}

/**
 * Same transport and ADR-0010 outcome mapping as `writeEntity`, for the
 * handful of writes that don't fit its Organization/Workspace scope (ADR-0007)
 * — a user-scoped resource, or a one-off action endpoint. The caller supplies
 * the full URL, so there's no scope or entity path to get out of sync with it.
 */
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
