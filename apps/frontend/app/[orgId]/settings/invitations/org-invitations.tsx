"use client";

import { invitationLink } from "@/lib/routes";
import { useParams } from "next/navigation";
import { InvitationForm } from "@/components/invitation-form";
import { EmptyCard } from "@/components/empty-card";
import { writeEntity } from "@/lib/api-write";
import { type InvitationListItem, type Blueprint } from "@platypus/schemas";
import { Button } from "@/components/ui/button";
import { Trash2, Mail, Copy } from "lucide-react";
import { toast } from "sonner";
import { copyWithToast } from "@/lib/clipboard";
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
  SkeletonLine,
  TableSkeleton,
} from "@/components/list-skeletons";
import { TableList } from "@/components/table-list";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { OrganizationName } from "@/components/organization-name";
import { PageHeader } from "@/components/page-header";
import { SettingsSectionHeading } from "@/components/settings-section-heading";

function OrgInvitationsPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const {
    data,
    results: invitations,
    error,
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
    <div className="flex flex-col gap-8">
      <div>
        <PageHeader
          title="Invitations"
          description={
            <>
              Manage invitations for users to join{" "}
              <OrganizationName orgId={orgId} />.
            </>
          }
        />
        <InvitationForm orgId={orgId} onSuccess={() => mutate()} />
      </div>

      <div>
        <SettingsSectionHeading>Sent Invitations</SettingsSectionHeading>
        <TableList
          isLoading={isLoading}
          data={data}
          error={error}
          subject="invitations"
          skeleton={
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
          }
          empty={
            <EmptyCard
              icon={<Mail />}
              title="No invitations sent yet"
              description="Invitations you send with the form above appear here until they're accepted."
            />
          }
          isEmpty={invitations.length === 0}
          onRetry={() => mutate()}
        >
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
                    {invite.status === "pending" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Copy invitation link"
                        title="Copy invitation link"
                        onClick={() => handleCopyLink(invite.token)}
                      >
                        <Copy />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete invitation for ${invite.email}`}
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => invitationDelete.request(invite.id)}
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableList>
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
}

export default OrgInvitationsPage;
