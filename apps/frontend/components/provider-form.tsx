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
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Building, ChevronsUpDown, OctagonX, Trash2 } from "lucide-react";
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
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { type Provider } from "@platypus/schemas";
import useSWR from "swr";
import { parseValidationErrors, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";

type ProviderFormData = Omit<
  Provider,
  "id" | "createdAt" | "updatedAt" | "workspaceId"
> & {
  extraBody?: Record<string, unknown>;
};

const ProviderForm = ({
  classNames,
  orgId,
  workspaceId,
  providerId,
}: {
  classNames?: string;
  orgId: string;
  workspaceId?: string;
  providerId?: string;
}) => {
  // Add scope to Provider type for this component
  type ProviderWithScope = Provider & { scope: "organization" | "workspace" };

  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const router = useRouter();
  const hasInitialized = useRef(false);

  const formScope = workspaceId ? "workspace" : "organization";

  const [formData, setFormData] = useState<ProviderFormData>({
    providerType: "OpenAI",
    name: "",
    apiKey: "",
    region: "",
    baseUrl: "",
    headers: {},
    extraBody: {},
    organization: "",
    project: "",
    modelIds: [],
    taskModelId: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [headersError, setHeadersError] = useState<string | null>(null);
  const [headersString, setHeadersString] = useState("{}");
  const [extraBodyError, setExtraBodyError] = useState<string | null>(null);
  const [extraBodyString, setExtraBodyString] = useState("{}");
  const [modelIdsString, setModelIdsString] = useState("");
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});
  const [error, setError] = useState<string | null>(null);

  const fetcher = (url: string) =>
    fetch(url, { credentials: "include" }).then((res) => res.json());

  const fetchUrl =
    providerId && user
      ? formScope === "workspace"
        ? joinUrl(
            backendUrl,
            `/organizations/${orgId}/workspaces/${workspaceId}/providers/${providerId}`,
          )
        : joinUrl(backendUrl, `/organizations/${orgId}/providers/${providerId}`)
      : null;

  const { data: provider, isLoading } = useSWR<ProviderWithScope>(
    fetchUrl,
    fetcher,
  );

  useEffect(() => {
    if (provider && !hasInitialized.current) {
      setFormData({
        providerType: provider.providerType,
        name: provider.name,
        apiKey: provider.apiKey,
        region: provider.region || "",
        baseUrl: provider.baseUrl || "",
        headers: provider.headers || {},
        extraBody: provider.extraBody || {},
        organization: provider.organization || "",
        project: provider.project || "",
        modelIds: provider.modelIds || [],
        taskModelId: provider.taskModelId,
      });
      setHeadersString(JSON.stringify(provider.headers || {}, null, 2));
      setExtraBodyString(JSON.stringify(provider.extraBody || {}, null, 2));
      setModelIdsString((provider.modelIds || []).join("\n"));
      hasInitialized.current = true;
    }
  }, [provider]);

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
    setError(null);

    if (id === "headers") {
      setHeadersString(value);
      try {
        const parsed = JSON.parse(value);
        setFormData((prevData) => ({
          ...prevData,
          headers: parsed,
        }));
        setHeadersError(null);
      } catch {
        setHeadersError("Invalid JSON");
      }
    } else if (id === "extraBody") {
      setExtraBodyString(value);
      try {
        const parsed = JSON.parse(value);
        setFormData((prevData) => ({
          ...prevData,
          extraBody: parsed,
        }));
        setExtraBodyError(null);
      } catch {
        setExtraBodyError("Invalid JSON");
      }
    } else if (id === "modelIds") {
      setModelIdsString(value);
      const parsed = value
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      setFormData((prevData) => ({
        ...prevData,
        modelIds: parsed,
      }));
    } else {
      setFormData((prevData) => ({
        ...prevData,
        [id]: value,
      }));
    }
  };

  const handleSelectChange = (id: string, value: string) => {
    // Clear validation error for this field
    if (validationErrors[id]) {
      setValidationErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[id];
        return newErrors;
      });
    }
    setError(null);

    setFormData((prevData) => {
      const newData = { ...prevData, [id]: value };
      return newData;
    });
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setValidationErrors({});
    setError(null);
    try {
      const payload: Omit<Provider, "id" | "createdAt" | "updatedAt"> = {
        workspaceId: workspaceId || undefined,
        organizationId: !workspaceId ? orgId : undefined,
        name: formData.name,
        providerType: formData.providerType,
        apiKey: formData.apiKey,
        region: formData.region || undefined,
        baseUrl: formData.baseUrl || undefined,
        headers: formData.headers,
        extraBody: formData.extraBody,
        organization: formData.organization || undefined,
        project: formData.project || undefined,
        modelIds: formData.modelIds,
        taskModelId: formData.taskModelId,
      };

      const url = providerId
        ? formScope === "workspace"
          ? joinUrl(
              backendUrl,
              `/organizations/${orgId}/workspaces/${workspaceId}/providers/${providerId}`,
            )
          : joinUrl(
              backendUrl,
              `/organizations/${orgId}/providers/${providerId}`,
            )
        : formScope === "workspace"
          ? joinUrl(
              backendUrl,
              `/organizations/${orgId}/workspaces/${workspaceId}/providers`,
            )
          : joinUrl(backendUrl, `/organizations/${orgId}/providers`);

      const method = providerId ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        credentials: "include",
      });

      if (response.ok) {
        if (formScope === "workspace") {
          router.push(`/${orgId}/workspace/${workspaceId}/settings/providers`);
        } else {
          router.push(`/${orgId}/settings/providers`);
        }
      } else {
        const errorData = await response.json();
        if (response.status === 409) {
          setError(errorData.message || "A conflict occurred");
        } else {
          // Parse standardschema.dev validation errors
          setValidationErrors(parseValidationErrors(errorData));
        }
      }
    } catch (error) {
      console.error("Error saving provider:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!providerId) return;

    setIsDeleting(true);
    try {
      const deleteUrl =
        formScope === "workspace"
          ? joinUrl(
              backendUrl,
              `/organizations/${orgId}/workspaces/${workspaceId}/providers/${providerId}`,
            )
          : joinUrl(
              backendUrl,
              `/organizations/${orgId}/providers/${providerId}`,
            );

      const response = await fetch(deleteUrl, {
        method: "DELETE",
        credentials: "include",
      });

      if (response.ok) {
        if (formScope === "workspace") {
          router.push(`/${orgId}/workspace/${workspaceId}/settings/providers`);
        } else {
          router.push(`/${orgId}/settings/providers`);
        }
      } else {
        console.error("Failed to delete provider");
        setIsDeleting(false);
        setIsDeleteDialogOpen(false);
      }
    } catch (error) {
      console.error("Error deleting provider:", error);
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  if (isLoading) {
    return <div className={classNames}>Loading...</div>;
  }

  const isReadOnly = formScope === "workspace" && provider?.scope === "organization";

  return (
    <div className={classNames}>
      {error && (
        <div className="mb-6 p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive flex items-center gap-2">
          <OctagonX className="size-4" />
          {error}
        </div>
      )}
      {isReadOnly && (
        <div className="mb-6 p-4 rounded-lg bg-secondary/50 border border-secondary text-sm text-secondary-foreground flex items-center gap-2">
          <Building className="size-4" />
          This provider is managed at the organization level and cannot be
          edited from this workspace.
        </div>
      )}
      <FieldSet className="mb-6">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="providerType">Provider Type</FieldLabel>
            <Select
              value={formData.providerType}
              onValueChange={(value) =>
                handleSelectChange("providerType", value)
              }
              disabled={isSubmitting || isReadOnly}
            >
              <SelectTrigger disabled={isSubmitting || isReadOnly}>
                <SelectValue placeholder="Select a provider type" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Provider Types</SelectLabel>
                  <SelectItem value="Bedrock">Bedrock</SelectItem>
                  <SelectItem value="Google">Google</SelectItem>
                  <SelectItem value="OpenAI">OpenAI</SelectItem>
                  <SelectItem value="OpenRouter">OpenRouter</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field data-invalid={!!validationErrors.name}>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              placeholder="Name"
              value={formData.name}
              onChange={handleChange}
              disabled={isSubmitting || isReadOnly}
              aria-invalid={!!validationErrors.name}
              autoFocus
            />
            {validationErrors.name && (
              <FieldError>{validationErrors.name}</FieldError>
            )}
          </Field>

          <Field data-invalid={!!validationErrors.apiKey}>
            <FieldLabel htmlFor="apiKey">API Key</FieldLabel>
            <Input
              id="apiKey"
              type="password"
              placeholder="sk-..."
              value={formData.apiKey}
              onChange={handleChange}
              disabled={isSubmitting || isReadOnly}
              aria-invalid={!!validationErrors.apiKey}
            />
            {validationErrors.apiKey && (
              <FieldError>{validationErrors.apiKey}</FieldError>
            )}
          </Field>

          {formData.providerType === "Bedrock" && (
            <Field data-invalid={!!validationErrors.region}>
              <FieldLabel htmlFor="region">Region</FieldLabel>
              <Input
                id="region"
                placeholder="us-east-1"
                value={formData.region}
                onChange={handleChange}
                disabled={isSubmitting || isReadOnly}
                aria-invalid={!!validationErrors.region}
              />
              <FieldDescription>
                AWS region identifier (e.g., us-east-1, eu-west-1).
              </FieldDescription>
              {validationErrors.region && (
                <FieldError>{validationErrors.region}</FieldError>
              )}
            </Field>
          )}

          <Field data-invalid={!!validationErrors.baseUrl}>
            <FieldLabel htmlFor="baseUrl">Base URL</FieldLabel>
            <Input
              id="baseUrl"
              type="url"
              placeholder="https://api.example.com/"
              value={formData.baseUrl}
              onChange={handleChange}
              disabled={isSubmitting || isReadOnly}
              aria-invalid={!!validationErrors.baseUrl}
            />
            <FieldDescription>
              Optional base URL for the provider.
            </FieldDescription>
            {validationErrors.baseUrl && (
              <FieldError>{validationErrors.baseUrl}</FieldError>
            )}
          </Field>

          <Field data-invalid={!!validationErrors.modelIds}>
            <FieldLabel htmlFor="modelIds">Model IDs</FieldLabel>
            <Textarea
              id="modelIds"
              placeholder={["gpt-4", "gpt-3.5-turbo"].join("\n")}
              value={modelIdsString}
              onChange={handleChange}
              disabled={isSubmitting || isReadOnly}
              aria-invalid={!!validationErrors.modelIds}
            />
            <FieldDescription>
              Model IDs to allow for this provider. One per line.
            </FieldDescription>
            {validationErrors.modelIds && (
              <FieldError>{validationErrors.modelIds}</FieldError>
            )}
          </Field>

          <Field data-invalid={!!validationErrors.taskModelId}>
            <FieldLabel htmlFor="taskModelId">Task Model ID</FieldLabel>
            <Input
              id="taskModelId"
              placeholder="gpt-4"
              value={formData.taskModelId}
              onChange={handleChange}
              disabled={isSubmitting || isReadOnly}
              aria-invalid={!!validationErrors.taskModelId}
            />
            <FieldDescription>Model ID to use for tasks.</FieldDescription>
            {validationErrors.taskModelId && (
              <FieldError>{validationErrors.taskModelId}</FieldError>
            )}
          </Field>
        </FieldGroup>

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
          <CollapsibleContent>
            <FieldGroup>
              {formData.providerType === "OpenAI" && (
                <>
                  <Field data-invalid={!!validationErrors.organization}>
                    <FieldLabel htmlFor="organization">Organization</FieldLabel>
                    <Input
                      id="organization"
                      placeholder="org-..."
                      value={formData.organization}
                      onChange={handleChange}
                      disabled={isSubmitting || isReadOnly}
                      aria-invalid={!!validationErrors.organization}
                    />
                    <FieldDescription>OpenAI organization ID.</FieldDescription>
                    {validationErrors.organization && (
                      <FieldError>{validationErrors.organization}</FieldError>
                    )}
                  </Field>

                  <Field data-invalid={!!validationErrors.project}>
                    <FieldLabel htmlFor="project">Project</FieldLabel>
                    <Input
                      id="project"
                      placeholder="proj_..."
                      value={formData.project}
                      onChange={handleChange}
                      disabled={isSubmitting || isReadOnly}
                      aria-invalid={!!validationErrors.project}
                    />
                    <FieldDescription>OpenAI project ID.</FieldDescription>
                    {validationErrors.project && (
                      <FieldError>{validationErrors.project}</FieldError>
                    )}
                  </Field>
                </>
              )}

              <Field
                data-invalid={!!headersError || !!validationErrors.headers}
              >
                <FieldLabel htmlFor="headers">Headers</FieldLabel>
                <Textarea
                  id="headers"
                  placeholder='{"Header Name": "Header Value"}'
                  value={headersString}
                  onChange={handleChange}
                  disabled={isSubmitting || isReadOnly}
                  aria-invalid={!!headersError || !!validationErrors.headers}
                />
                <FieldDescription>
                  Optional headers as JSON object.
                </FieldDescription>
                {(headersError || validationErrors.headers) && (
                  <FieldError>
                    {headersError || validationErrors.headers}
                  </FieldError>
                )}
              </Field>

              {formData.providerType === "OpenRouter" && (
                <Field
                  data-invalid={
                    !!extraBodyError || !!validationErrors.extraBody
                  }
                >
                  <FieldLabel htmlFor="extraBody">Extra Body</FieldLabel>
                  <Textarea
                    id="extraBody"
                    placeholder='{"customField": "value"}'
                    value={extraBodyString}
                    onChange={handleChange}
                    disabled={isSubmitting || isReadOnly}
                    aria-invalid={
                      !!extraBodyError || !!validationErrors.extraBody
                    }
                  />
                  <FieldDescription>
                    Optional extra body parameters as JSON object.
                  </FieldDescription>
                  {(extraBodyError || validationErrors.extraBody) && (
                    <FieldError>
                      {extraBodyError || validationErrors.extraBody}
                    </FieldError>
                  )}
                </Field>
              )}
            </FieldGroup>
          </CollapsibleContent>
        </Collapsible>
      </FieldSet>

      {!isReadOnly && (
        <div className="flex gap-2">
          <Button
            className="cursor-pointer"
            onClick={handleSubmit}
            disabled={
              isSubmitting ||
              !!headersError ||
              !!extraBodyError ||
              Object.keys(validationErrors).length > 0
            }
          >
            {providerId ? "Update" : "Save"}
          </Button>

          {providerId && (
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
      )}

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
            <DialogTitle>Delete Provider</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this provider? This action cannot
              be undone.
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

export { ProviderForm };
