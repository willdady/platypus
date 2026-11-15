"use client";

import { joinUrl } from "@/lib/utils";
import { scopedUrl, writeAt } from "@/lib/api-write";
import { type InvitationListItem } from "@platypus/schemas";
import { Button } from "@/components/ui/button";
import { Mail, Check, X } from "lucide-react";
import { EmptyCard } from "@/components/empty-card";
import { toast } from "sonner";
import { useBackendUrl } from "@/components/auth-provider";
import { useScopedList } from "@/hooks/use-scoped-list";
import { formatDate } from "@/lib/format-date";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EntityCardList } from "@/components/entity-card-list";
import {
  ButtonSkeleton,
  CardGridSkeleton,
  SkeletonLine,
} from "@/components/list-skeletons";
import { useSWRConfig } from "swr";
import { useMutation } from "@/hooks/use-mutation";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { PageHeader } from "@/components/page-header";

function UserInvitationsPage() {
  const backendUrl = useBackendUrl();
  const {
    data,
    results: invitations,
    error,
    mutate,
    isLoading,
  } = useScopedList<InvitationListItem>("users/me/invitations", {});

  const { mutate: globalMutate } = useSWRConfig();

  const accept = useMutation(async (invitationId: string) => {
    const result = await writeAt(
      joinUrl(backendUrl, `/users/me/invitations/${invitationId}/accept`),
      { method: "POST" },
    );
    if (result.outcome === "success") {
      toast.success("Invitation accepted");
      void mutate();
      // The sidebar's Organization list now has one more.
      void globalMutate(scopedUrl(backendUrl, "organizations", {}));
    } else {
      toast.error(result.message);
    }
  });

  const decline = useDeleteFlow<string>({
    delete: (invitationId, url) =>
      writeAt(joinUrl(url, `/users/me/invitations/${invitationId}/decline`), {
        method: "POST",
      }),
    mutate,
    onSuccess: () => {
      toast.success("Invitation declined");
    },
  });

  const cards = invitations.map((invite) => ({
    ...invite,
    name: invite.organizationName || "Unknown Organization",
    description: invite.invitedByName
      ? `Invited by: ${invite.invitedByName}`
      : undefined,
  }));

  return (
    <div>
      <PageHeader
        title="Invitations"
        description="Pending invitations to join organizations."
      />

      <EntityCardList
        singleColumn
        items={cards}
        isLoading={isLoading}
        error={error}
        data={data}
        subject="invitations"
        onRetry={() => void mutate()}
        skeleton={
          <CardGridSkeleton
            singleColumn
            extra={
              <SkeletonLine lineClassName="mt-1 h-4" className="h-3 w-32" />
            }
            actions={
              <div className="flex gap-2">
                <ButtonSkeleton className="w-24" />
                <ButtonSkeleton className="w-24" />
              </div>
            }
          />
        }
        empty={
          <EmptyCard
            icon={<Mail />}
            title="No pending invitations"
            description="Invitations to join an organization appear here."
          />
        }
        meta={(invite) => (
          <div className="mt-1 text-xs text-muted-foreground">
            Expires: {formatDate(invite.expiresAt)}
          </div>
        )}
        actions={(invite) => (
          <>
            <Button
              variant="default"
              className="flex-1 md:flex-none"
              onClick={() => void accept.run(invite.id)}
              disabled={accept.pending}
            >
              <Check /> {accept.pending ? "Accepting..." : "Accept"}
            </Button>
            <Button
              variant="outline"
              className="flex-1 md:flex-none"
              onClick={() => decline.request(invite.id)}
            >
              <X /> Decline
            </Button>
          </>
        )}
      />

      <ConfirmDialog
        title="Decline invitation"
        description="Are you sure you want to decline this invitation?"
        confirmLabel="Decline"
        loadingLabel="Declining..."
        {...decline.dialogProps}
      />
    </div>
  );
}

export default UserInvitationsPage;
