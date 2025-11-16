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

type ProviderFormData = Omit<
  Provider,
  "id" | "createdAt" | "updatedAt" | "workspaceId"
>;

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
  const [formData, setFormData] = useState<ProviderFormData>({
    providerType: "OpenAI",
    name: "",
    apiKey: "",
    baseUrl: "",
    headers: {},
    modelIds: [],
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [headersError, setHeadersError] = useState<string | null>(null);
  const [headersString, setHeadersString] = useState("{}");
  const [modelIdsString, setModelIdsString] = useState("");
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const router = useRouter();

  const fetcher = (url: string) => fetch(url).then((res) => res.json());
  const { data: provider, isLoading } = useSWR<Provider>(
    providerId
      ? `${process.env.NEXT_PUBLIC_BACKEND_URL}/providers/${providerId}`
      : null,
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
        modelIds: provider.modelIds || [],
      });
      setHeadersString(JSON.stringify(provider.headers || {}, null, 2));
      setModelIdsString((provider.modelIds || []).join("\n"));
    }
  }, [provider]);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const { id, value } = e.target;
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
    setFormData((prevData) => ({
      ...prevData,
      [id]: value,
    }));
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const payload: Omit<Provider, "id" | "createdAt" | "updatedAt"> = {
        workspaceId,
        name: formData.name,
        providerType: formData.providerType,
        apiKey: formData.apiKey,
        baseUrl: formData.baseUrl || undefined,
        headers: formData.headers,
        modelIds: formData.modelIds,
      };

      const url = providerId
        ? `${process.env.NEXT_PUBLIC_BACKEND_URL}/providers/${providerId}`
        : `${process.env.NEXT_PUBLIC_BACKEND_URL}/providers`;

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
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/providers/${providerId}`,
        {
          method: "DELETE",
        },
      );

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
      <FieldSet className="mb-4">
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

          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              placeholder="Name"
              value={formData.name}
              onChange={handleChange}
              disabled={isSubmitting}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="apiKey">API Key</FieldLabel>
            <Input
              id="apiKey"
              type="password"
              placeholder="sk-..."
              value={formData.apiKey}
              onChange={handleChange}
              disabled={isSubmitting}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="baseUrl">Base URL</FieldLabel>
            <Input
              id="baseUrl"
              type="url"
              placeholder="https://api.example.com/"
              value={formData.baseUrl}
              onChange={handleChange}
              disabled={isSubmitting}
            />
            <FieldDescription>
              Optional base URL for the provider.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="modelIds">Model IDs</FieldLabel>
            <Textarea
              id="modelIds"
              placeholder={["gpt-4", "gpt-3.5-turbo"].join("\n")}
              value={modelIdsString}
              onChange={handleChange}
              disabled={isSubmitting}
            />
            <FieldDescription>
              Model IDs to allow for this provider. One per line.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="headers">Headers</FieldLabel>
            <Textarea
              id="headers"
              placeholder='{"Header Name": "Header Value"}'
              value={headersString}
              onChange={handleChange}
              disabled={isSubmitting}
            />
            <FieldDescription>
              Optional headers as JSON object.
            </FieldDescription>
            {headersError && <FieldError>{headersError}</FieldError>}
          </Field>
        </FieldGroup>
      </FieldSet>

      <div className="flex gap-2">
        <Button
          className="cursor-pointer"
          onClick={handleSubmit}
          disabled={isSubmitting || !!headersError}
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
            Delete
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
