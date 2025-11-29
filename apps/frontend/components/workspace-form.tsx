"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldError,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { type Workspace } from "@agent-kit/schemas";
import { parseValidationErrors } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";

const WorkspaceForm = ({
  classNames,
  orgId,
}: {
  classNames?: string;
  orgId: string;
}) => {
  const backendUrl = useBackendUrl();

  const [formData, setFormData] = useState({
    name: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  const router = useRouter();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
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
      const payload: Omit<Workspace, "id" | "createdAt" | "updatedAt"> = {
        organisationId: orgId,
        name: formData.name,
      };

      const response = await fetch(`${backendUrl}/workspaces`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const workspace = await response.json();
        router.push(`/${orgId}/workspace/${workspace.id}`);
      } else {
        // Parse standardschema.dev validation errors
        const errorData = await response.json();
        setValidationErrors(parseValidationErrors(errorData));
        console.error("Failed to save workspace");
      }
    } catch (error) {
      console.error("Error saving workspace:", error);
    } finally {
      setIsSubmitting(false);
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
        </FieldGroup>
      </FieldSet>

      <Button
        className="cursor-pointer"
        onClick={handleSubmit}
        disabled={isSubmitting || Object.keys(validationErrors).length > 0}
      >
        Save
      </Button>
    </div>
  );
};

export { WorkspaceForm };
