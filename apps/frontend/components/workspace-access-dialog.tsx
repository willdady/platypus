"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useState } from "react";
import { type OrgMemberListItem, type Workspace } from "@platypus/schemas";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { fetcher, joinUrl } from "@/lib/utils";
import { toast } from "sonner";
import useSWR from "swr";
import { Loader2 } from "lucide-react";

interface WorkspaceAccessDialogProps {
  orgId: string;
  member: OrgMemberListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function WorkspaceAccessDialog({
  orgId,
  member,
  open,
  onOpenChange,
  onSuccess,
}: WorkspaceAccessDialogProps) {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const { data: workspacesData, isLoading: isLoadingWorkspaces } = useSWR<{
    results: Workspace[];
  }>(
    backendUrl && user
      ? joinUrl(backendUrl, `/organisations/${orgId}/workspaces`)
      : null,
    fetcher,
  );

  const [processingId, setProcessingId] = useState<string | null>(null);

  const handleToggleAccess = async (
    workspaceId: string,
    isChecked: boolean,
  ) => {
    setProcessingId(workspaceId);
    try {
      if (isChecked) {
        // Add to workspace
        const response = await fetch(
          joinUrl(
            backendUrl,
            `/organisations/${orgId}/members/${member.id}/workspaces`,
          ),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspaceId, role: "viewer" }),
            credentials: "include",
          },
        );
        if (response.ok) {
          toast.success("Added to workspace");
          onSuccess();
        } else {
          const data = await response.json();
          toast.error(data.message || "Failed to add to workspace");
        }
      } else {
        // Remove from workspace
        const response = await fetch(
          joinUrl(
            backendUrl,
            `/organisations/${orgId}/members/${member.id}/workspaces/${workspaceId}`,
          ),
          {
            method: "DELETE",
            credentials: "include",
          },
        );
        if (response.ok) {
          toast.success("Removed from workspace");
          onSuccess();
        } else {
          const data = await response.json();
          toast.error(data.message || "Failed to remove from workspace");
        }
      }
    } catch (error) {
      toast.error("Error updating workspace access");
    } finally {
      setProcessingId(null);
    }
  };

  const handleRoleChange = async (workspaceId: string, role: string) => {
    setProcessingId(workspaceId);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organisations/${orgId}/members/${member.id}/workspaces/${workspaceId}`,
        ),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role }),
          credentials: "include",
        },
      );
      if (response.ok) {
        toast.success("Workspace role updated");
        onSuccess();
      } else {
        const data = await response.json();
        toast.error(data.message || "Failed to update workspace role");
      }
    } catch (error) {
      toast.error("Error updating workspace role");
    } finally {
      setProcessingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Workspace Access - {member.user.name}</DialogTitle>
          <DialogDescription>
            Manage which workspaces this member can access and their role in
            each.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[50px]">Access</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead className="w-[150px]">Role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoadingWorkspaces ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ) : (
                workspacesData?.results.map((ws) => {
                  const membership = member.workspaces.find(
                    (m) => m.workspaceId === ws.id,
                  );
                  const isMember = !!membership;
                  const isProcessing = processingId === ws.id;

                  return (
                    <TableRow key={ws.id}>
                      <TableCell>
                        <Switch
                          checked={isMember}
                          onCheckedChange={(checked: boolean) =>
                            handleToggleAccess(ws.id, checked)
                          }
                          disabled={isProcessing}
                          className="cursor-pointer"
                        />
                      </TableCell>
                      <TableCell className="font-medium">{ws.name}</TableCell>
                      <TableCell>
                        <Select
                          value={membership?.role || "viewer"}
                          onValueChange={(role) =>
                            handleRoleChange(ws.id, role)
                          }
                          disabled={!isMember || isProcessing}
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">Admin</SelectItem>
                            <SelectItem value="editor">Editor</SelectItem>
                            <SelectItem value="viewer">Viewer</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex justify-end mt-4">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="cursor-pointer"
          >
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
