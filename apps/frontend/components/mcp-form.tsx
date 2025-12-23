"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
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
import { type MCP } from "@platypus/schemas";
import useSWR from "swr";
import { parseValidationErrors, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { Trash2, Plug, Check, X } from "lucide-react";

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
  const backendUrl = useBackendUrl();

  const [formData, setFormData] = useState<McpFormData>({
    name: "",
    url: "",
    authType: "None",
    bearerToken: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    toolNames?: string[];
    error?: string;
  } | null>(null);

  const router = useRouter();

  const fetcher = (url: string) => fetch(url).then((res) => res.json());
  const { data: mcp, isLoading } = useSWR<MCP>(
    mcpId
      ? joinUrl(
          backendUrl,
          `/organisations/${orgId}/workspaces/${workspaceId}/mcps/${mcpId}`,
        )
      : null,
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

    // Clear test result when form changes
    setTestResult(null);
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

    // Clear bearerToken error when authType changes
    if (id === "authType" && validationErrors.bearerToken) {
      setValidationErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors.bearerToken;
        return newErrors;
      });
    }

    setFormData((prevData) => ({
      ...prevData,
      [id]: value,
    }));

    // Clear test result when form changes
    setTestResult(null);
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setValidationErrors({});
    try {
      const payload: Omit<MCP, "id" | "createdAt" | "updatedAt"> = {
        workspaceId,
        name: formData.name,
        url: formData.url,
        authType: formData.authType,
        bearerToken:
          formData.authType === "Bearer" ? formData.bearerToken : undefined,
      };

      const url = mcpId
        ? joinUrl(
            backendUrl,
            `/organisations/${orgId}/workspaces/${workspaceId}/mcps/${mcpId}`,
          )
        : joinUrl(
            backendUrl,
            `/organisations/${orgId}/workspaces/${workspaceId}/mcps`,
          );

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
        // Parse standardschema.dev validation errors
        const errorData = await response.json();
        setValidationErrors(parseValidationErrors(errorData));
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
        joinUrl(
          backendUrl,
          `/organisations/${orgId}/workspaces/${workspaceId}/mcps/${mcpId}`,
        ),
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

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);

    try {
      const payload = {
        url: formData.url,
        authType: formData.authType,
        bearerToken:
          formData.authType === "Bearer" ? formData.bearerToken : undefined,
      };

      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organisations/${orgId}/workspaces/${workspaceId}/mcps/test`,
        ),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );

      const data = await response.json();

      if (response.ok && data.success) {
        setTestResult({
          success: true,
          toolNames: data.toolNames,
        });
      } else {
        setTestResult({
          success: false,
          error: data.error || "Failed to connect to MCP server",
        });
      }
    } catch (error) {
      setTestResult({
        success: false,
        error: error instanceof Error ? error.message : "Network error",
      });
    } finally {
      setIsTesting(false);
    }
  };

  if (isLoading) {
    return <div className={classNames}>Loading...</div>;
  }

  return (
    <div className={classNames}>
      <FieldSet className="mb-6">
        <FieldGroup>
          <Field data-invalid={!!validationErrors.name}>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              placeholder="My MCP Server"
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

          <Field data-invalid={!!validationErrors.url}>
            <FieldLabel htmlFor="url">URL</FieldLabel>
            <Input
              id="url"
              type="url"
              placeholder="https://example.com/mcp"
              value={formData.url}
              onChange={handleChange}
              disabled={isSubmitting}
              aria-invalid={!!validationErrors.url}
            />
            <FieldDescription>
              The URL endpoint for the MCP integration.
            </FieldDescription>
            {validationErrors.url && (
              <FieldError>{validationErrors.url}</FieldError>
            )}
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
              <Field
                className="col-span-2"
                data-invalid={!!validationErrors.bearerToken}
              >
                <FieldLabel htmlFor="bearerToken">Bearer Token</FieldLabel>
                <Input
                  id="bearerToken"
                  type="password"
                  placeholder="Bearer token"
                  value={formData.bearerToken}
                  onChange={handleChange}
                  disabled={isSubmitting}
                  aria-invalid={!!validationErrors.bearerToken}
                />
                {validationErrors.bearerToken && (
                  <FieldError>{validationErrors.bearerToken}</FieldError>
                )}
              </Field>
            )}
          </FieldGroup>
        </FieldGroup>

        {/* Test Connection Section */}
        <div className="space-y-3">
          <Button
            type="button"
            variant="outline"
            className="cursor-pointer"
            onClick={handleTestConnection}
            disabled={isTesting || isSubmitting || !formData.url}
          >
            <Plug />
            {isTesting ? "Testing..." : "Test Connection"}
          </Button>

          {/* Display test results */}
          {testResult && (
            <Alert
              variant={testResult.success ? "default" : "destructive"}
              className={
                testResult.success
                  ? "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/20 dark:text-green-300 [&>svg]:text-green-600 dark:[&>svg]:text-green-400"
                  : ""
              }
            >
              {testResult.success ? <Check /> : <X />}
              <AlertTitle>
                {testResult.success
                  ? "Connection successful"
                  : "Connection failed"}
              </AlertTitle>
              <AlertDescription>
                {testResult.success ? (
                  <div className="space-y-2">
                    <p>
                      Found {testResult.toolNames?.length || 0} tool
                      {(testResult.toolNames?.length || 0) !== 1 ? "s" : ""}
                    </p>
                    {testResult.toolNames &&
                      testResult.toolNames.length > 0 && (
                        <div className="mt-2">
                          <p className="text-xs font-medium mb-1">
                            Available tools:
                          </p>
                          <div className="flex flex-wrap gap-1">
                            {testResult.toolNames.map((name) => (
                              <span
                                key={name}
                                className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono bg-muted text-muted-foreground"
                              >
                                {name}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                  </div>
                ) : (
                  <p>{testResult.error}</p>
                )}
              </AlertDescription>
            </Alert>
          )}
        </div>
      </FieldSet>

      <div className="flex gap-2">
        <Button
          className="cursor-pointer"
          onClick={handleSubmit}
          disabled={
            isSubmitting ||
            isTesting ||
            Object.keys(validationErrors).length > 0
          }
        >
          {mcpId ? "Update" : "Save"}
        </Button>

        {mcpId && (
          <Button
            className="cursor-pointer"
            variant="outline"
            onClick={() => setIsDeleteDialogOpen(true)}
            disabled={isSubmitting || isTesting}
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
            <DialogTitle>Delete MCP server</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this MCP server? This action
              cannot be undone.
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
