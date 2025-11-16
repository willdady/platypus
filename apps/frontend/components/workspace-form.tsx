"use client";

import { Field, FieldLabel, FieldGroup, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { type Workspace } from "@agent-kit/schemas";

const WorkspaceForm = ({
  classNames,
  orgId,
}: {
  classNames?: string;
  orgId: string;
}) => {
  const [formData, setFormData] = useState({
    name: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const router = useRouter();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { id, value } = e.target;
    setFormData((prevData) => ({
      ...prevData,
      [id]: value,
    }));
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const payload: Omit<Workspace, "id" | "createdAt" | "updatedAt"> = {
        organisationId: orgId,
        name: formData.name,
      };

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/workspaces`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );

      if (response.ok) {
        const workspace = await response.json();
        router.push(`/${orgId}/workspace/${workspace.id}`);
      } else {
        // Handle error, e.g., show a toast notification
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
      <FieldSet>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              placeholder="Workspace name"
              value={formData.name}
              onChange={handleChange}
              disabled={isSubmitting}
            />
          </Field>
        </FieldGroup>
      </FieldSet>

      <Button
        className="cursor-pointer"
        onClick={handleSubmit}
        disabled={isSubmitting}
      >
        Create Workspace
      </Button>
    </div>
  );
};

export { WorkspaceForm };
