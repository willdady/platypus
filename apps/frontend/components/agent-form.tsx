"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldLegend,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, Trash2, ImageIcon, Camera, X } from "lucide-react";
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
  type ToolSet,
  type Agent,
  type Provider,
  type Skill,
} from "@platypus/schemas";
import useSWR, { useSWRConfig } from "swr";
import { fetcher, parseValidationErrors, joinUrl } from "@/lib/utils";
import { toast } from "sonner";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { AgentAvatar } from "@/components/agent-avatar";
import { Skeleton } from "@/components/ui/skeleton";

type SubAgentRef = { id: string; parentOutput?: string };

/**
 * Compact dropdown + optional number input for picking how much of a
 * sub-agent's response text is returned to the parent's context window.
 * Three modes encoded in `parentOutput`:
 *   - "full"   → entire response
 *   - "none"   → "Task completed." only
 *   - "<int>"  → last N chars (stringified positive integer)
 */
const OutputReturnedRow = ({
  parentOutput,
  onChange,
  disabled,
}: {
  parentOutput: string | undefined;
  onChange: (next: string) => void;
  disabled?: boolean;
}) => {
  const raw = parentOutput ?? "full";
  const isChars = raw !== "full" && raw !== "none";
  const selectVal = isChars ? "chars" : raw;
  const charsNum = isChars ? raw : "500";

  return (
    <div className="mt-2 flex items-center gap-2">
      <span className="text-xs text-muted-foreground shrink-0">
        Output returned:
      </span>
      <Select
        value={selectVal}
        onValueChange={(value) => onChange(value === "chars" ? charsNum : value)}
        disabled={disabled}
      >
        <SelectTrigger className="text-xs w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="full">Full response</SelectItem>
          <SelectItem value="none">No output (state only)</SelectItem>
          <SelectItem value="chars">Last N chars</SelectItem>
        </SelectContent>
      </Select>
      {isChars && (
        <Input
          type="number"
          min={1}
          value={charsNum}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, "");
            // Allow empty while typing; commit to a valid value on blur below.
            onChange(digits || "");
          }}
          onBlur={(e) => {
            const digits = e.target.value.replace(/\D/g, "");
            if (!digits || parseInt(digits, 10) < 1) onChange("1");
          }}
          className="w-20 text-xs px-2"
          disabled={disabled}
        />
      )}
    </div>
  );
};

const AgentForm = ({
  classNames,
  orgId,
  workspaceId,
  agentId,
  toolSets,
  agents: propAgents,
}: {
  classNames?: string;
  orgId: string;
  workspaceId: string;
  agentId?: string;
  toolSets: ToolSet[];
  agents?: Agent[];
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const { mutate } = useSWRConfig();

  // Fetch providers
  const { data: providersData, isLoading: providersLoading } = useSWR<{
    results: Provider[];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/providers`,
        )
      : null,
    fetcher,
  );
  const providers = providersData?.results || [];

  // Fetch skills
  const { data: skillsData } = useSWR<{ results: Skill[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/skills`,
        )
      : null,
    fetcher,
  );
  const skills = skillsData?.results || [];

  // Fetch agents for sub-agent selection
  const { data: agentsData } = useSWR<{ results: Agent[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/agents`,
        )
      : null,
    fetcher,
  );
  const agents = propAgents || agentsData?.results || [];

  // Fetch existing agent data if editing
  const { data: agent, isLoading: agentLoading } = useSWR<Agent>(
    agentId && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/agents/${agentId}`,
        )
      : null,
    fetcher,
  );

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    inputPlaceholder: "",
    systemPrompt: "",
    providerId: "",
    modelId: "",
    maxSteps: 30,
    temperature: undefined as number | undefined,
    toolSetIds: [] as string[],
    skillIds: [] as string[],
    subAgentIds: [] as Array<{ id: string; parentOutput?: string }>,
    topP: undefined as number | undefined,
    topK: undefined as number | undefined,
    seed: undefined as number | undefined,
    presencePenalty: undefined as number | undefined,
    frequencyPenalty: undefined as number | undefined,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [avatarDeleted, setAvatarDeleted] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const router = useRouter();

  // Initialize with first provider's first model once providers are loaded
  useEffect(() => {
    if (
      providers.length > 0 &&
      !formData.modelId &&
      !formData.providerId &&
      !agentId
    ) {
      setFormData((prevData) => ({
        ...prevData,
        modelId: providers[0].modelIds[0],
        providerId: providers[0].id,
      }));
    }
  }, [providers, formData.modelId, formData.providerId, agentId]);

  // Initialize form with existing agent data when editing
  useEffect(() => {
    if (agent) {
      setFormData({
        name: agent.name,
        description: agent.description,
        inputPlaceholder: agent.inputPlaceholder || "",
        systemPrompt: agent.systemPrompt || "",
        providerId: agent.providerId,
        modelId: agent.modelId,
        maxSteps: agent.maxSteps || 30,
        temperature: agent.temperature ?? undefined,
        topP: agent.topP ?? undefined,
        topK: agent.topK ?? undefined,
        seed: agent.seed ?? undefined,
        presencePenalty: agent.presencePenalty ?? undefined,
        frequencyPenalty: agent.frequencyPenalty ?? undefined,
        toolSetIds: agent.toolSetIds || [],
        skillIds: agent.skillIds || [],
        subAgentIds: agent.subAgentIds || ([] as Array<{ id: string; parentOutput?: string }>),
      });
      if (agent.avatarUrl) {
        setAvatarPreviewUrl(agent.avatarUrl);
        setAvatarDeleted(false);
      }
    }
  }, [agent]);

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

  const handleNumberChange = (id: string, value: string) => {
    setFormData((prevData) => ({
      ...prevData,
      [id]: value === "" ? undefined : parseInt(value),
    }));
  };

  const handleFloatChange = (id: string, value: string) => {
    setFormData((prevData) => ({
      ...prevData,
      [id]: value === "" ? undefined : parseFloat(value),
    }));
  };

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAvatarFromFile(file);
    }
  };

  const setAvatarFromFile = (file: File) => {
    if (avatarPreviewUrl) {
      URL.revokeObjectURL(avatarPreviewUrl);
    }
    setAvatarFile(file);
    setAvatarPreviewUrl(URL.createObjectURL(file));
    setAvatarDeleted(false);
  };

  const handleAvatarDelete = () => {
    if (avatarPreviewUrl) {
      URL.revokeObjectURL(avatarPreviewUrl);
    }
    setAvatarFile(null);
    setAvatarPreviewUrl(null);
    setAvatarDeleted(true);
  };

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            setAvatarFromFile(file);
          }
          break;
        }
      }
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [avatarPreviewUrl]);

  const handleModelChange = (value: string) => {
    if (value.startsWith("provider:")) {
      // Provider/model selected
      const [_, newProviderId, ...modelIdParts] = value.split(":");
      const newModelId = modelIdParts.join(":");
      setFormData((prevData) => ({
        ...prevData,
        providerId: newProviderId,
        modelId: newModelId,
      }));
    }
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setValidationErrors({});
    try {
      const payload: Omit<Agent, "id" | "createdAt" | "updatedAt"> = {
        workspaceId,
        providerId: formData.providerId,
        name: formData.name,
        description: formData.description,
        inputPlaceholder: formData.inputPlaceholder || undefined,
        systemPrompt: formData.systemPrompt,
        modelId: formData.modelId,
        maxSteps: formData.maxSteps,
        temperature: formData.temperature,
        topP: formData.topP,
        topK: formData.topK,
        seed: formData.seed,
        presencePenalty: formData.presencePenalty,
        frequencyPenalty: formData.frequencyPenalty,
        toolSetIds: formData.toolSetIds,
        skillIds: formData.skillIds,
        subAgentIds: formData.subAgentIds,
      };

      const url = agentId
        ? joinUrl(
            backendUrl,
            `/organizations/${orgId}/workspaces/${workspaceId}/agents/${agentId}`,
          )
        : joinUrl(
            backendUrl,
            `/organizations/${orgId}/workspaces/${workspaceId}/agents`,
          );

      const method = agentId ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        credentials: "include",
      });

      if (response.ok) {
        const savedAgent = await response.json();
        const savedAgentId = savedAgent.id || agentId;

        if (avatarDeleted && agentId) {
          await fetch(
            joinUrl(
              backendUrl,
              `/organizations/${orgId}/workspaces/${workspaceId}/agents/${savedAgentId}/avatar`,
            ),
            {
              method: "DELETE",
              credentials: "include",
            },
          );
        } else if (avatarFile) {
          const avatarFormData = new FormData();
          avatarFormData.append("file", avatarFile);
          await fetch(
            joinUrl(
              backendUrl,
              `/organizations/${orgId}/workspaces/${workspaceId}/agents/${savedAgentId}/avatar`,
            ),
            {
              method: "POST",
              body: avatarFormData,
              credentials: "include",
            },
          );
        }

        await mutate(
          joinUrl(
            backendUrl,
            `/organizations/${orgId}/workspaces/${workspaceId}/agents`,
          ),
        );
        router.push(`/${orgId}/workspace/${workspaceId}`);
      } else {
        // Parse standardschema.dev validation errors
        const errorData = await response.json();
        setValidationErrors(parseValidationErrors(errorData));
        console.error("Failed to save agent");
      }
    } catch (error) {
      console.error("Error saving agent:", error);
      toast.error("Failed to save agent");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!agentId) return;

    setIsDeleting(true);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/agents/${agentId}`,
        ),
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      if (response.ok) {
        router.push(`/${orgId}/workspace/${workspaceId}`);
      } else {
        console.error("Failed to delete agent");
        toast.error("Failed to delete agent");
        setIsDeleting(false);
        setIsDeleteDialogOpen(false);
      }
    } catch (error) {
      console.error("Error deleting agent:", error);
      toast.error("Failed to delete agent");
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  if (providersLoading || agentLoading) {
    return (
      <div className={classNames}>
        <div className="flex flex-col items-center mb-6">
          <Skeleton className="w-20 h-20 rounded-2xl" />
          <Skeleton className="h-4 w-16 mt-2" />
        </div>
        <div className="space-y-6 mb-6">
          <div className="space-y-2">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-9 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-20 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-9 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-32 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-9 w-full" />
          </div>
          <div className="space-y-2 w-1/2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-9 w-full" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-20" />
          {agentId && <Skeleton className="h-9 w-24" />}
        </div>
      </div>
    );
  }

  return (
    <div className={classNames}>
      <FieldSet className="mb-6">
        <div className="flex flex-col items-center">
          <div className="relative">
            <button
              type="button"
              onClick={() => avatarInputRef.current?.click()}
              className="relative group cursor-pointer flex"
              disabled={isSubmitting}
            >
              <div className="w-20 h-20 rounded-2xl bg-muted flex items-center justify-center overflow-hidden border-2 border-dashed border-muted-foreground/20 hover:border-muted-foreground/40 transition-colors">
                {avatarPreviewUrl ? (
                  <img
                    src={avatarPreviewUrl}
                    alt="Avatar"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <ImageIcon className="w-8 h-8 text-muted-foreground" />
                )}
              </div>
              {avatarPreviewUrl && (
                <div className="absolute inset-0 bg-black/50 rounded-2xl flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity gap-2">
                  <Camera className="w-6 h-6 text-white" />
                </div>
              )}
            </button>
          </div>
          <div className="h-7 flex items-center justify-center">
            {avatarPreviewUrl && (
              <button
                type="button"
                onClick={handleAvatarDelete}
                className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-destructive whitespace-nowrap"
                disabled={isSubmitting}
              >
                <X className="w-4 h-4" />
                Remove
              </button>
            )}
          </div>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            onChange={handleAvatarChange}
            className="hidden"
            disabled={isSubmitting}
          />
        </div>

        <FieldGroup>
          <Field data-invalid={!!validationErrors.name}>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              placeholder="Name"
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
          <Field data-invalid={!!validationErrors.description}>
            <ExpandableTextarea
              id="description"
              label="Description"
              expandable={false}
              placeholder="Description of the agent..."
              value={formData.description}
              onChange={handleChange}
              disabled={isSubmitting}
              maxLength={128}
              aria-invalid={!!validationErrors.description}
              error={validationErrors.description}
            />
          </Field>
          <Field data-invalid={!!validationErrors.inputPlaceholder}>
            <FieldLabel htmlFor="inputPlaceholder">
              Input Placeholder
            </FieldLabel>
            <Input
              id="inputPlaceholder"
              placeholder="What would you like to know?"
              value={formData.inputPlaceholder}
              onChange={handleChange}
              disabled={isSubmitting}
              maxLength={100}
              aria-invalid={!!validationErrors.inputPlaceholder}
            />
            <FieldDescription>
              Custom placeholder text shown in the chat input when this agent is
              selected
            </FieldDescription>
            {validationErrors.inputPlaceholder && (
              <FieldError>{validationErrors.inputPlaceholder}</FieldError>
            )}
          </Field>
          <Field>
            <ExpandableTextarea
              id="systemPrompt"
              label="System prompt"
              placeholder="You are a helpful agent..."
              value={formData.systemPrompt}
              onChange={handleChange}
              disabled={isSubmitting}
              className="!font-mono"
            />
          </Field>
          <Field>
            <FieldLabel>Model</FieldLabel>
            <Select
              value={`provider:${formData.providerId}:${formData.modelId}`}
              onValueChange={handleModelChange}
              disabled={isSubmitting}
            >
              <SelectTrigger disabled={isSubmitting}>
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((provider) => (
                  <SelectGroup key={provider.id}>
                    <SelectLabel>{provider.name}</SelectLabel>
                    {provider.modelIds.map((modelId) => (
                      <SelectItem
                        key={`provider:${provider.id}:${modelId}`}
                        value={`provider:${provider.id}:${modelId}`}
                      >
                        {modelId}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field className="w-1/2">
            <FieldLabel htmlFor="maxSteps">Max steps</FieldLabel>
            <Input
              id="maxSteps"
              type="number"
              min="1"
              value={formData.maxSteps}
              onChange={(e) => handleNumberChange("maxSteps", e.target.value)}
              disabled={isSubmitting}
            />
            <FieldDescription>
              Controls when a tool-calling loop should stop based on the number
              of steps executed
            </FieldDescription>
          </Field>
        </FieldGroup>

        {toolSets.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Tools</CardTitle>
            </CardHeader>
            <CardContent>
              {(() => {
                // Group tool sets by category
                const toolSetsByCategory = toolSets.reduce(
                  (acc, toolSet) => {
                    const category = toolSet.category || "Uncategorized";
                    if (!acc[category]) {
                      acc[category] = [];
                    }
                    acc[category].push(toolSet);
                    return acc;
                  },
                  {} as Record<string, ToolSet[]>,
                );

                // Sort categories alphabetically, but keep "Uncategorized" last
                const sortedCategories = Object.keys(toolSetsByCategory).sort(
                  (a, b) => {
                    if (a === "Uncategorized") return 1;
                    if (b === "Uncategorized") return -1;
                    return a.localeCompare(b);
                  },
                );

                return sortedCategories.map((category) => (
                  <FieldSet key={category} className="mb-4">
                    <FieldLegend variant="label">{category}</FieldLegend>
                    <FieldGroup className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {toolSetsByCategory[category].map((toolSet) => (
                        <Field key={toolSet.id} orientation="horizontal">
                          <Switch
                            id={toolSet.id}
                            className="cursor-pointer"
                            checked={formData.toolSetIds.includes(toolSet.id)}
                            onCheckedChange={(checked) => {
                              setFormData((prevData) => {
                                const newToolSetIds = checked
                                  ? [...prevData.toolSetIds, toolSet.id]
                                  : prevData.toolSetIds.filter(
                                      (id: string) => id !== toolSet.id,
                                    );
                                return {
                                  ...prevData,
                                  toolSetIds: newToolSetIds,
                                };
                              });
                            }}
                            disabled={isSubmitting}
                          />
                          <FieldLabel htmlFor={toolSet.id}>
                            <div className="flex flex-col">
                              <p>{toolSet.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {toolSet.description}
                              </p>
                            </div>
                          </FieldLabel>
                        </Field>
                      ))}
                    </FieldGroup>
                  </FieldSet>
                ));
              })()}
            </CardContent>
          </Card>
        )}

        {skills.length > 0 && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Skills</CardTitle>
            </CardHeader>
            <CardContent>
              <FieldGroup className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {skills.map((skill) => (
                  <Field key={skill.id} orientation="horizontal">
                    <Switch
                      id={`skill-${skill.id}`}
                      className="cursor-pointer"
                      checked={formData.skillIds.includes(skill.id)}
                      onCheckedChange={(checked) => {
                        setFormData((prevData) => {
                          const newSkillIds = checked
                            ? [...prevData.skillIds, skill.id]
                            : prevData.skillIds.filter(
                                (id: string) => id !== skill.id,
                              );
                          return {
                            ...prevData,
                            skillIds: newSkillIds,
                          };
                        });
                      }}
                      disabled={isSubmitting}
                    />
                    <FieldLabel htmlFor={`skill-${skill.id}`}>
                      <div className="flex flex-col">
                        <p>{skill.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {skill.description}
                        </p>
                      </div>
                    </FieldLabel>
                  </Field>
                ))}
              </FieldGroup>
            </CardContent>
          </Card>
        )}

        {agents.filter((a) => a.id !== agentId).length > 0 && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Sub-Agents</CardTitle>
            </CardHeader>
            <CardContent>
              <FieldDescription className="mb-4">
                Select agents that this agent can delegate tasks to. When
                running as a sub-agent, these agents will not be able to
                delegate further.
              </FieldDescription>
              <div className="flex flex-col gap-1">
                {agents
                  .filter((a) => a.id !== agentId) // Only exclude self-assignment
                  .map((agent) => {
                    const ref = formData.subAgentIds.find(
                      (r) => r.id === agent.id,
                    );
                    const isEnabled = Boolean(ref);
                    return (
                      <div key={agent.id} className="py-1">
                        <div className="flex items-center gap-3">
                          <Switch
                            id={`subagent-${agent.id}`}
                            className="cursor-pointer shrink-0"
                            checked={isEnabled}
                            onCheckedChange={(checked) => {
                              setFormData((prevData) => ({
                                ...prevData,
                                subAgentIds: checked
                                  ? [
                                      ...prevData.subAgentIds,
                                      { id: agent.id },
                                    ]
                                  : prevData.subAgentIds.filter(
                                      (r) => r.id !== agent.id,
                                    ),
                              }));
                            }}
                            disabled={isSubmitting}
                          />
                          <label
                            htmlFor={`subagent-${agent.id}`}
                            className="flex items-center gap-2 cursor-pointer"
                          >
                            <AgentAvatar
                              agent={agent}
                              className="size-6 shrink-0"
                            />
                            <div>
                              <p className="text-sm font-medium">
                                {agent.name}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {agent.description || "No description"}
                              </p>
                            </div>
                          </label>
                        </div>
                        {isEnabled && (
                          <OutputReturnedRow
                            parentOutput={ref?.parentOutput}
                            disabled={isSubmitting}
                            onChange={(val) =>
                              setFormData((prevData) => ({
                                ...prevData,
                                subAgentIds: prevData.subAgentIds.map((r) =>
                                  r.id === agent.id
                                    ? { ...r, parentOutput: val }
                                    : r,
                                ),
                              }))
                            }
                          />
                        )}
                      </div>
                    );
                  })}
              </div>
            </CardContent>
          </Card>
        )}

        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
          <CollapsibleTrigger asChild>
            <div className="flex text-sm justify-between items-center">
              <span className="cursor-default">Advanced settings</span>
              <Button
                variant="ghost"
                size="icon"
                className="cursor-pointer size-8"
              >
                <ChevronsUpDown />
                <span className="sr-only">Toggle</span>
              </Button>
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent className="mb-6">
            <FieldGroup className="grid grid-cols-2">
              <Field>
                <FieldLabel htmlFor="temperature">Temperature</FieldLabel>
                <Input
                  id="temperature"
                  type="number"
                  min="0"
                  step="0.1"
                  value={formData.temperature ?? ""}
                  onChange={(e) =>
                    handleFloatChange("temperature", e.target.value)
                  }
                  disabled={isSubmitting}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="seed">Seed</FieldLabel>
                <Input
                  id="seed"
                  type="number"
                  value={formData.seed ?? ""}
                  onChange={(e) => handleNumberChange("seed", e.target.value)}
                  disabled={isSubmitting}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="topP">Top-p</FieldLabel>
                <Input
                  id="topP"
                  type="number"
                  min="0"
                  max="1"
                  step="0.1"
                  value={formData.topP ?? ""}
                  onChange={(e) => handleFloatChange("topP", e.target.value)}
                  disabled={isSubmitting}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="topK">Top-k</FieldLabel>
                <Input
                  id="topK"
                  type="number"
                  min="1"
                  value={formData.topK ?? ""}
                  onChange={(e) => handleNumberChange("topK", e.target.value)}
                  disabled={isSubmitting}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="presencePenalty">
                  Presence Penalty
                </FieldLabel>
                <Input
                  id="presencePenalty"
                  type="number"
                  min="-2"
                  max="2"
                  step="0.1"
                  value={formData.presencePenalty ?? ""}
                  onChange={(e) =>
                    handleFloatChange("presencePenalty", e.target.value)
                  }
                  disabled={isSubmitting}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="frequencyPenalty">
                  Frequency Penalty
                </FieldLabel>
                <Input
                  id="frequencyPenalty"
                  type="number"
                  min="-2"
                  max="2"
                  step="0.1"
                  value={formData.frequencyPenalty ?? ""}
                  onChange={(e) =>
                    handleFloatChange("frequencyPenalty", e.target.value)
                  }
                  disabled={isSubmitting}
                />
              </Field>
            </FieldGroup>
          </CollapsibleContent>
        </Collapsible>
      </FieldSet>

      <div className="flex gap-2">
        <Button
          className="cursor-pointer"
          onClick={handleSubmit}
          disabled={isSubmitting || Object.keys(validationErrors).length > 0}
        >
          {agentId ? "Update" : "Save"}
        </Button>

        {agentId && (
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
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete Agent"
        description="Are you sure you want to delete this agent? This action cannot be undone."
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={handleDelete}
        loading={isDeleting}
      />
    </div>
  );
};

export { AgentForm };
