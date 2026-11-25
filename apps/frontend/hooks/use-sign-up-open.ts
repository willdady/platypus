import useSWR from "swr";
import type { SignUpAvailability } from "@platypus/schemas";
import { useBackendUrl } from "@/components/auth-provider";
import { joinUrl } from "@/lib/utils";
import type { Serialized } from "@/lib/api-write";

export function useSignUpOpen(): boolean | undefined {
  const backendUrl = useBackendUrl();
  // why: raw useSWR — read signed out, so a failure is no sign of an ended session
  const { data } = useSWR<Serialized<SignUpAvailability>>(
    backendUrl ? joinUrl(backendUrl, "/sign-up") : null,
    { onError: () => {} },
  );
  return data?.open;
}
