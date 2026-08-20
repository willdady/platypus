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
import { Switch } from "@/components/ui/switch";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
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
import { useState } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useRouter } from "next/navigation";
import { type Workspace, type Provider } from "@platypus/schemas";
import { fetcher, joinUrl } from "@/lib/utils";
import { canSubmitForm, retractFieldError } from "@/lib/form-errors";
import { writeEntity } from "@/lib/api-write";
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

// providerSelfManagement and mcpSelfManagement are deliberately excluded:
// this form has no field that retracts an error keyed to them.
const RETRACTABLE_FIELDS = [
  "name",
  "ownerId",
  "context",
  "taskModelProviderId",
  "memoryExtractionProviderId",
  "memoryEmbeddingProviderId",
  "maxDailySummaries",
] as const;

const WorkspaceForm = ({
  classNames,
  orgId,
  workspaceId,
}: WorkspaceFormProps) => {
  const { user, isOrgAdmin } = useAuth();
  const backendUrl = useBackendUrl();
  const router = useRouter();
  const { mutate: globalMutate } = useSWRConfig();

  const { data: workspace } = useSWR<Workspace>(
    workspaceId && user
      ? joinUrl(backendUrl, `/organizations/${orgId}/workspaces/${workspaceId}`)
      : null,
    fetcher,
  );

  // Fetch providers
  const { data: providersData } = useSWR<{ results: Provider[] }>(
    workspaceId && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/providers`,
        )
      : null,
    fetcher,
  );
  const providers = providersData?.results || [];

  // Org members, used to assign an owner when creating a workspace (ADR-0008).
  // Only admins can create workspaces and the members endpoint is admin-only.
  const { data: membersData } = useSWR<{
    results: { userId: string; user: { name: string; email: string } }[];
  }>(
    !workspaceId && user && isOrgAdmin
      ? joinUrl(backendUrl, `/organizations/${orgId}/members`)
      : null,
    fetcher,
  );
  const members = membersData?.results || [];

  // Owner options for the create form. A super-admin acting on an org they're
  // not enrolled in (e.g. a brand-new org with no members) won't appear in
  // /members, but the backend lets them own a workspace by defaulting to
  // themselves (ADR-0008). Always offer the current user so the "defaults to
  // you" default resolves to a real, selectable option.
  const ownerOptions =
    user && !members.some((m) => m.userId === user.id)
      ? [
          { userId: user.id, user: { name: user.name, email: user.email } },
          ...members,
        ]
      : members;

  const [formData, setFormData] = useState(() => ({
    name: "",
    context: "",
    // Default the owner to the current user when creating. The session is
    // usually cached, so `user` is available synchronously on first render;
    // the useResetOnChange below covers the case where it loads later.
    ownerId: (!workspaceId && user?.id) || ("" as string),
    taskModelProviderId: null as string | null,
    memoryExtractionProviderId: null as string | null,
    memoryEmbeddingProviderId: null as string | null,
    maxDailySummaries: 90,
    providerSelfManagement: false,
    mcpSelfManagement: false,
  }));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  // When creating, default the owner to the current admin until they pick
  // another member.
  useResetOnChange(`${workspaceId ?? ""}:${user?.id ?? ""}`, () => {
    if (!workspaceId && user) {
      setFormData((prev) =>
        prev.ownerId ? prev : { ...prev, ownerId: user.id },
      );
    }
  });

  useResetOnChange(workspace, () => {
    if (workspace) {
      setFormData({
        name: workspace.name,
        context: workspace.context || "",
        ownerId: workspace.ownerId,
        taskModelProviderId: workspace.taskModelProviderId || null,
        memoryExtractionProviderId:
          workspace.memoryExtractionProviderId || null,
        memoryEmbeddingProviderId: workspace.memoryEmbeddingProviderId || null,
        maxDailySummaries: workspace.maxDailySummaries ?? 90,
        providerSelfManagement: workspace.providerSelfManagement ?? false,
        mcpSelfManagement: workspace.mcpSelfManagement ?? false,
      });
    }
  });

  const handleChange = (
    e:
      | React.ChangeEvent<HTMLInputElement>
      | React.ChangeEvent<HTMLTextAreaElement>,
  ) => {
    const { id, value } = e.target;

    // Clear the error for this field, including any reported against a path
    // inside it.
    setValidationErrors((prev) => retractFieldError(prev, id));

    setFormData((prevData) => ({
      ...prevData,
      [id]: value,
    }));
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setValidationErrors({});

    const payload = workspaceId
      ? {
          name: formData.name,
          context: formData.context || null,
          taskModelProviderId: formData.taskModelProviderId,
          memoryExtractionProviderId: formData.memoryExtractionProviderId,
          memoryEmbeddingProviderId: formData.memoryEmbeddingProviderId,
          maxDailySummaries: formData.maxDailySummaries,
          // Admin-only; the backend strips these for non-admins (ADR-0006).
          providerSelfManagement: formData.providerSelfManagement,
          mcpSelfManagement: formData.mcpSelfManagement,
        }
      : {
          organizationId: orgId,
          name: formData.name,
          context: formData.context || null,
          // ADR-0008: an admin assigns the owner; defaults to themselves.
          ownerId: formData.ownerId || user?.id,
        };

    const result = await writeEntity<Workspace>(
      backendUrl,
      "workspaces",
      { orgId },
      { id: workspaceId, data: payload },
    );

    switch (result.outcome) {
      case "success":
        result.revalidateKeys.forEach((key) => globalMutate(key));
        if (workspaceId) {
          toast.success("Workspace updated");
          router.refresh();
        } else {
          toast.success("Workspace created");
          router.push(`/${orgId}/workspace/${result.data.id}`);
        }
        break;
      case "invalid":
        setValidationErrors(result.fieldErrors);
        if (Object.keys(result.fieldErrors).length === 0) {
          toast.error(result.message);
        }
        break;
      case "conflict":
        setValidationErrors({ name: result.message });
        break;
      case "locked":
      case "notFound":
      case "error":
        toast.error(result.message);
        break;
    }

    setIsSubmitting(false);
  };

  const handleDelete = async () => {
    if (!workspaceId) return;

    setIsDeleting(true);
    const result = await writeEntity(
      backendUrl,
      "workspaces",
      { orgId },
      { id: workspaceId },
    );

    if (result.outcome === "success") {
      result.revalidateKeys.forEach((key) => globalMutate(key));
      toast.success("Workspace deleted");
      window.location.href = `/${orgId}`;
    } else {
      toast.error(result.message);
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

          {/* ADR-0008: on creation an admin assigns the workspace owner. */}
          {!workspaceId && (
            <Field data-invalid={!!validationErrors.ownerId}>
              <FieldLabel htmlFor="ownerId">Owner</FieldLabel>
              <Select
                value={formData.ownerId || undefined}
                onValueChange={(value) => {
                  setValidationErrors((prev) =>
                    retractFieldError(prev, "ownerId"),
                  );
                  setFormData((prevData) => ({ ...prevData, ownerId: value }));
                }}
                disabled={isSubmitting}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select an owner" />
                </SelectTrigger>
                <SelectContent>
                  {ownerOptions.map((m) => (
                    <SelectItem key={m.userId} value={m.userId}>
                      {m.user.name || m.user.email}
                      {m.userId === user?.id ? " (you)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                The member who will own this workspace. Defaults to you.
              </FieldDescription>
              {validationErrors.ownerId && (
                <FieldError>{validationErrors.ownerId}</FieldError>
              )}
            </Field>
          )}

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
              maxLength={1000}
            />
            <FieldDescription>
              Additional context about this workspace included in all chats in
              this workspace
            </FieldDescription>
            {validationErrors.context && (
              <FieldError>{validationErrors.context}</FieldError>
            )}
          </Field>

          {workspaceId && (
            <Field data-invalid={!!validationErrors.taskModelProviderId}>
              <FieldLabel htmlFor="taskModelProviderId">
                Task Model Provider
              </FieldLabel>
              <Select
                value={formData.taskModelProviderId || "none"}
                onValueChange={(value) => {
                  setValidationErrors((prev) =>
                    retractFieldError(prev, "taskModelProviderId"),
                  );
                  setFormData((prevData) => ({
                    ...prevData,
                    taskModelProviderId: value === "none" ? null : value,
                  }));
                }}
                disabled={isSubmitting}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (use chat provider)</SelectItem>
                  {providers.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                Provider to use for generating chat titles and tags. If not set,
                each chat will use its own provider for metadata generation.
              </FieldDescription>
              {validationErrors.taskModelProviderId && (
                <FieldError>{validationErrors.taskModelProviderId}</FieldError>
              )}
            </Field>
          )}

          {workspaceId && (
            <Field data-invalid={!!validationErrors.memoryExtractionProviderId}>
              <FieldLabel htmlFor="memoryExtractionProviderId">
                Memory Extraction Provider
              </FieldLabel>
              <Select
                value={formData.memoryExtractionProviderId || "none"}
                onValueChange={(value) => {
                  setValidationErrors((prev) =>
                    retractFieldError(prev, "memoryExtractionProviderId"),
                  );
                  setFormData((prevData) => ({
                    ...prevData,
                    memoryExtractionProviderId: value === "none" ? null : value,
                  }));
                }}
                disabled={isSubmitting}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Disabled</SelectItem>
                  {providers
                    .filter((p) => p.memoryExtractionModelId)
                    .map((provider) => (
                      <SelectItem key={provider.id} value={provider.id}>
                        {provider.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                Provider to use for extracting memories from conversations.
                Enable memory extraction on a provider to see it here.
              </FieldDescription>
              {validationErrors.memoryExtractionProviderId && (
                <FieldError>
                  {validationErrors.memoryExtractionProviderId}
                </FieldError>
              )}
            </Field>
          )}

          {workspaceId && (
            <Field data-invalid={!!validationErrors.memoryEmbeddingProviderId}>
              <FieldLabel htmlFor="memoryEmbeddingProviderId">
                Memory Embedding Provider
              </FieldLabel>
              <Select
                value={formData.memoryEmbeddingProviderId || "none"}
                onValueChange={(value) => {
                  setValidationErrors((prev) =>
                    retractFieldError(prev, "memoryEmbeddingProviderId"),
                  );
                  setFormData((prevData) => ({
                    ...prevData,
                    memoryEmbeddingProviderId: value === "none" ? null : value,
                  }));
                }}
                disabled={isSubmitting}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Disabled</SelectItem>
                  {providers
                    .filter(
                      (p) =>
                        (p as { embeddingModelId?: string }).embeddingModelId,
                    )
                    .map((provider) => (
                      <SelectItem key={provider.id} value={provider.id}>
                        {provider.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                Provider to use for generating memory embeddings. Required for
                semantic memory search. Set an embedding model ID on a provider
                to see it here.
              </FieldDescription>
              {validationErrors.memoryEmbeddingProviderId && (
                <FieldError>
                  {validationErrors.memoryEmbeddingProviderId}
                </FieldError>
              )}
            </Field>
          )}

          {workspaceId && (
            <Field data-invalid={!!validationErrors.maxDailySummaries}>
              <FieldLabel htmlFor="maxDailySummaries">
                Memory Summary Retention
              </FieldLabel>
              <Input
                id="maxDailySummaries"
                type="number"
                min={7}
                max={365}
                value={formData.maxDailySummaries}
                onChange={(e) => {
                  setValidationErrors((prev) =>
                    retractFieldError(prev, "maxDailySummaries"),
                  );
                  setFormData((prevData) => ({
                    ...prevData,
                    maxDailySummaries: parseInt(e.target.value) || 90,
                  }));
                }}
                disabled={isSubmitting}
                aria-invalid={!!validationErrors.maxDailySummaries}
              />
              <FieldDescription>
                Maximum number of daily memory summaries to retain (7-365,
                default 90 days).
              </FieldDescription>
              {validationErrors.maxDailySummaries && (
                <FieldError>{validationErrors.maxDailySummaries}</FieldError>
              )}
            </Field>
          )}

          {/* Delegation flags (ADR-0006) — admin-only. When off, only org
              admins may configure the respective resource; when on, the
              workspace owner may self-manage it. */}
          {workspaceId && isOrgAdmin && (
            <>
              <Field
                orientation="horizontal"
                className="items-center justify-between"
              >
                <div>
                  <FieldLabel htmlFor="providerSelfManagement">
                    Owner-managed providers
                  </FieldLabel>
                  <FieldDescription>
                    Let the workspace owner create and edit workspace-scoped
                    providers. Off by default (org admins only).
                  </FieldDescription>
                </div>
                <Switch
                  id="providerSelfManagement"
                  checked={formData.providerSelfManagement}
                  disabled={isSubmitting}
                  onCheckedChange={(checked) =>
                    setFormData((prev) => ({
                      ...prev,
                      providerSelfManagement: checked,
                    }))
                  }
                />
              </Field>

              <Field
                orientation="horizontal"
                className="items-center justify-between"
              >
                <div>
                  <FieldLabel htmlFor="mcpSelfManagement">
                    Owner-managed MCP servers
                  </FieldLabel>
                  <FieldDescription>
                    Let the workspace owner register and authorize their own MCP
                    servers (e.g. personal-credential integrations). Off by
                    default (org admins only).
                  </FieldDescription>
                </div>
                <Switch
                  id="mcpSelfManagement"
                  checked={formData.mcpSelfManagement}
                  disabled={isSubmitting}
                  onCheckedChange={(checked) =>
                    setFormData((prev) => ({
                      ...prev,
                      mcpSelfManagement: checked,
                    }))
                  }
                />
              </Field>
            </>
          )}
        </FieldGroup>
      </FieldSet>

      <div className="flex gap-2">
        <Button
          onClick={handleSubmit}
          disabled={
            isSubmitting || !canSubmitForm(validationErrors, RETRACTABLE_FIELDS)
          }
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
