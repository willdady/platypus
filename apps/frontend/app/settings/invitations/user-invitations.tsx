"use client";

import { joinUrl } from "@/lib/utils";
import { scopedUrl, writeAt } from "@/lib/api-write";
import { type InvitationListItem } from "@platypus/schemas";
import { Button } from "@/components/ui/button";
import { Mail, Check, X } from "lucide-react";
import { EmptyCard } from "@/components/empty-card";
import { toast } from "sonner";
import { useBackendUrl } from "@/components/auth-provider";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { formatDate } from "@/lib/format-date";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  ButtonSkeleton,
  LoadingRegion,
  SkeletonLine,
} from "@/components/list-skeletons";
import { useSWRConfig } from "swr";
import { useMutation } from "@/hooks/use-mutation";
import { useDeleteFlow } from "@/hooks/use-delete-flow";

const UserInvitationsPage = () => {
  const backendUrl = useBackendUrl();
  const { data, mutate, isLoading } = useScopedSWR<{
    results: InvitationListItem[];
  }>("users/me/invitations", {});

  const { mutate: globalMutate } = useSWRConfig();

  const accept = useMutation(async (invitationId: string) => {
    const result = await writeAt(
      joinUrl(backendUrl, `/users/me/invitations/${invitationId}/accept`),
      { method: "POST" },
    );
    if (result.outcome === "success") {
      toast.success("Invitation accepted");
      mutate();
      // The sidebar's Organization list now has one more.
      globalMutate(scopedUrl(backendUrl, "organizations", {}));
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
    onSuccess: () => toast.success("Invitation declined"),
  });

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Invitations</h1>
      <p className="text-muted-foreground mb-8">
        Pending invitations to join organizations.
      </p>

      {isLoading ? (
        <LoadingRegion label="Loading invitations" className="grid gap-4">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="p-4 border rounded-lg flex flex-col md:flex-row md:items-center justify-between gap-4 bg-card"
            >
              {/* Organization name, then invited-by and expiry. */}
              <div className="space-y-1">
                <SkeletonLine lineClassName="h-6" className="h-4 w-40" />
                <div className="space-y-1">
                  <SkeletonLine className="w-36" />
                  <SkeletonLine className="w-32" />
                </div>
              </div>
              <div className="flex gap-2">
                <ButtonSkeleton className="flex-1 md:flex-none md:w-24" />
                <ButtonSkeleton className="flex-1 md:flex-none md:w-24" />
              </div>
            </div>
          ))}
        </LoadingRegion>
      ) : data?.results.length === 0 ? (
        <EmptyCard
          icon={<Mail />}
          title="No pending invitations"
          description="Invitations to join an organization appear here."
        />
      ) : (
        <div className="grid gap-4">
          {data?.results.map((invite) => (
            <div
              key={invite.id}
              className="p-4 border rounded-lg flex flex-col md:flex-row md:items-center justify-between gap-4 bg-card"
            >
              <div className="space-y-1">
                <h3 className="font-semibold">{invite.organizationName}</h3>
                <div className="text-sm text-muted-foreground space-y-1">
                  {invite.invitedByName && (
                    <p>Invited by: {invite.invitedByName}</p>
                  )}
                  <p>Expires: {formatDate(invite.expiresAt)}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="default"
                  className="flex-1 md:flex-none cursor-pointer"
                  onClick={() => void accept.run(invite.id)}
                  disabled={accept.pending}
                >
                  <Check className="h-4 w-4" />{" "}
                  {accept.pending ? "Accepting..." : "Accept"}
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 md:flex-none cursor-pointer"
                  onClick={() => decline.request(invite.id)}
                >
                  <X className="h-4 w-4" /> Decline
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={decline.open}
        onOpenChange={(open) => !open && decline.close()}
        title="Decline Invitation"
        description="Are you sure you want to decline this invitation?"
        confirmLabel="Decline"
        loadingLabel="Declining..."
        onConfirm={decline.confirm}
        loading={decline.deleting}
        error={decline.error}
      />
    </div>
  );
};

export default UserInvitationsPage;
