import useSWR from "swr";
import type { SignUpAvailability } from "@platypus/schemas";
import { useBackendUrl } from "@/components/auth-provider";
import { joinUrl } from "@/lib/utils";
import type { Serialized } from "@/lib/api-write";

/**
 * Whether the deployment accepts public sign-up (#550, ADR-0019), read from
 * the backend's unauthenticated `/sign-up` endpoint — the one authority, so
 * the Sign up link and the sign-up form can never disagree with what the
 * backend would accept. `undefined` until the answer arrives; callers offer
 * nothing in the meantime rather than a link that may turn out to be dead.
 */
export function useSignUpOpen(): boolean | undefined {
  const backendUrl = useBackendUrl();
  // Raw `useSWR`, not `useScopedSWR`: read signed out, on the sign-in page —
  // so a failure here is no sign of an ended session.
  const { data } = useSWR<Serialized<SignUpAvailability>>(
    backendUrl ? joinUrl(backendUrl, "/sign-up") : null,
    { onError: () => {} },
  );
  return data?.open;
}
