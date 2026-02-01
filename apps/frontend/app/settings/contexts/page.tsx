"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { type Context } from "@platypus/schemas";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Trash2, Globe, BookText } from "lucide-react";
import useSWR from "swr";
import { ContextsList } from "@/components/contexts-list";

interface ContextWithWorkspaceName extends Context {
  workspaceName?: string | null;
}

const ContextsPage = () => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const { data: contexts, mutate } = useSWR<{
    results: ContextWithWorkspaceName[];
  }>(user ? joinUrl(backendUrl, "/users/me/contexts") : null, fetcher);

  // Sync global context content to local state
  useEffect(() => {
    const globalCtx = contexts?.results.find((c) => !c.workspaceId);
    setGlobalContextContent(globalCtx?.content || "");
  }, [contexts]);

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [selectedContext, setSelectedContext] =
    useState<ContextWithWorkspaceName | null>(null);
  const [globalContextContent, setGlobalContextContent] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSavingGlobal, setIsSavingGlobal] = useState(false);

  const handleSaveGlobal = async () => {
    if (!globalContextContent.trim()) {
      toast.error("Content is required");
      return;
    }

    const globalCtx = contexts?.results.find((c) => !c.workspaceId);
    setIsSavingGlobal(true);

    try {
      if (globalCtx) {
        // Update existing global context
        const response = await fetch(
          joinUrl(backendUrl, `/users/me/contexts/${globalCtx.id}`),
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: globalContextContent }),
            credentials: "include",
          },
        );

        if (response.ok) {
          toast.success("Global context updated");
          mutate();
        } else {
          toast.error("Failed to update context");
        }
      } else {
        // Create new global context
        const response = await fetch(
          joinUrl(backendUrl, "/users/me/contexts"),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: globalContextContent,
              workspaceId: undefined,
            }),
            credentials: "include",
          },
        );

        if (response.ok) {
          toast.success("Global context created");
          mutate();
        } else if (response.status === 409) {
          toast.error("You already have a global context");
        } else {
          toast.error("Failed to create context");
        }
      }
    } catch (error) {
      toast.error("Error saving context");
    } finally {
      setIsSavingGlobal(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedContext) return;

    setIsSubmitting(true);
    try {
      const response = await fetch(
        joinUrl(backendUrl, `/users/me/contexts/${selectedContext.id}`),
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      if (response.ok) {
        toast.success("Context deleted");
        mutate();
        setIsDeleteDialogOpen(false);
        setSelectedContext(null);
      } else {
        toast.error("Failed to delete context");
      }
    } catch (error) {
      toast.error("Error deleting context");
    } finally {
      setIsSubmitting(false);
    }
  };

  const openDeleteDialog = (ctx: ContextWithWorkspaceName) => {
    setSelectedContext(ctx);
    setIsDeleteDialogOpen(true);
  };

  const globalContext = contexts?.results.find((c) => !c.workspaceId);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Contexts</h1>

      <div className="space-y-8">
        {/* Global Context Section */}
        <div>
          <div className="mb-4">
            <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
              <Globe className="w-5 h-5" />
              Global Context
            </h2>
            <p className="text-sm text-muted-foreground">
              Your global context applies across all workspaces and chats. Use
              it to provide personal information, preferences, or instructions
              that should always be available to the AI.
            </p>
          </div>
          <div className="space-y-3">
            <div className="border rounded-lg p-4 bg-muted/30">
              <div className="space-y-3">
                <ExpandableTextarea
                  id="global-context-edit"
                  label=""
                  placeholder="Enter context about yourself, your preferences, or general instructions..."
                  value={globalContextContent}
                  onChange={(e) => setGlobalContextContent(e.target.value)}
                  className="!font-mono"
                />
                <div className="flex items-center justify-between">
                  <Button onClick={handleSaveGlobal} disabled={isSavingGlobal}>
                    Save
                  </Button>
                  {globalContext && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => openDeleteDialog(globalContext)}
                    >
                      <Trash2 className="w-4 h-4" />
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Workspace Contexts Section */}
        <div>
          <div className="mb-4">
            <h2 className="text-lg font-semibold mb-2">Workspace Contexts</h2>
            <p className="text-sm text-muted-foreground">
              Similar to global context, workspace context is specific to a
              single workspace. Use them to provide information about yourself
              which should only apply when working in that workspace.
            </p>
          </div>
          <ContextsList />
        </div>
      </div>

      {/* Delete Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Context</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this context? This action cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isSubmitting}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ContextsPage;
