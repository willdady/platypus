"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
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
import { type MCP } from "@agent-kit/schemas";
import useSWR from "swr";

type McpFormData = Omit<MCP, "id" | "createdAt" | "updatedAt" | "workspaceId">;

const McpForm = ({
  classNames,
  orgId,
  workspaceId,
  mcpId,
}: {
  classNames?: string;
  orgId: string;
  workspaceId: string;
  mcpId?: string;
}) => {
  const [formData, setFormData] = useState<McpFormData>({
    name: "",
    url: "",
    authType: "None",
    bearerToken: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const router = useRouter();

  const fetcher = (url: string) => fetch(url).then((res) => res.json());
  const { data: mcp, isLoading } = useSWR<MCP>(
    mcpId ? `${process.env.NEXT_PUBLIC_BACKEND_URL}/mcps/${mcpId}` : null,
    fetcher,
  );

  useEffect(() => {
    if (mcp) {
      setFormData({
        name: mcp.name,
        url: mcp.url || "",
        authType: mcp.authType,
        bearerToken: mcp.bearerToken || "",
      });
    }
  }, [mcp]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
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
      const payload: Omit<MCP, "id" | "createdAt" | "updatedAt"> = {
        workspaceId,
        name: formData.name,
        url: formData.url || undefined,
        authType: formData.authType,
        bearerToken:
          formData.authType === "Bearer" ? formData.bearerToken : undefined,
      };

      const url = mcpId
        ? `${process.env.NEXT_PUBLIC_BACKEND_URL}/mcps/${mcpId}`
        : `${process.env.NEXT_PUBLIC_BACKEND_URL}/mcps`;

      const method = mcpId ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        router.push(`/${orgId}/workspace/${workspaceId}/settings/mcp`);
      } else {
        console.error("Failed to save MCP");
      }
    } catch (error) {
      console.error("Error saving MCP:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!mcpId) return;

    setIsDeleting(true);
    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/mcps/${mcpId}`,
        {
          method: "DELETE",
        },
      );

      if (response.ok) {
        router.push(`/${orgId}/workspace/${workspaceId}/settings/mcp`);
      } else {
        console.error("Failed to delete MCP");
        setIsDeleting(false);
        setIsDeleteDialogOpen(false);
      }
    } catch (error) {
      console.error("Error deleting MCP:", error);
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
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              placeholder="My MCP Server"
              value={formData.name}
              onChange={handleChange}
              disabled={isSubmitting}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="url">URL</FieldLabel>
            <Input
              id="url"
              type="url"
              placeholder="https://example.com/mcp"
              value={formData.url}
              onChange={handleChange}
              disabled={isSubmitting}
            />
            <FieldDescription>
              The URL endpoint for the MCP integration.
            </FieldDescription>
          </Field>

          <FieldGroup className="grid grid-cols-3 gap-4">
            <Field className="col-span-1">
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
              <Field className="col-span-2">
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

      <div className="flex gap-2">
        <Button
          className="cursor-pointer"
          onClick={handleSubmit}
          disabled={isSubmitting}
        >
          {mcpId ? "Update" : "Save"}
        </Button>

        {mcpId && (
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
            <DialogTitle>Delete MCP server</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this MCP server? This action cannot be
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

export { McpForm };
