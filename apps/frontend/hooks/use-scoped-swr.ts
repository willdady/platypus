import useSWR, {
  useSWRConfig,
  type SWRConfiguration,
  type SWRResponse,
} from "swr";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { fetcher } from "@/lib/utils";
import { scopedUrl, type Scope, type Serialized } from "@/lib/api-write";

export function useScopedSWR<T>(
  entity: string,
  scope: Scope | null,
  config?: SWRConfiguration<Serialized<T>>,
): SWRResponse<Serialized<T>, unknown> {
  const { user, isPending } = useAuth();
  const backendUrl = useBackendUrl();
  const { cache } = useSWRConfig();
  const pendingKey =
    backendUrl && scope ? scopedUrl(backendUrl, entity, scope) : null;
  const key = user ? pendingKey : null;
  const response = useSWR<Serialized<T>, unknown>(
    key,
    config?.fetcher ?? fetcher,
    config,
  );
  if (!(pendingKey && !user && isPending)) return response;
  // why: spreading subscribes to every SWR getter, fine only here with no key
  const cached = cache.get(pendingKey)?.data as Serialized<T> | undefined;
  return cached === undefined
    ? { ...response, isLoading: true }
    : { ...response, data: cached, isLoading: false };
}
