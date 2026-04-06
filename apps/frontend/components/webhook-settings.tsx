"use client";

import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { WebhookForm } from "@/components/webhook-form";

interface Webhook {
  id: string;
  workspaceId: string;
  url: string;
  signingSecret: string;
  headers: Record<string, string> | null;
  enabled: boolean;
  events: string[];
  createdAt: string;
  updatedAt: string;
}

export const WebhookSettings = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const {
    data: webhook,
    error,
    isLoading,
    mutate,
  } = useSWR<Webhook>(
    user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/webhook`,
        )
      : null,
    fetcher,
    {
      shouldRetryOnError: false,
    },
  );

  if (isLoading) {
    return <div>Loading...</div>;
  }

  const is404 = error && (error as any).status === 404;

  if (error && !is404) {
    return <div>Failed to load webhook settings.</div>;
  }

  return (
    <WebhookForm
      orgId={orgId}
      workspaceId={workspaceId}
      webhook={is404 ? undefined : webhook}
      onMutate={mutate}
    />
  );
};
