import { joinUrl, parseValidationErrors } from "./utils";

/**
 * A write's target scope (ADR-0007): an Organization-level (Shared) resource,
 * or a resource inside one Workspace. Presence of `workspaceId` is what
 * distinguishes the two — there is deliberately no separate discriminant to
 * get out of sync with it.
 */
export type Scope =
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
 * won't let it skip a case, so the four failure modes this ticket exists to
 * stop callers from re-deriving from a raw status code can't be missed.
 */
export type WriteOutcome<TResult> =
  | {
      readonly outcome: "success";
      readonly data: TResult;
      /** SWR keys this write should invalidate — the caller still calls `mutate`. */
      readonly revalidateKeys: readonly string[];
    }
  | { readonly outcome: "notFound"; readonly message: string }
  | { readonly outcome: "locked"; readonly message: string }
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

const DEFAULT_MESSAGES = {
  notFound: "Not found",
  locked: "This resource is managed at the organization level",
  conflict: "This operation conflicts with an existing resource",
  invalid: "Validation failed",
  error: "Request failed",
} as const;

function scopedPath(entity: string, scope: Scope): string {
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

function errorMessage(body: unknown): string | undefined {
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

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: "include",
      ...(method !== "DELETE"
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          }
        : {}),
    });
  } catch {
    return { outcome: "error", message: "Network request failed" };
  }

  const body: unknown = await response.json().catch(() => null);

  if (response.ok) {
    const revalidateKeys =
      method === "PUT" ? [collectionUrl, url] : [collectionUrl];
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
        outcome: "locked",
        message: errorMessage(body) ?? DEFAULT_MESSAGES.locked,
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
