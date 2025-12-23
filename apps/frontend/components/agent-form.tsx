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
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { ChevronsUpDown, Trash2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type ToolSet, type Agent, type Provider } from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, parseValidationErrors, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";

const AgentForm = ({
  classNames,
  orgId,
  workspaceId,
  agentId,
  toolSets,
}: {
  classNames?: string;
  orgId: string;
  workspaceId: string;
  agentId?: string;
  toolSets: ToolSet[];
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const backendUrl = useBackendUrl();

  // Fetch providers
  const { data: providersData, isLoading: providersLoading } = useSWR<{
    results: Provider[];
  }>(
    backendUrl
      ? joinUrl(
          backendUrl,
          `/organisations/${orgId}/workspaces/${workspaceId}/providers`,
        )
      : null,
    fetcher,
  );
  const providers = providersData?.results || [];

  // Fetch existing agent data if editing
  const { data: agent, isLoading: agentLoading } = useSWR<Agent>(
    agentId
      ? joinUrl(
          backendUrl,
          `/organisations/${orgId}/workspaces/${workspaceId}/agents/${agentId}`,
        )
      : null,
    fetcher,
  );

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    systemPrompt: "",
    providerId: "",
    modelId: "",
    maxSteps: 10,
    temperature: undefined as number | undefined,
    toolSetIds: [] as string[],
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
        description: agent.description || "",
        systemPrompt: agent.systemPrompt || "",
        providerId: agent.providerId,
        modelId: agent.modelId,
        maxSteps: agent.maxSteps || 10,
        temperature: agent.temperature ?? undefined,
        topP: agent.topP ?? undefined,
        topK: agent.topK ?? undefined,
        seed: agent.seed ?? undefined,
        presencePenalty: agent.presencePenalty ?? undefined,
        frequencyPenalty: agent.frequencyPenalty ?? undefined,
        toolSetIds: agent.toolSetIds || [],
      });
    }
  }, [agent]);

  if (providersLoading || agentLoading) {
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
      };

      const url = agentId
        ? joinUrl(
            backendUrl,
            `/organisations/${orgId}/workspaces/${workspaceId}/agents/${agentId}`,
          )
        : joinUrl(
            backendUrl,
            `/organisations/${orgId}/workspaces/${workspaceId}/agents`,
          );

      const method = agentId ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        router.push(`/${orgId}/workspace/${workspaceId}/agents`);
      } else {
        // Parse standardschema.dev validation errors
        const errorData = await response.json();
        setValidationErrors(parseValidationErrors(errorData));
        console.error("Failed to save agent");
      }
    } catch (error) {
      console.error("Error saving agent:", error);
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
          `/organisations/${orgId}/workspaces/${workspaceId}/agents/${agentId}`,
        ),
        {
          method: "DELETE",
        },
      );

      if (response.ok) {
        router.push(`/${orgId}/workspace/${workspaceId}/agents`);
      } else {
        console.error("Failed to delete agent");
        setIsDeleting(false);
        setIsDeleteDialogOpen(false);
      }
    } catch (error) {
      console.error("Error deleting agent:", error);
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
          <Field>
            <FieldLabel htmlFor="description">Description</FieldLabel>
            <Textarea
              id="description"
              placeholder="Optional description of the agent..."
              value={formData.description}
              onChange={handleChange}
              disabled={isSubmitting}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="systemPrompt">System prompt</FieldLabel>
            <Textarea
              id="systemPrompt"
              placeholder="You are a helpful agent..."
              value={formData.systemPrompt}
              onChange={handleChange}
              disabled={isSubmitting}
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
                    <FieldGroup className="grid grid-cols-2 gap-4">
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
            <DialogTitle>Delete Agent</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this agent? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              className="cursor-pointer"
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              className="cursor-pointer"
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export { AgentForm };
