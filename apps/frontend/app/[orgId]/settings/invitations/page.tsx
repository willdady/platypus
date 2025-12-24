"use client";

import { useParams } from "next/navigation";
import { InvitationForm } from "@/components/invitation-form";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { type InvitationListItem, type Organisation } from "@platypus/schemas";
import { Button } from "@/components/ui/button";
import { Trash2, Mail } from "lucide-react";
import { toast } from "sonner";
import useSWR from "swr";
import { useAuth } from "@/components/auth-provider";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useState } from "react";

const OrgInvitationsPage = () => {
  const { user } = useAuth();
  const { orgId } = useParams<{ orgId: string }>();
  const backendUrl = useBackendUrl();
  const { data: orgData } = useSWR<Organisation>(
    backendUrl && user ? joinUrl(backendUrl, `/organisations/${orgId}`) : null,
    fetcher,
  );
  const { data, mutate, isLoading } = useSWR<{ results: InvitationListItem[] }>(
    backendUrl && user
      ? joinUrl(backendUrl, `/organisations/${orgId}/invitations`)
      : null,
    fetcher,
  );

  const [invitationToDelete, setInvitationToDelete] = useState<string | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    if (!invitationToDelete) return;

    setIsDeleting(true);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organisations/${orgId}/invitations/${invitationToDelete}`,
        ),
        { method: "DELETE", credentials: "include" },
      );
      if (response.ok) {
        toast.success("Invitation deleted");
        mutate();
        setInvitationToDelete(null);
      } else {
        toast.error("Failed to delete invitation");
      }
    } catch (error) {
      toast.error("Error deleting invitation");
    } finally {
      setIsDeleting(false);
    }
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
          Manage invitations for users to join workspaces in{" "}
          <span className="font-bold">
            {orgData?.name || "this organisation"}
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
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data?.results.map((invite) => (
                    <TableRow key={invite.id}>
                      <TableCell>{invite.email}</TableCell>
                      <TableCell>{invite.workspaceName}</TableCell>
                      <TableCell className="capitalize">
                        {invite.role}
                      </TableCell>
                      <TableCell>{getStatusBadge(invite.status)}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {format(new Date(invite.expiresAt), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell className="text-right">
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

      <Dialog
        open={!!invitationToDelete}
        onOpenChange={(open) => !open && setInvitationToDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Invitation</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this invitation? This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setInvitationToDelete(null)}
              disabled={isDeleting}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
              className="cursor-pointer"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default OrgInvitationsPage;
