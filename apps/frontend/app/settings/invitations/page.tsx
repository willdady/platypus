"use client";

import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { type InvitationListItem } from "@platypus/schemas";
import { Button } from "@/components/ui/button";
import { Mail, Check, X } from "lucide-react";
import { toast } from "sonner";
import useSWR from "swr";
import { useAuth } from "@/components/auth-provider";
import { format } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useState } from "react";

const UserInvitationsPage = () => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const { data, mutate, isLoading } = useSWR<{ results: InvitationListItem[] }>(
    backendUrl && user ? joinUrl(backendUrl, "/users/me/invitations") : null,
    fetcher,
  );

  const [invitationToDecline, setInvitationToDecline] = useState<string | null>(
    null,
  );
  const [isDeclining, setIsDeclining] = useState(false);

  const handleAccept = async (invitationId: string) => {
    try {
      const response = await fetch(
        joinUrl(backendUrl, `/users/me/invitations/${invitationId}/accept`),
        { method: "POST", credentials: "include" },
      );
      if (response.ok) {
        toast.success("Invitation accepted");
        mutate();
      } else {
        const errorData = await response.json();
        toast.error(errorData.message || "Failed to accept invitation");
      }
    } catch (error) {
      toast.error("Error accepting invitation");
    }
  };

  const handleDecline = async () => {
    if (!invitationToDecline) return;

    setIsDeclining(true);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/users/me/invitations/${invitationToDecline}/decline`,
        ),
        { method: "POST", credentials: "include" },
      );
      if (response.ok) {
        toast.success("Invitation declined");
        mutate();
        setInvitationToDecline(null);
      } else {
        toast.error("Failed to decline invitation");
      }
    } catch (error) {
      toast.error("Error declining invitation");
    } finally {
      setIsDeclining(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Invitations</h1>
      <p className="text-muted-foreground mb-8">
        Pending invitations to join organizations.
      </p>

      {isLoading ? (
        <p>Loading invitations...</p>
      ) : data?.results.length === 0 ? (
        <div className="text-center py-12 border border-dashed rounded-lg">
          <Mail className="mx-auto h-12 w-12 text-muted-foreground mb-4 opacity-50" />
          <p className="text-muted-foreground">No pending invitations.</p>
        </div>
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
                  <p>Invited by: {invite.invitedByName}</p>
                  <p>
                    Expires: {format(new Date(invite.expiresAt), "MMM d, yyyy")}
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="default"
                  className="flex-1 md:flex-none cursor-pointer"
                  onClick={() => handleAccept(invite.id)}
                >
                  <Check className="h-4 w-4" /> Accept
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 md:flex-none cursor-pointer"
                  onClick={() => setInvitationToDecline(invite.id)}
                >
                  <X className="h-4 w-4" /> Decline
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={!!invitationToDecline}
        onOpenChange={(open) => !open && setInvitationToDecline(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline Invitation</DialogTitle>
            <DialogDescription>
              Are you sure you want to decline this invitation?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setInvitationToDecline(null)}
              disabled={isDeclining}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDecline}
              disabled={isDeclining}
              className="cursor-pointer"
            >
              {isDeclining ? "Declining..." : "Decline"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default UserInvitationsPage;
