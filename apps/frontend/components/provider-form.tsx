"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldLegend,
  FieldDescription,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
import { useState } from "react";
import { useRouter } from "next/navigation";
import { type Provider } from "@agent-kit/schemas";

type ProviderFormData = Omit<
  Provider,
  "id" | "createdAt" | "updatedAt" | "workspaceId"
>;

const ProviderForm = ({
  classNames,
  orgId,
  workspaceId,
}: {
  classNames?: string;
  orgId: string;
  workspaceId: string;
}) => {
  const [formData, setFormData] = useState<ProviderFormData>({
    providerType: "OpenAI",
    name: "",
    apiKey: "",
    baseUrl: "",
    authType: "None",
    bearerToken: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const router = useRouter();

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const { id, value } = e.target;
    setFormData((prevData) => ({
      ...prevData,
      [id]: value,
    }));
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
        authType: formData.authType,
        bearerToken:
          formData.authType === "Bearer" ? formData.bearerToken : undefined,
      };

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/providers`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );

      if (response.ok) {
        router.push(`/${orgId}/workspace/${workspaceId}/settings`);
      } else {
        console.error("Failed to save provider");
      }
    } catch (error) {
      console.error("Error saving provider:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

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
              placeholder="https://api.openai.com/v1"
              value={formData.baseUrl}
              onChange={handleChange}
              disabled={isSubmitting}
            />
            <FieldDescription>
              Optional base URL for the provider.
            </FieldDescription>
          </Field>

          <FieldGroup className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="authType">Auth</FieldLabel>
              <Select
                value={formData.authType}
                onValueChange={(value) => handleSelectChange("authType", value)}
                disabled={isSubmitting}
              >
                <SelectTrigger disabled={isSubmitting}>
                  <SelectValue placeholder="Select authentication type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Authentication</SelectLabel>
                    <SelectItem value="None">None</SelectItem>
                    <SelectItem value="Bearer">Bearer</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            {formData.authType === "Bearer" && (
              <Field>
                <FieldLabel htmlFor="bearerToken">Bearer Token</FieldLabel>
                <Input
                  id="bearerToken"
                  type="password"
                  placeholder="Bearer token"
                  value={formData.bearerToken}
                  onChange={handleChange}
                  disabled={isSubmitting}
                />
              </Field>
            )}
          </FieldGroup>
        </FieldGroup>
      </FieldSet>

      <Button
        className="cursor-pointer"
        onClick={handleSubmit}
        disabled={isSubmitting}
      >
        Save
      </Button>
    </div>
  );
};

export { ProviderForm };
