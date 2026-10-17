"use client";

import { invitationLink } from "@/lib/routes";
import { useParams } from "next/navigation";
import { InvitationForm } from "@/components/invitation-form";
import { EmptyCard } from "@/components/empty-card";
import { organizationEntity, writeEntity } from "@/lib/api-write";
import {
  type InvitationListItem,
  type Organization,
  type Blueprint,
} from "@platypus/schemas";
import { Button } from "@/components/ui/button";
import { Trash2, Mail, Copy } from "lucide-react";
import { toast } from "sonner";
import { copyWithToast } from "@/lib/clipboard";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useScopedList } from "@/hooks/use-scoped-list";
import { formatDate } from "@/lib/format-date";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  BadgeSkeleton,
  IconButtonSkeleton,
  InlineSkeleton,
  LoadingRegion,
  SkeletonLine,
  TableSkeleton,
} from "@/components/list-skeletons";
import { useDeleteFlow } from "@/hooks/use-delete-flow";

const OrgInvitationsPage = () => {
  const { orgId } = useParams<{ orgId: string }>();
  const { data: orgData, isLoading: isLoadingOrg } = useScopedSWR<Organization>(
    organizationEntity(orgId),
    {},
  );
  const {
    data,
    results: invitations,
    mutate,
    isLoading,
  } = useScopedList<InvitationListItem>("invitations", { orgId });
  // Map blueprint id → name so the table can show what each invite provisions.
  const { results: blueprints } = useScopedList<Blueprint>("blueprints", {
    orgId,
  });
  const blueprintNameById = new Map(blueprints.map((b) => [b.id, b.name]));

  const invitationDelete = useDeleteFlow<string>({
    delete: (id, backendUrl) =>
      writeEntity(backendUrl, "invitations", { orgId }, { id }),
    mutate,
    onSuccess: () => toast.success("Invitation deleted"),
  });

  // Available for the whole time an Invitation is pending (#549, ADR-0019) --
  // once accepted/declined/expired the token no longer resolves to anything,
  // so there is nothing useful left to copy.
  const handleCopyLink = async (token: string) => {
    const link = invitationLink(window.location.origin, token);
    await copyWithToast(
      link,
      "Invitation link copied",
      "Could not copy the invitation link",
    );
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return <Badge variant="warning">Pending</Badge>;
      case "accepted":
        return <Badge variant="success">Accepted</Badge>;
      case "declined":
        return (
          <Badge
            variant="outline"
            className="border-destructive/30 bg-destructive/10 text-destructive"
          >
            Declined
          </Badge>
        );
      case "expired":
        return (
          <Badge variant="outline" className="bg-muted text-muted-foreground">
            Expired
          </Badge>
        );
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold mb-4">Invitations</h1>
        <p className="text-muted-foreground mb-6">
          Manage invitations for users to join{" "}
          {isLoadingOrg ? (
            <InlineSkeleton className="w-32" />
          ) : (
            <span className="font-bold">
              {orgData?.name || "this organization"}
            </span>
          )}
          .
        </p>
        <InvitationForm orgId={orgId} onSuccess={() => mutate()} />
      </div>

      <div>
        <h2 className="text-xl font-semibold mb-4">Sent Invitations</h2>
        {isLoading ? (
          <LoadingRegion label="Loading invitations">
            <TableSkeleton
              tableClassName="min-w-[600px]"
              columns={[
                { header: "Email", cell: <SkeletonLine className="w-44" /> },
                {
                  header: "Workspace",
                  cell: <SkeletonLine className="w-24" />,
                },
                {
                  header: "Blueprints",
                  cell: <SkeletonLine className="w-20" />,
                },
                { header: "Status", cell: <BadgeSkeleton /> },
                { header: "Expires", cell: <SkeletonLine className="w-20" /> },
                {
                  header: "Actions",
                  className: "text-right",
                  // Copy link + Delete, both ghost icon buttons.
                  cell: (
                    <div className="flex justify-end">
                      <IconButtonSkeleton />
                      <IconButtonSkeleton />
                    </div>
                  ),
                },
              ]}
            />
          </LoadingRegion>
        ) : data && invitations.length === 0 ? (
          <EmptyCard
            icon={<Mail />}
            title="No invitations sent yet"
            description="Invitations you send with the form above appear here until they're accepted."
          />
        ) : (
          <Table bordered className="min-w-[600px]">
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead>Blueprints</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((invite) => (
                <TableRow key={invite.id}>
                  <TableCell>{invite.email}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {invite.workspaceName || (
                      <span className="italic">Member&apos;s name</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {invite.blueprintIds && invite.blueprintIds.length > 0 ? (
                      invite.blueprintIds
                        .map((id) => blueprintNameById.get(id) ?? id)
                        .join(", ")
                    ) : (
                      <span className="italic">None</span>
                    )}
                  </TableCell>
                  <TableCell>{getStatusBadge(invite.status)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(invite.expiresAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {invite.status === "pending" && invite.token && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Copy invitation link"
                        title="Copy invitation link"
                        onClick={() => handleCopyLink(invite.token!)}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete invitation for ${invite.email}`}
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => invitationDelete.request(invite.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <ConfirmDialog
        open={invitationDelete.open}
        onOpenChange={(open) => !open && invitationDelete.close()}
        title="Delete Invitation"
        description="Are you sure you want to delete this invitation? This action cannot be undone."
        confirmLabel="Delete"
        loadingLabel="Deleting..."
        confirmVariant="destructive"
        onConfirm={invitationDelete.confirm}
        loading={invitationDelete.deleting}
        error={invitationDelete.error}
      />
    </div>
  );
};

export default OrgInvitationsPage;
