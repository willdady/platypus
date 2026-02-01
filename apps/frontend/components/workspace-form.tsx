"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldError,
  FieldDescription,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { type Workspace } from "@platypus/schemas";
import { fetcher, parseValidationErrors, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import useSWR, { useSWRConfig } from "swr";

interface WorkspaceFormProps {
  classNames?: string;
  orgId: string;
  workspaceId?: string;
}

const WorkspaceForm = ({
  classNames,
  orgId,
  workspaceId,
}: WorkspaceFormProps) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const router = useRouter();
  const { mutate: globalMutate } = useSWRConfig();

  const { data: workspace, mutate } = useSWR<Workspace>(
    workspaceId && user
      ? joinUrl(backendUrl, `/organizations/${orgId}/workspaces/${workspaceId}`)
      : null,
    fetcher,
  );

  const [formData, setFormData] = useState({
    name: "",
    context: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (workspace) {
      setFormData({
        name: workspace.name,
        context: workspace.context || "",
      });
    }
  }, [workspace]);

  const handleChange = (
    e:
      | React.ChangeEvent<HTMLInputElement>
      | React.ChangeEvent<HTMLTextAreaElement>,
  ) => {
    const { id, value } = e.target;

    // Clear validation error for this field
    if (validationErrors[id]) {
      setValidationErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[id];
        return newErrors;
      });
    }

    setFormData((prevData) => ({
      ...prevData,
      [id]: value,
    }));
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setValidationErrors({});
    try {
      const url = workspaceId
        ? joinUrl(
            backendUrl,
            `/organizations/${orgId}/workspaces/${workspaceId}`,
          )
        : joinUrl(backendUrl, `/organizations/${orgId}/workspaces`);

      const method = workspaceId ? "PUT" : "POST";

      const payload = workspaceId
        ? { name: formData.name, context: formData.context || null }
        : {
            organizationId: orgId,
            name: formData.name,
            context: formData.context || null,
          };

      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        credentials: "include",
      });

      if (response.ok) {
        if (workspaceId) {
          toast.success("Workspace updated");
          mutate(); // Refresh the local cache
          globalMutate(
            joinUrl(backendUrl, `/organizations/${orgId}/workspaces`),
          );
          router.refresh();
        } else {
          const workspace = await response.json();
          toast.success("Workspace created");
          globalMutate(
            joinUrl(backendUrl, `/organizations/${orgId}/workspaces`),
          );
          router.push(`/${orgId}/workspace/${workspace.id}`);
        }
      } else {
        // Parse standardschema.dev validation errors
        const errorData = await response.json();
        setValidationErrors(parseValidationErrors(errorData));
        toast.error("Failed to save workspace");
      }
    } catch (error) {
      console.error("Error saving workspace:", error);
      toast.error("Error saving workspace");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!workspaceId) return;

    setIsDeleting(true);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}`,
        ),
        {
          method: "DELETE",
          credentials: "include",
        },
      );
      if (response.ok) {
        toast.success("Workspace deleted");
        window.location.href = `/${orgId}`;
      } else {
        toast.error("Failed to delete workspace");
        setIsDeleting(false);
        setIsDeleteDialogOpen(false);
      }
    } catch (error) {
      toast.error("Error deleting workspace");
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  return (
    <div className={classNames}>
      <FieldSet className="mb-6">
        <FieldGroup>
          <Field data-invalid={!!validationErrors.name}>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              placeholder="Workspace name"
              value={formData.name}
              onChange={handleChange}
              disabled={isSubmitting}
              aria-invalid={!!validationErrors.name}
              autoFocus
            />
            {validationErrors.name && (
              <FieldError>{validationErrors.name}</FieldError>
            )}
          </Field>

          <Field data-invalid={!!validationErrors.context}>
            <ExpandableTextarea
              id="context"
              label="Context"
              placeholder="Optional context for this workspace"
              value={formData.context}
              onChange={handleChange}
              disabled={isSubmitting}
              aria-invalid={!!validationErrors.context}
              className="!font-mono"
            />
            <FieldDescription>
              Additional context about this workspace included in all chats in
              this workspace
            </FieldDescription>
            {validationErrors.context && (
              <FieldError>{validationErrors.context}</FieldError>
            )}
          </Field>
        </FieldGroup>
      </FieldSet>

      <div className="flex gap-2">
        <Button
          onClick={handleSubmit}
          disabled={isSubmitting || Object.keys(validationErrors).length > 0}
        >
          {workspaceId ? "Update" : "Save"}
        </Button>

        {workspaceId && (
          <Button
            variant="outline"
            onClick={() => {
              setIsDeleteDialogOpen(true);
              setDeleteInput("");
            }}
            disabled={isSubmitting}
          >
            <Trash2 /> Delete
          </Button>
        )}
      </div>

      <Dialog
        open={isDeleteDialogOpen}
        onOpenChange={(open) => {
          if (!isDeleting) {
            setIsDeleteDialogOpen(open);
          }
        }}
      >
        <DialogContent
          onPointerDownOutside={(e) => {
            if (isDeleting) {
              e.preventDefault();
            }
          }}
          onEscapeKeyDown={(e) => {
            if (isDeleting) {
              e.preventDefault();
            }
          }}
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle>Delete Workspace</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this workspace? This action cannot
              be undone.
            </DialogDescription>
            <div className="mt-4">
              <Input
                placeholder="Type 'Delete workspace' to confirm"
                value={deleteInput}
                onChange={(e) => setDeleteInput(e.target.value)}
                disabled={isDeleting}
              />
            </div>
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
              disabled={
                isDeleting || deleteInput.toLowerCase() !== "delete workspace"
              }
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export { WorkspaceForm };
