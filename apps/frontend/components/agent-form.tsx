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
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { FormTextField } from "@/components/form-text-field";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { EntityDeleteDialog } from "@/components/entity-delete-dialog";
import { DetailFormState } from "@/components/detail-form-state";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import Link from "next/link";
import { ChevronsUpDown, ImageIcon, Camera, X, Building } from "lucide-react";
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
  AGENT_DESCRIPTION_MAX_LENGTH,
  AGENT_INPUT_PLACEHOLDER_MAX_LENGTH,
  AGENT_MAX_STEPS_MIN,
  DEFAULT_AGENT_MAX_STEPS,
  type ToolSet,
  type Agent,
  type Provider,
  type Skill,
} from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { writeAt, errorMessage } from "@/lib/api-write";
import {
  toastGuidanceOrError,
  FIX_FORM_ERRORS_MESSAGE,
} from "@/lib/apply-write-outcome";
import { findModelOption, getModelOptions } from "@/lib/model-config";
import { resolveModel } from "@/lib/resolve-model";
import {
  decodeSelectionReference,
  encodeProviderSelection,
} from "@/lib/selection-reference";
import { ModelCapabilityNotice } from "@/components/model-capability-notice";
import { toast } from "sonner";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { AgentAvatar } from "@/components/agent-avatar";
import { ToolSetsUnavailableNotice } from "@/components/tool-sets-unavailable-notice";
import { type ToolSetsFailureReason } from "@/lib/tool-sets-request";
import { orgRoutes, workspaceRoutes } from "@/lib/routes";

// toolSetIds, skillIds, and subAgentIds are deliberately excluded: this form
// has no field that retracts an error keyed to them, so including them here
// would disable Save forever the moment the server rejects one.
const RETRACTABLE_FIELDS = [
  "name",
  "description",
  "inputPlaceholder",
  "instructions",
  "providerId",
  "modelId",
  "maxSteps",
  "temperature",
  "topP",
  "topK",
  "seed",
  "presencePenalty",
  "frequencyPenalty",
] as const;

type AgentFormData = {
  name: string;
  description: string;
  inputPlaceholder: string;
  instructions: string;
  providerId: string;
  modelId: string;
  maxSteps: number;
  temperature?: number;
  toolSetIds: string[];
  skillIds: string[];
  subAgentIds: string[];
  topP?: number;
  topK?: number;
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
};

const AgentForm = ({
  classNames,
  orgId,
  workspaceId,
  agentId,
  toolSets,
  toolSetsError,
  agents: propAgents,
  orgScoped = false,
}: {
  classNames?: string;
  orgId: string;
  workspaceId?: string;
  agentId?: string;
  toolSets: ToolSet[];
  // Set when the tool sets couldn't be read, so the form can say so instead of
  // presenting a failed read as an empty catalogue (issue #818).
  toolSetsError?: ToolSetsFailureReason;
  agents?: Agent[];
  // When true the form edits an org-scoped (Shared) Agent on the Organization
  // surface, pulling its references from org-scoped lists and writing via the
  // org Agent routes (ADR-0007). Otherwise it edits a workspace Agent.
  orgScoped?: boolean;
}) => {
  const [isOpen, setIsOpen] = useState(false);

  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  // Resource base paths differ by scope: the Organization surface lists/writes
  // org-scoped references, the Workspace surface its own.
  const agentsBase = orgScoped
    ? `/organizations/${orgId}/agents`
    : `/organizations/${orgId}/workspaces/${workspaceId}/agents`;
  const providersBase = orgScoped
    ? `/organizations/${orgId}/providers`
    : `/organizations/${orgId}/workspaces/${workspaceId}/providers`;
  const skillsBase = orgScoped
    ? `/organizations/${orgId}/skills`
    : `/organizations/${orgId}/workspaces/${workspaceId}/skills`;
  const doneHref = orgScoped
    ? orgRoutes(orgId).settings.agents
    : workspaceRoutes(orgId, workspaceId!).root;

  // Fetch providers
  const { data: providersData, isLoading: providersLoading } = useSWR<{
    results: Provider[];
  }>(backendUrl && user ? joinUrl(backendUrl, providersBase) : null, fetcher);
  const providers = useMemo(
    () => providersData?.results || [],
    [providersData],
  );

  // Fetch skills
  const { data: skillsData } = useSWR<{ results: Skill[] }>(
    backendUrl && user ? joinUrl(backendUrl, skillsBase) : null,
    fetcher,
  );
  const skills = skillsData?.results || [];

  // Fetch agents for Sub-Agent selection
  const { data: agentsData } = useSWR<{ results: Agent[] }>(
    backendUrl && user ? joinUrl(backendUrl, agentsBase) : null,
    fetcher,
  );
  const agents = propAgents || agentsData?.results || [];

  // Fetch existing agent data if editing
  const {
    data: agent,
    error: agentError,
    isLoading: agentLoading,
  } = useSWR<Agent & { scope?: "organization" | "workspace" }>(
    agentId && user ? joinUrl(backendUrl, `${agentsBase}/${agentId}`) : null,
    fetcher,
  );

  // A Shared Agent opened on the Workspace surface is read-only for everyone —
  // it is edited only on the Organization surface (ADR-0007). In org mode the
  // form is the canonical editor, so it is always editable.
  const isOrgScoped = agent?.scope === "organization";
  const readOnly = isOrgScoped && !orgScoped;

  const router = useRouter();

  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [avatarDeleted, setAvatarDeleted] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const {
    formData,
    setFormData,
    validationErrors,
    setValidationErrors,
    isSubmitting,
    canSubmit,
    handleChange,
    toFieldChange,
    setNumberField,
    setFloatField,
    clearErrors,
    submit,
  } = useEntityForm<AgentFormData, Agent>({
    initialData: {
      name: "",
      description: "",
      inputPlaceholder: "",
      instructions: "",
      providerId: "",
      modelId: "",
      maxSteps: DEFAULT_AGENT_MAX_STEPS,
      toolSetIds: [],
      skillIds: [],
      subAgentIds: [],
    },
    entity: "agents",
    scope: orgScoped ? { orgId } : { orgId, workspaceId },
    id: agentId,
    retractableFields: RETRACTABLE_FIELDS,
    buildPayload: (data) => {
      // Saving migrates a concrete id to the alias its model now carries
      // (ADR-0017). Once a model is aliased the picker no longer offers the
      // bare id, so "pin to exactly gpt-4" is not an expressible choice — and
      // without this the migration would only ever happen when the user
      // switches to a *different* model, since re-picking the already-selected
      // option fires no change event. Falls back to the stored value when the
      // model resolves to nothing, leaving today's dangling-id behaviour alone.
      const submittedProvider = providers.find((p) => p.id === data.providerId);
      const submittedModelId =
        (submittedProvider && data.modelId
          ? findModelOption(submittedProvider, data.modelId)?.value
          : undefined) ?? data.modelId;

      return {
        // Scope comes from the route, not the body; the org PUT ignores this.
        workspaceId: orgScoped ? undefined : workspaceId,
        providerId: data.providerId,
        name: data.name,
        description: data.description,
        inputPlaceholder: data.inputPlaceholder || undefined,
        instructions: data.instructions,
        modelId: submittedModelId,
        maxSteps: data.maxSteps,
        // Send null (not undefined) for cleared sampling params so the key
        // survives JSON.stringify and the backend persists the cleared value
        // instead of silently keeping the previous one (#263).
        temperature: data.temperature ?? null,
        topP: data.topP ?? null,
        topK: data.topK ?? null,
        seed: data.seed ?? null,
        presencePenalty: data.presencePenalty ?? null,
        frequencyPenalty: data.frequencyPenalty ?? null,
        toolSetIds: data.toolSetIds,
        skillIds: data.skillIds,
        subAgentIds: data.subAgentIds,
      };
    },
    onInvalid: (fieldErrors) => {
      setValidationErrors(fieldErrors);
      // Surface a user-visible signal even when the failure maps to a
      // field without an inline error, so a rejected save is never
      // silent (#331).
      toast.error(
        Object.keys(fieldErrors).length > 0
          ? FIX_FORM_ERRORS_MESSAGE
          : "Failed to save agent",
      );
    },
    onError: toastGuidanceOrError,
    failureMessage: "Failed to save agent",
    onSuccess: async (data) => {
      const savedAgentId = data.id || agentId;

      // The Agent itself already saved, so a failed avatar write is a
      // partial success, not a reason to block navigation — surface a
      // toast and continue on (#595).
      if (avatarDeleted && agentId) {
        const avatarOutcome = await writeAt(
          joinUrl(backendUrl, `${agentsBase}/${savedAgentId}/avatar`),
          { method: "DELETE" },
        );
        if (avatarOutcome.outcome !== "success") {
          toast.error(avatarOutcome.message);
        }
      } else if (avatarFile) {
        // Multipart upload can't go through writeAt (JSON-only body), so
        // this call stays raw fetch — see the eslint.config.mjs exception.
        const avatarFormData = new FormData();
        avatarFormData.append("file", avatarFile);
        const avatarResponse = await fetch(
          joinUrl(backendUrl, `${agentsBase}/${savedAgentId}/avatar`),
          {
            method: "POST",
            body: avatarFormData,
            credentials: "include",
          },
        );
        if (!avatarResponse.ok) {
          const body: unknown = await avatarResponse.json().catch(() => null);
          toast.error(errorMessage(body) ?? "Failed to upload the avatar");
        }
      }

      router.push(doneHref);
    },
  });

  const {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    openDeleteDialog,
    handleDelete,
  } = useEntityDelete<Agent>({
    entity: "agents",
    scope: orgScoped ? { orgId } : { orgId, workspaceId },
    id: agentId,
    onSuccess: () => router.push(doneHref),
    onError: (message, outcome, { close }) => {
      toastGuidanceOrError(message, outcome);
      close();
    },
  });

  // Initialize with first provider's first model once providers are loaded
  useResetOnChange(
    `${providers.length}:${formData.modelId ?? ""}:${formData.providerId ?? ""}:${agentId ?? ""}`,
    () => {
      if (
        providers.length > 0 &&
        !formData.modelId &&
        !formData.providerId &&
        !agentId
      ) {
        setFormData((prevData) => ({
          ...prevData,
          modelId: getModelOptions(providers[0])[0]?.value,
          providerId: providers[0].id,
        }));
      }
    },
  );

  // Initialize form with existing agent data when editing
  useResetOnChange(agent, () => {
    if (agent) {
      setFormData({
        name: agent.name,
        description: agent.description,
        inputPlaceholder: agent.inputPlaceholder || "",
        instructions: agent.instructions || "",
        providerId: agent.providerId,
        modelId: agent.modelId,
        maxSteps: agent.maxSteps || DEFAULT_AGENT_MAX_STEPS,
        temperature: agent.temperature ?? undefined,
        topP: agent.topP ?? undefined,
        topK: agent.topK ?? undefined,
        seed: agent.seed ?? undefined,
        presencePenalty: agent.presencePenalty ?? undefined,
        frequencyPenalty: agent.frequencyPenalty ?? undefined,
        toolSetIds: agent.toolSetIds || [],
        skillIds: agent.skillIds || [],
        subAgentIds: agent.subAgentIds || [],
      });
      if (agent.avatarUrl) {
        setAvatarPreviewUrl(agent.avatarUrl);
        setAvatarDeleted(false);
      }
    }
  });

  const setAvatarFromFile = useCallback(
    (file: File) => {
      if (avatarPreviewUrl) {
        URL.revokeObjectURL(avatarPreviewUrl);
      }
      setAvatarFile(file);
      setAvatarPreviewUrl(URL.createObjectURL(file));
      setAvatarDeleted(false);
    },
    [avatarPreviewUrl],
  );

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAvatarFromFile(file);
    }
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
  }, [setAvatarFromFile]);

  const handleModelChange = (value: string) => {
    const decoded = decodeSelectionReference(value);
    if (decoded?.type !== "provider") return;
    clearErrors("providerId", "modelId");
    setFormData((prevData) => ({
      ...prevData,
      providerId: decoded.providerId,
      modelId: decoded.modelReference,
    }));
  };

  const form = (
    <div className={classNames}>
      {readOnly && (
        <div className="mb-6 rounded-md border bg-secondary/50 p-3 text-sm flex items-center gap-2">
          <Building className="size-4 shrink-0" />
          <span>
            This is a shared organization agent and is read-only here. Edit it
            in{" "}
            <Link
              href={orgRoutes(orgId).settings.agentDetail(agentId!)}
              className="underline"
            >
              Organization settings
            </Link>
            .
          </span>
        </div>
      )}
      <FieldSet className="mb-6">
        <div className="flex flex-col items-center">
          <div className="relative">
            <button
              type="button"
              onClick={() => avatarInputRef.current?.click()}
              className="relative group cursor-pointer flex"
              disabled={isSubmitting || readOnly}
            >
              <div className="w-20 h-20 rounded-2xl bg-muted flex items-center justify-center overflow-hidden border-2 border-dashed border-muted-foreground/20 hover:border-muted-foreground/40 transition-colors">
                {avatarPreviewUrl ? (
                  // Local blob:/object-URL preview of the chosen file; the Next
                  // image optimizer cannot process object URLs.
                  // eslint-disable-next-line @next/next/no-img-element
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
                disabled={isSubmitting || readOnly}
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
            disabled={isSubmitting || readOnly}
          />
        </div>

        <FieldGroup>
          <FormTextField
            label="Name"
            name="name"
            placeholder="Name"
            value={formData.name}
            onChange={toFieldChange("name")}
            disabled={isSubmitting || readOnly}
            error={validationErrors.name}
            autoFocus
          />
          <Field data-invalid={!!validationErrors.description}>
            <ExpandableTextarea
              id="description"
              label="Description"
              expandable={false}
              placeholder="Description of the agent..."
              value={formData.description}
              onChange={handleChange}
              disabled={isSubmitting || readOnly}
              maxLength={AGENT_DESCRIPTION_MAX_LENGTH}
              aria-invalid={!!validationErrors.description}
              error={validationErrors.description}
            />
          </Field>
          <FormTextField
            label="Input Placeholder"
            name="inputPlaceholder"
            placeholder="What would you like to know?"
            value={formData.inputPlaceholder}
            onChange={toFieldChange("inputPlaceholder")}
            disabled={isSubmitting || readOnly}
            maxLength={AGENT_INPUT_PLACEHOLDER_MAX_LENGTH}
            error={validationErrors.inputPlaceholder}
            description="Custom placeholder text shown in the chat input when this agent is selected"
          />
          <Field data-invalid={!!validationErrors.instructions}>
            <ExpandableTextarea
              id="instructions"
              label="Instructions"
              placeholder="You are a helpful agent..."
              value={formData.instructions}
              onChange={handleChange}
              disabled={isSubmitting || readOnly}
              className="!font-mono"
              aria-invalid={!!validationErrors.instructions}
              error={validationErrors.instructions}
            />
            <FieldDescription>
              How this Agent should behave. Platypus builds the full system
              prompt around it, adding workspace and user context, memories,
              Skills, Sub-Agents, and your Provider&apos;s security guardrails.
            </FieldDescription>
          </Field>
          {/* Provider and model are chosen from one control, so surface either
              field's server error on the single Model field. */}
          {(() => {
            const modelError =
              validationErrors.modelId || validationErrors.providerId;
            // Match the stored reference to a model ENTRY, then build the
            // option value from that entry. A bare `gpt-4` on a model since
            // given an alias would otherwise match no option and render the
            // "Select a model" placeholder over a configured Agent (ADR-0017).
            const provider = providers.find(
              (p) => p.id === formData.providerId,
            );
            const option =
              provider && formData.modelId
                ? findModelOption(provider, formData.modelId)
                : undefined;
            const selectedModelValue = option
              ? encodeProviderSelection(formData.providerId, option.value)
              : undefined;
            const resolvedModel = resolveModel({
              providers,
              selection: {
                providerId: formData.providerId,
                modelId: formData.modelId,
              },
            });
            return (
              <Field data-invalid={!!modelError}>
                <FieldLabel htmlFor="modelId">Model</FieldLabel>
                <Select
                  value={selectedModelValue}
                  onValueChange={handleModelChange}
                  disabled={isSubmitting || readOnly}
                >
                  <SelectTrigger
                    id="modelId"
                    disabled={isSubmitting || readOnly}
                    aria-invalid={!!modelError}
                  >
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((provider) => (
                      <SelectGroup key={provider.id}>
                        <SelectLabel>{provider.name}</SelectLabel>
                        {getModelOptions(provider).map((model) => (
                          <SelectItem
                            key={encodeProviderSelection(
                              provider.id,
                              model.value,
                            )}
                            value={encodeProviderSelection(
                              provider.id,
                              model.value,
                            )}
                          >
                            {model.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
                {modelError && <FieldError>{modelError}</FieldError>}
                {resolvedModel && (
                  <ModelCapabilityNotice
                    passthroughFileTypes={resolvedModel.passthroughFileTypes}
                  />
                )}
              </Field>
            );
          })()}
          <FormTextField
            className="w-1/2"
            label="Max steps"
            name="maxSteps"
            type="number"
            min={AGENT_MAX_STEPS_MIN}
            value={String(formData.maxSteps)}
            onChange={(value) => setNumberField("maxSteps", value)}
            disabled={isSubmitting || readOnly}
            error={validationErrors.maxSteps}
            description="Controls when a tool-calling loop should stop based on the number of steps executed"
          />
        </FieldGroup>

        {toolSetsError && (
          <ToolSetsUnavailableNotice
            reason={toolSetsError}
            scope={orgScoped ? "organization" : "workspace"}
            hasExistingSelections={Boolean(agentId)}
          />
        )}

        {!toolSetsError && toolSets.length > 0 && (
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
                            disabled={isSubmitting || readOnly}
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
                      disabled={isSubmitting || readOnly}
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
                running as a Sub-Agent, these agents will not be able to
                delegate further.
              </FieldDescription>
              <FieldGroup className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {agents
                  .filter((a) => a.id !== agentId) // Only exclude self-assignment
                  .map((agent) => (
                    <Field key={agent.id} orientation="horizontal">
                      <Switch
                        id={`subagent-${agent.id}`}
                        className="cursor-pointer"
                        checked={formData.subAgentIds.includes(agent.id)}
                        onCheckedChange={(checked) => {
                          setFormData((prevData) => ({
                            ...prevData,
                            subAgentIds: checked
                              ? [...prevData.subAgentIds, agent.id]
                              : prevData.subAgentIds.filter(
                                  (id) => id !== agent.id,
                                ),
                          }));
                        }}
                        disabled={isSubmitting || readOnly}
                      />
                      <FieldLabel htmlFor={`subagent-${agent.id}`}>
                        <div className="flex items-center gap-2">
                          <AgentAvatar agent={agent} className="size-6" />
                          <div className="flex flex-col">
                            <p>{agent.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {agent.description || "No description"}
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
              <FormTextField
                label="Temperature"
                name="temperature"
                type="number"
                min="0"
                step="0.1"
                value={String(formData.temperature ?? "")}
                onChange={(value) => setFloatField("temperature", value)}
                disabled={isSubmitting || readOnly}
                error={validationErrors.temperature}
              />
              <FormTextField
                label="Seed"
                name="seed"
                type="number"
                value={String(formData.seed ?? "")}
                onChange={(value) => setNumberField("seed", value)}
                disabled={isSubmitting || readOnly}
                error={validationErrors.seed}
              />
              <FormTextField
                label="Top-p"
                name="topP"
                type="number"
                min="0"
                max="1"
                step="0.1"
                value={String(formData.topP ?? "")}
                onChange={(value) => setFloatField("topP", value)}
                disabled={isSubmitting || readOnly}
                error={validationErrors.topP}
              />
              <FormTextField
                label="Top-k"
                name="topK"
                type="number"
                min="1"
                value={String(formData.topK ?? "")}
                onChange={(value) => setNumberField("topK", value)}
                disabled={isSubmitting || readOnly}
                error={validationErrors.topK}
              />
              <FormTextField
                label="Presence Penalty"
                name="presencePenalty"
                type="number"
                min="-2"
                max="2"
                step="0.1"
                value={String(formData.presencePenalty ?? "")}
                onChange={(value) => setFloatField("presencePenalty", value)}
                disabled={isSubmitting || readOnly}
                error={validationErrors.presencePenalty}
              />
              <FormTextField
                label="Frequency Penalty"
                name="frequencyPenalty"
                type="number"
                min="-2"
                max="2"
                step="0.1"
                value={String(formData.frequencyPenalty ?? "")}
                onChange={(value) => setFloatField("frequencyPenalty", value)}
                disabled={isSubmitting || readOnly}
                error={validationErrors.frequencyPenalty}
              />
            </FieldGroup>
          </CollapsibleContent>
        </Collapsible>
      </FieldSet>

      <FormFooterButtons
        submitText={agentId ? "Update" : "Save"}
        onSubmit={() => void submit()}
        submitDisabled={isSubmitting || readOnly || !canSubmit}
        deleteVisible={!!agentId && !isOrgScoped}
        deleteDisabled={isSubmitting}
        onDelete={openDeleteDialog}
      />

      <EntityDeleteDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete Agent"
        description="Are you sure you want to delete this agent? This action cannot be undone."
        onConfirm={handleDelete}
        loading={isDeleting}
      />
    </div>
  );

  return (
    <DetailFormState
      isLoading={providersLoading || agentLoading}
      error={agentError}
      data={agent}
      subject="agent"
      backHref={doneHref}
      backLabel={orgScoped ? "Back to agents" : "Back to workspace"}
    >
      {form}
    </DetailFormState>
  );
};

export { AgentForm };
