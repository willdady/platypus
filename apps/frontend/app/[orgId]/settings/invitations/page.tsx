"use client";

import { useParams } from "next/navigation";
import { InvitationForm } from "@/components/invitation-form";
import { organizationEntity, writeEntity } from "@/lib/api-write";
import {
  type InvitationListItem,
  type Organization,
  type Blueprint,
} from "@platypus/schemas";
import { Button } from "@/components/ui/button";
import { Trash2, Mail, Copy } from "lucide-react";
import { toast } from "sonner";
import { useBackendUrl } from "@/components/auth-provider";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
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
import { useState } from "react";

const OrgInvitationsPage = () => {
  const { orgId } = useParams<{ orgId: string }>();
  const backendUrl = useBackendUrl();
  const { data: orgData } = useScopedSWR<Organization>(
    organizationEntity(orgId),
    {},
  );
  const { data, mutate, isLoading } = useScopedSWR<{
    results: InvitationListItem[];
  }>("invitations", { orgId });
  // Map blueprint id → name so the table can show what each invite provisions.
  const { data: blueprintsData } = useScopedSWR<{ results: Blueprint[] }>(
    "blueprints",
    { orgId },
  );
  const blueprintNameById = new Map(
    (blueprintsData?.results ?? []).map((b) => [b.id, b.name]),
  );

  const [invitationToDelete, setInvitationToDelete] = useState<string | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);

  // Available for the whole time an Invitation is pending (#549, ADR-0019) --
  // once accepted/declined/expired the token no longer resolves to anything,
  // so there is nothing useful left to copy.
  const handleCopyLink = async (token: string) => {
    const link = `${window.location.origin}/invite/${token}`;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Invitation link copied");
    } catch {
      toast.error("Could not copy the invitation link");
    }
  };

  const handleDelete = async () => {
    if (!invitationToDelete) return;

    setIsDeleting(true);
    const outcome = await writeEntity(
      backendUrl,
      "invitations",
      { orgId },
      { id: invitationToDelete },
    );
    if (outcome.outcome === "success") {
      toast.success("Invitation deleted");
      mutate();
      setInvitationToDelete(null);
    } else {
      toast.error(outcome.message);
    }
    setIsDeleting(false);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return (
          <Badge
            variant="outline"
            className="bg-yellow-50 text-yellow-700 border-yellow-200"
          >
            Pending
          </Badge>
        );
      case "accepted":
        return (
          <Badge
            variant="outline"
            className="bg-green-50 text-green-700 border-green-200"
          >
            Accepted
          </Badge>
        );
      case "declined":
        return (
          <Badge
            variant="outline"
            className="bg-red-50 text-red-700 border-red-200"
          >
            Declined
          </Badge>
        );
      case "expired":
        return (
          <Badge
            variant="outline"
            className="bg-gray-50 text-gray-700 border-gray-200"
          >
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
          <span className="font-bold">
            {orgData?.name || "this organization"}
          </span>
          .
        </p>
        <InvitationForm orgId={orgId} onSuccess={() => mutate()} />
      </div>

      <div>
        <h2 className="text-xl font-semibold mb-4">Sent Invitations</h2>
        {isLoading ? (
          <p>Loading invitations...</p>
        ) : data?.results.length === 0 ? (
          <div className="text-center py-12 border border-dashed rounded-lg">
            <Mail className="mx-auto h-12 w-12 text-muted-foreground mb-4 opacity-50" />
            <p className="text-muted-foreground">No invitations sent yet.</p>
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <Table className="min-w-[600px]">
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
                  {data?.results.map((invite) => (
                    <TableRow key={invite.id}>
                      <TableCell>{invite.email}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {invite.workspaceName || (
                          <span className="italic">Member&apos;s name</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {invite.blueprintIds &&
                        invite.blueprintIds.length > 0 ? (
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
                            className="cursor-pointer"
                            title="Copy invitation link"
                            onClick={() => handleCopyLink(invite.token!)}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive hover:bg-destructive/10 cursor-pointer"
                          onClick={() => setInvitationToDelete(invite.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!invitationToDelete}
        onOpenChange={(open) => !open && setInvitationToDelete(null)}
        title="Delete Invitation"
        description="Are you sure you want to delete this invitation? This action cannot be undone."
        confirmLabel="Delete"
        loadingLabel="Deleting..."
        confirmVariant="destructive"
        onConfirm={handleDelete}
        loading={isDeleting}
      />
    </div>
  );
};

export default OrgInvitationsPage;
