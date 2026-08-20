import useSWR, { type SWRConfiguration, type SWRResponse } from "swr";
import { useAuth } from "@/components/auth-provider";
import { useBackendUrl } from "@/app/client-context";
import { fetcher } from "@/lib/utils";
import { scopedUrl, type Scope } from "@/lib/api-write";

/**
 * A GET through the request module: the same base-URL-and-signed-in-user
 * gate and Organization-vs-Workspace path shape `writeEntity` already owns
 * for writes, resolved once instead of as a repeated
 * `backendUrl && user ? joinUrl(...) : null` at every read call site.
 * `scope: null` (rather than a boolean `enabled`) lets a caller withhold the
 * fetch for the same reason it can't yet name a scope — e.g. a dialog that
 * hasn't opened, or an id that hasn't resolved.
 */
export function useScopedSWR<T>(
  entity: string,
  scope: Scope | null,
  config?: SWRConfiguration<T>,
): SWRResponse<T> {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const key =
    backendUrl && user && scope ? scopedUrl(backendUrl, entity, scope) : null;
  return useSWR<T>(key, fetcher, config);
}
