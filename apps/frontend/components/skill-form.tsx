"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { type Skill, type Agent } from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, parseValidationErrors, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { AgentAvatar } from "@/components/agent-avatar";

const SkillForm = ({
  classNames,
  orgId,
  workspaceId,
  skillId,
}: {
  classNames?: string;
  orgId: string;
  workspaceId: string;
  skillId?: string;
}) => {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  // Fetch existing skill data if editing (includes agentIds)
  const { data: skill, isLoading: skillLoading } = useSWR<
    Skill & { agentIds?: string[] }
  >(
    skillId && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/skills/${skillId}`,
        )
      : null,
    fetcher,
  );

  // Fetch agents for association
  const { data: agentsData } = useSWR<{ results: Agent[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/agents`,
        )
      : null,
    fetcher,
  );
  const agents = agentsData?.results || [];

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    body: "",
  });
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  const router = useRouter();

  // Initialize form with existing skill data when editing
  useEffect(() => {
    if (skill) {
      setFormData({
        name: skill.name,
        description: skill.description,
        body: skill.body,
      });
    }
  }, [skill]);

  // Initialize agent selections from the skill's agentIds
  useEffect(() => {
    if (skill?.agentIds) {
      setSelectedAgentIds(skill.agentIds);
    }
  }, [skill]);

  if (skillLoading) {
    return <div className={classNames}>Loading...</div>;
  }

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
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
      const payload = {
        workspaceId,
        name: formData.name,
        description: formData.description,
        body: formData.body,
        agentIds: selectedAgentIds,
      };

      const url = skillId
        ? joinUrl(
            backendUrl,
            `/organizations/${orgId}/workspaces/${workspaceId}/skills/${skillId}`,
          )
        : joinUrl(
            backendUrl,
            `/organizations/${orgId}/workspaces/${workspaceId}/skills`,
          );

      const method = skillId ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        credentials: "include",
      });

      if (response.ok) {
        router.push(`/${orgId}/workspace/${workspaceId}`);
      } else {
        const errorData = await response.json();
        if (response.status === 409) {
          setValidationErrors({ name: errorData.message });
        } else {
          setValidationErrors(parseValidationErrors(errorData));
        }
        console.error("Failed to save skill");
      }
    } catch (error) {
      console.error("Error saving skill:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!skillId) return;

    setIsDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/skills/${skillId}`,
        ),
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      if (response.ok) {
        router.push(`/${orgId}/workspace/${workspaceId}`);
      } else {
        const errorData = await response.json();
        setDeleteError(errorData.message || "Failed to delete skill");
        setIsDeleting(false);
      }
    } catch (error) {
      console.error("Error deleting skill:", error);
      setDeleteError("An unexpected error occurred");
      setIsDeleting(false);
    }
  };

  return (
    <div className={classNames}>
      <FieldSet className="mb-6">
        <FieldGroup className="gap-4">
          <Field data-invalid={!!validationErrors.name}>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              placeholder="skill-name"
              value={formData.name}
              onChange={handleChange}
              disabled={isSubmitting}
              aria-invalid={!!validationErrors.name}
              autoFocus
            />
            <div className="flex justify-between mt-1">
              {validationErrors.name ? (
                <FieldError>{validationErrors.name}</FieldError>
              ) : (
                <div />
              )}
              <p className="text-xs text-muted-foreground">
                {formData.name.length}/64
              </p>
            </div>
          </Field>
          <Field data-invalid={!!validationErrors.description}>
            <ExpandableTextarea
              id="description"
              label="Description"
              expandable={false}
              placeholder="A brief description of what this skill does..."
              value={formData.description}
              onChange={handleChange}
              disabled={isSubmitting}
              maxLength={128}
              aria-invalid={!!validationErrors.description}
              error={validationErrors.description}
            />
          </Field>
          <Field data-invalid={!!validationErrors.body}>
            <ExpandableTextarea
              id="body"
              label="Body"
              placeholder="Instructions for this skill..."
              value={formData.body}
              onChange={handleChange}
              disabled={isSubmitting}
              className="min-h-[200px] !font-mono"
              aria-invalid={!!validationErrors.body}
              maxLength={5000}
              error={validationErrors.body}
            />
          </Field>
        </FieldGroup>
      </FieldSet>

      {agents.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Agents</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldDescription className="mb-4">
              Select which agents this skill is enabled for.
            </FieldDescription>
            <FieldGroup className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {agents.map((agent) => (
                <Field key={agent.id} orientation="horizontal">
                  <Switch
                    id={`agent-${agent.id}`}
                    className="cursor-pointer"
                    checked={selectedAgentIds.includes(agent.id)}
                    onCheckedChange={(checked) => {
                      setSelectedAgentIds((prev) =>
                        checked
                          ? [...prev, agent.id]
                          : prev.filter((id) => id !== agent.id),
                      );
                    }}
                    disabled={isSubmitting}
                  />
                  <FieldLabel htmlFor={`agent-${agent.id}`}>
                    <div className="flex items-center gap-2">
                      <AgentAvatar agent={agent} className="size-6" />
                      <div className="flex flex-col">
                        <p>{agent.name}</p>
                        <p className="text-xs text-muted-foreground line-clamp-1">
                          {agent.description}
                        </p>
                      </div>
                    </div>
                  </FieldLabel>
                </Field>
              ))}
            </FieldGroup>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-2">
        <Button
          className="cursor-pointer"
          onClick={handleSubmit}
          disabled={isSubmitting}
        >
          {skillId ? "Update" : "Save"}
        </Button>

        {skillId && (
          <Button
            className="cursor-pointer"
            variant="outline"
            onClick={() => setIsDeleteDialogOpen(true)}
            disabled={isSubmitting}
          >
            <Trash2 /> Delete
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={isDeleteDialogOpen}
        onOpenChange={(open) => {
          setIsDeleteDialogOpen(open);
          if (!open) setDeleteError(null);
        }}
        title="Delete Skill"
        description="Are you sure you want to delete this skill? This action cannot be undone."
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={handleDelete}
        loading={isDeleting}
        error={deleteError}
      />
    </div>
  );
};

export { SkillForm };
