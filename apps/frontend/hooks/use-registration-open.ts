import useSWR from "swr";
import type { RegistrationAvailability } from "@platypus/schemas";
import { useBackendUrl } from "@/components/auth-provider";
import { fetcher, joinUrl } from "@/lib/utils";

/**
 * Whether the deployment accepts open sign-up (#550, ADR-0019), read from the
 * backend's unauthenticated `/registration` endpoint — the one authority, so
 * the Sign up link and the sign-up form can never disagree with what the
 * backend would accept. `undefined` until the answer arrives; callers offer
 * nothing in the meantime rather than a link that may turn out to be dead.
 */
export function useRegistrationOpen(): boolean | undefined {
  const backendUrl = useBackendUrl();
  const { data } = useSWR<RegistrationAvailability>(
    backendUrl ? joinUrl(backendUrl, "/registration") : null,
    fetcher,
  );
  return data?.open;
}
