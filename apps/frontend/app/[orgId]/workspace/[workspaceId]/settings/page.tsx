"use client";

import { Button } from "@/components/ui/button";
import { Copy, Trash2 } from "lucide-react";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useBackendUrl } from "@/app/client-context";

const WorkspaceSettingsPage = () => {
  const { orgId, workspaceId } = useParams<{
    orgId: string;
    workspaceId: string;
  }>();
  const backendUrl = useBackendUrl();

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");

  const handleDelete = async () => {
    try {
      const response = await fetch(`${backendUrl}/workspaces/${workspaceId}`, {
        method: "DELETE",
      });
      if (response.ok) {
        toast.success("Workspace deleted");
        window.location.href = `/${orgId}`;
      } else {
        toast.error("Failed to delete workspace");
      }
    } catch (error) {
      toast.error("Error deleting workspace");
    }
    setIsDeleteDialogOpen(false);
    setDeleteInput("");
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Workspace Settings</h1>
      <div className="grid grid-cols-2 gap-6">
        <div>
          <p className="text-sm text-muted-foreground mb-2">Organization ID</p>
          <div className="flex items-center justify-between">
            <p className="font-mono">{orgId}</p>
            <Button
              className="cursor-pointer text-muted-foreground"
              variant="ghost"
              size="icon"
              onClick={() => {
                navigator.clipboard.writeText(orgId);
                toast.info("Copied to clipboard");
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div>
          <p className="text-sm text-muted-foreground mb-2">Workspace ID</p>
          <div className="flex items-center justify-between">
            <p className="font-mono">{workspaceId}</p>
            <Button
              className="cursor-pointer text-muted-foreground"
              variant="ghost"
              size="icon"
              onClick={() => {
                navigator.clipboard.writeText(workspaceId);
                toast.info("Copied to clipboard");
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
      <div className="mt-6">
        <Button
          className="cursor-pointer"
          variant="outline"
          onClick={() => {
            setIsDeleteDialogOpen(true);
            setDeleteInput("");
          }}
        >
          <Trash2 /> Delete
        </Button>
      </div>
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete Workspace</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this workspace? This action cannot
              be undone.
              <div className="mt-4">
                <Input
                  placeholder="Type 'Delete workspace' to confirm"
                  value={deleteInput}
                  onChange={(e) => setDeleteInput(e.target.value)}
                />
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              className="cursor-pointer"
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              className="cursor-pointer"
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteInput.toLowerCase() !== "delete workspace"}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default WorkspaceSettingsPage;
