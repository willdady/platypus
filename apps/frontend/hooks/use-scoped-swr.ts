import useSWR, {
  useSWRConfig,
  type SWRConfiguration,
  type SWRResponse,
} from "swr";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
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
 *
 * `config.fetcher` swaps the reader for one read — `optionalFetcher` for a row
 * that may not exist yet (issue #648). Absent one, every read keeps `fetcher`'s
 * contract, where any non-OK response is an error.
 *
 * While the session is still resolving there is no key yet, and SWR alone
 * would report `isLoading: false` with no data — which every caller reads as
 * "loaded, empty" (a blank editable form, a false empty state). A read the
 * caller wants (non-null `scope`) is therefore reported as loading until the
 * session settles. A signed-out user, or a caller-withheld `scope`, is not.
 * A value already cached under the key the read will get — a new Chat's row,
 * seeded `null` before it exists — is an answer, not a pending read, so it is
 * returned as loaded.
 */
export function useScopedSWR<T>(
  entity: string,
  scope: Scope | null,
  config?: SWRConfiguration<T>,
): SWRResponse<T> {
  const { user, isPending } = useAuth();
  const backendUrl = useBackendUrl();
  const { cache } = useSWRConfig();
  const pendingKey =
    backendUrl && scope ? scopedUrl(backendUrl, entity, scope) : null;
  const key = user ? pendingKey : null;
  const response = useSWR<T>(key, config?.fetcher ?? fetcher, config);
  if (!(pendingKey && !user && isPending)) return response;
  // Spreading reads every SWR getter, subscribing this caller to all of its
  // state — fine only here, where no key means nothing is loading anyway.
  const cached = cache.get(pendingKey)?.data as T | undefined;
  return cached === undefined
    ? { ...response, isLoading: true }
    : { ...response, data: cached, isLoading: false };
}
