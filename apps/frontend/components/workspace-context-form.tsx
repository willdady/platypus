"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldGroup, FieldSet } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import useSWR from "swr";
import { Trash2 } from "lucide-react";
import type { Organization, Workspace, Context } from "@platypus/schemas";

interface WorkspaceWithOrg extends Workspace {
  organizationName?: string;
}

export const WorkspaceContextForm = ({ contextId }: { contextId?: string }) => {
  const router = useRouter();
  const backendUrl = useBackendUrl();
  const { user } = useAuth();

  const [formData, setFormData] = useState({
    content: "",
    workspaceId: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Fetch existing context if editing
  const { data: contextData } = useSWR<Context>(
    contextId && user
      ? joinUrl(backendUrl, `/users/me/contexts/${contextId}`)
      : null,
    fetcher,
  );

  // Fetch organizations
  const { data: orgs } = useSWR<{ results: Organization[] }>(
    user ? joinUrl(backendUrl, "/organizations") : null,
    fetcher,
  );

  // Fetch all contexts to filter out workspaces that already have contexts
  const { data: allContexts } = useSWR<{ results: Context[] }>(
    user ? joinUrl(backendUrl, "/users/me/contexts") : null,
    fetcher,
  );

  // Fetch workspaces for all orgs
  const [workspaces, setWorkspaces] = useState<WorkspaceWithOrg[]>([]);

  useEffect(() => {
    if (!orgs?.results || !backendUrl) return;

    const fetchWorkspaces = async () => {
      const allWorkspaces: WorkspaceWithOrg[] = [];

      for (const org of orgs.results) {
        try {
          const response = await fetch(
            joinUrl(backendUrl, `/organizations/${org.id}/workspaces`),
            { credentials: "include" },
          );
          if (response.ok) {
            const data = await response.json();
            const orgWorkspaces = data.results.map((w: Workspace) => ({
              ...w,
              organizationName: org.name,
            }));
            allWorkspaces.push(...orgWorkspaces);
          }
        } catch (error) {
          console.error(`Failed to fetch workspaces for org ${org.id}:`, error);
        }
      }

      setWorkspaces(allWorkspaces);
    };

    fetchWorkspaces();
  }, [orgs, backendUrl]);

  // Set form data when editing
  useEffect(() => {
    if (contextData) {
      setFormData({
        content: contextData.content,
        workspaceId: contextData.workspaceId || "",
      });
    }
  }, [contextData]);

  // Filter out workspaces that already have contexts (unless we're editing that context)
  const existingWorkspaceIds = new Set(
    allContexts?.results
      .filter((c) => c.workspaceId && c.id !== contextId)
      .map((c) => c.workspaceId) || [],
  );
  const availableWorkspaces = workspaces.filter(
    (w) => !existingWorkspaceIds.has(w.id),
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.workspaceId) {
      toast.error("Please select a workspace");
      return;
    }

    setIsSubmitting(true);

    try {
      if (contextId) {
        // Update existing context (workspaceId cannot be changed)
        const response = await fetch(
          joinUrl(backendUrl, `/users/me/contexts/${contextId}`),
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: formData.content }),
            credentials: "include",
          },
        );

        if (response.ok) {
          toast.success("Workspace context updated");
          router.push("/settings/contexts");
        } else {
          toast.error("Failed to update context");
        }
      } else {
        // Create new context
        const response = await fetch(
          joinUrl(backendUrl, "/users/me/contexts"),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: formData.content,
              workspaceId: formData.workspaceId,
            }),
            credentials: "include",
          },
        );

        if (response.ok) {
          toast.success("Workspace context created");
          router.push("/settings/contexts");
        } else if (response.status === 409) {
          toast.error("This workspace already has a context");
        } else {
          toast.error("Failed to create context");
        }
      }
    } catch (error) {
      toast.error("Error saving context");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!contextId) return;

    setIsDeleting(true);
    try {
      const response = await fetch(
        joinUrl(backendUrl, `/users/me/contexts/${contextId}`),
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      if (response.ok) {
        toast.success("Context deleted");
        router.push("/settings/contexts");
      } else {
        toast.error("Failed to delete context");
      }
    } catch (error) {
      toast.error("Error deleting context");
    } finally {
      setIsDeleting(false);
    }
  };

  // Find the selected workspace name for display when editing
  const selectedWorkspace = workspaces.find(
    (w) => w.id === formData.workspaceId,
  );

  return (
    <form onSubmit={handleSubmit}>
      <FieldSet className="mb-6">
        <FieldGroup className="gap-4">
          {contextId ? (
            <>
              <Field>
                <FieldLabel>Organization</FieldLabel>
                <div className="text-sm font-medium">
                  {selectedWorkspace?.organizationName ||
                    "Unknown Organization"}
                </div>
              </Field>
              <Field>
                <FieldLabel>Workspace</FieldLabel>
                <div className="text-sm font-medium">
                  {selectedWorkspace?.name || "Unknown Workspace"}
                </div>
              </Field>
            </>
          ) : (
            <Field>
              <FieldLabel htmlFor="workspace">Workspace</FieldLabel>
              <Select
                value={formData.workspaceId}
                onValueChange={(value) =>
                  setFormData({ ...formData, workspaceId: value })
                }
              >
                <SelectTrigger className="cursor-pointer">
                  <SelectValue placeholder="Select workspace" />
                </SelectTrigger>
                <SelectContent>
                  {(() => {
                    // Group workspaces by organization
                    const groupedWorkspaces = availableWorkspaces.reduce(
                      (acc, workspace) => {
                        const orgName =
                          workspace.organizationName || "Unknown Organization";
                        if (!acc[orgName]) {
                          acc[orgName] = [];
                        }
                        acc[orgName].push(workspace);
                        return acc;
                      },
                      {} as Record<string, WorkspaceWithOrg[]>,
                    );

                    return Object.entries(groupedWorkspaces).map(
                      ([orgName, orgWorkspaces]) => (
                        <SelectGroup key={orgName}>
                          <SelectLabel>{orgName}</SelectLabel>
                          {orgWorkspaces.map((workspace) => (
                            <SelectItem
                              key={workspace.id}
                              value={workspace.id}
                              className="cursor-pointer"
                            >
                              {workspace.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ),
                    );
                  })()}
                </SelectContent>
              </Select>
            </Field>
          )}

          <Field>
            <ExpandableTextarea
              id="content"
              label="Content"
              placeholder="Enter project-specific context, team conventions, or workspace instructions..."
              value={formData.content}
              onChange={(e) =>
                setFormData({ ...formData, content: e.target.value })
              }
              className="!font-mono"
              maxLength={1000}
            />
          </Field>
        </FieldGroup>
      </FieldSet>

      <div className="flex gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {contextId ? "Update" : "Create"}
        </Button>
        {contextId && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setIsDeleteDialogOpen(true)}
            disabled={isSubmitting}
          >
            <Trash2 className="w-4 h-4" />
            Delete
          </Button>
        )}
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
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
};
