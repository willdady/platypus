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
import { type Provider } from "@agent-kit/schemas";
import useSWR from "swr";
import { parseValidationErrors } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";

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
  workspaceId: string;
  providerId?: string;
}) => {
  const backendUrl = useBackendUrl();

  const [formData, setFormData] = useState<ProviderFormData>({
    providerType: "OpenAI",
    name: "",
    apiKey: "",
    baseUrl: "",
    headers: {},
    extraBody: {},
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

  const router = useRouter();

  const fetcher = (url: string) => fetch(url).then((res) => res.json());
  const { data: provider, isLoading } = useSWR<Provider>(
    providerId ? `${backendUrl}/providers/${providerId}` : null,
    fetcher,
  );

  useEffect(() => {
    if (provider) {
      setFormData({
        providerType: provider.providerType,
        name: provider.name,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl || "",
        headers: provider.headers || {},
        extraBody: provider.extraBody || {},
        modelIds: provider.modelIds || [],
        taskModelId: provider.taskModelId,
      });
      setHeadersString(JSON.stringify(provider.headers || {}, null, 2));
      setExtraBodyString(JSON.stringify(provider.extraBody || {}, null, 2));
      setModelIdsString((provider.modelIds || []).join("\n"));
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

    setFormData((prevData) => ({
      ...prevData,
      [id]: value,
    }));
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setValidationErrors({});
    try {
      const payload: Omit<Provider, "id" | "createdAt" | "updatedAt"> = {
        workspaceId,
        name: formData.name,
        providerType: formData.providerType,
        apiKey: formData.apiKey,
        baseUrl: formData.baseUrl || undefined,
        headers: formData.headers,
        extraBody: formData.extraBody,
        modelIds: formData.modelIds,
        taskModelId: formData.taskModelId,
      };

      const url = providerId
        ? `${backendUrl}/providers/${providerId}`
        : `${backendUrl}/providers`;

      const method = providerId ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        router.push(`/${orgId}/workspace/${workspaceId}/settings/providers`);
      } else {
        // Parse standardschema.dev validation errors
        const errorData = await response.json();
        setValidationErrors(parseValidationErrors(errorData));
        console.error("Failed to save provider");
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
      const response = await fetch(`${backendUrl}/providers/${providerId}`, {
        method: "DELETE",
      });

      if (response.ok) {
        router.push(`/${orgId}/workspace/${workspaceId}/settings/providers`);
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

  return (
    <div className={classNames}>
      <FieldSet className="mb-6">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="providerType">Provider Type</FieldLabel>
            <Select
              value={formData.providerType}
              onValueChange={(value) =>
                handleSelectChange("providerType", value)
              }
              disabled={isSubmitting}
            >
              <SelectTrigger disabled={isSubmitting}>
                <SelectValue placeholder="Select a provider type" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Provider Types</SelectLabel>
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
              disabled={isSubmitting}
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
              disabled={isSubmitting}
              aria-invalid={!!validationErrors.apiKey}
            />
            {validationErrors.apiKey && (
              <FieldError>{validationErrors.apiKey}</FieldError>
            )}
          </Field>

          <Field data-invalid={!!validationErrors.baseUrl}>
            <FieldLabel htmlFor="baseUrl">Base URL</FieldLabel>
            <Input
              id="baseUrl"
              type="url"
              placeholder="https://api.example.com/"
              value={formData.baseUrl}
              onChange={handleChange}
              disabled={isSubmitting}
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
              disabled={isSubmitting}
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
              disabled={isSubmitting}
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
              <Field
                data-invalid={!!headersError || !!validationErrors.headers}
              >
                <FieldLabel htmlFor="headers">Headers</FieldLabel>
                <Textarea
                  id="headers"
                  placeholder='{"Header Name": "Header Value"}'
                  value={headersString}
                  onChange={handleChange}
                  disabled={isSubmitting}
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
                    disabled={isSubmitting}
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
