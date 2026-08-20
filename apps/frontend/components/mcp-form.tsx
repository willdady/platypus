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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
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
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useState, useEffect } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useRouter } from "next/navigation";
import { type MCP } from "@platypus/schemas";
import useSWR, { useSWRConfig } from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { canSubmitForm, retractFieldError } from "@/lib/form-errors";
import { writeEntity, writeAt } from "@/lib/api-write";
import { toast } from "sonner";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import {
  Trash2,
  Plug,
  Check,
  X,
  ExternalLink,
  Eye,
  EyeOff,
  ShieldCheck,
  ShieldOff,
  Plus,
} from "lucide-react";
import {
  OAUTH_MCP_SUCCESS_EVENT,
  OAUTH_MCP_ERROR_EVENT,
} from "@/lib/constants";

type HeaderRow = { key: string; value: string };

type McpFormData = Omit<
  MCP,
  "id" | "createdAt" | "updatedAt" | "workspaceId" | "oauthAuthorized"
> & {
  headerRows: HeaderRow[];
};

const RETRACTABLE_FIELDS = [
  "name",
  "url",
  "bearerToken",
  "oauthClientId",
  "oauthClientSecret",
  "oauthRequestedScope",
] as const;

const McpForm = ({
  classNames,
  orgId,
  workspaceId,
  mcpId,
}: {
  classNames?: string;
  orgId: string;
  workspaceId?: string;
  mcpId?: string;
}) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  // An MCP is scoped to either a Workspace or the Organization (ADR-0007).
  // The scope determines the backend collection and the settings/edit paths.
  const collectionUrl = workspaceId
    ? `/organizations/${orgId}/workspaces/${workspaceId}/mcps`
    : `/organizations/${orgId}/mcps`;
  const listPath = workspaceId
    ? `/${orgId}/workspace/${workspaceId}/settings/mcp`
    : `/${orgId}/settings/mcp`;
  const editPath = (id: string) =>
    workspaceId
      ? `/${orgId}/workspace/${workspaceId}/settings/mcp/${id}`
      : `/${orgId}/settings/mcp/${id}`;

  const [formData, setFormData] = useState<McpFormData>({
    name: "",
    url: "",
    authType: "None",
    bearerToken: "",
    oauthClientId: "",
    oauthClientSecret: "",
    oauthRequestedScope: "",
    headerRows: [],
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});
  const [showBearerToken, setShowBearerToken] = useState(false);
  const [showOauthClientSecret, setShowOauthClientSecret] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    toolNames?: string[];
    error?: string;
  } | null>(null);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);

  const router = useRouter();
  const { mutate: globalMutate } = useSWRConfig();

  const {
    data: mcp,
    isLoading,
    mutate: mutateMcp,
  } = useSWR<MCP & { oauthAuthorized?: boolean }>(
    mcpId && user ? joinUrl(backendUrl, `${collectionUrl}/${mcpId}`) : null,
    fetcher,
  );

  useResetOnChange(mcp, () => {
    if (mcp) {
      const existingHeaders = (mcp as { headers?: Record<string, string> })
        .headers;
      const headerRows: HeaderRow[] = existingHeaders
        ? Object.entries(existingHeaders).map(([key, value]) => ({
            key,
            value,
          }))
        : [];
      setFormData({
        name: mcp.name,
        url: mcp.url || "",
        authType: mcp.authType,
        bearerToken: mcp.bearerToken || "",
        oauthClientId: mcp.oauthClientId || "",
        oauthClientSecret: "",
        oauthRequestedScope: mcp.oauthRequestedScope || "",
        headerRows,
      });
    }
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { id, value } = e.target;

    // Clear the error for this field, including any reported against a path
    // inside it.
    setValidationErrors((prev) => retractFieldError(prev, id));

    setFormData((prevData) => ({
      ...prevData,
      [id]: value,
    }));

    // Clear test result when form changes
    setTestResult(null);
  };

  const handleSelectChange = (id: string, value: string) => {
    // Clear the error for this field, including any reported against a path
    // inside it. Switching authType away from bearer also retracts a stale
    // bearerToken error: that field disappears from the form, so nothing
    // could otherwise clear it.
    setValidationErrors((prev) =>
      id === "authType"
        ? retractFieldError(retractFieldError(prev, id), "bearerToken")
        : retractFieldError(prev, id),
    );

    setFormData((prevData) => ({
      ...prevData,
      [id]: value,
    }));

    // Clear test result when form changes
    setTestResult(null);
  };

  /** Convert headerRows to a Record, filtering out empty keys */
  const buildHeadersObject = (): Record<string, string> | undefined => {
    const headers: Record<string, string> = {};
    for (const row of formData.headerRows) {
      const key = row.key.trim();
      if (key) {
        headers[key] = row.value;
      }
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
  };

  /** Builds the save payload from current form state */
  const buildPayload = () => {
    const payload: Record<string, unknown> = {
      // Scope discriminator — the backend routes also enforce this from the
      // URL, but sending it keeps the create payload self-describing.
      ...(workspaceId ? { workspaceId } : { organizationId: orgId }),
      name: formData.name,
      url: formData.url,
      headers: buildHeadersObject(),
      authType: formData.authType,
      bearerToken:
        formData.authType === "Bearer" ? formData.bearerToken : undefined,
      oauthClientId:
        formData.authType === "OAuth" ? formData.oauthClientId : undefined,
      oauthClientSecret:
        formData.authType === "OAuth" && formData.oauthClientSecret
          ? formData.oauthClientSecret
          : undefined,
      oauthRequestedScope:
        formData.authType === "OAuth" && formData.oauthRequestedScope?.trim()
          ? formData.oauthRequestedScope.trim()
          : undefined,
    };
    return payload;
  };

  /**
   * Saves the MCP (create or update). Returns the saved record's ID on
   * success, or null on failure.
   */
  const saveMcp = async (existingId?: string): Promise<string | null> => {
    setValidationErrors({});
    const payload = buildPayload();
    const scope = workspaceId ? { orgId, workspaceId } : { orgId };

    const result = await writeEntity<{ id: string }>(
      backendUrl,
      "mcps",
      scope,
      { id: existingId, data: payload },
    );

    switch (result.outcome) {
      case "success":
        result.revalidateKeys.forEach((key) => globalMutate(key));
        return result.data.id;
      case "invalid":
        setValidationErrors(result.fieldErrors);
        if (Object.keys(result.fieldErrors).length === 0) {
          toast.error(result.message);
        }
        return null;
      case "conflict":
        setValidationErrors({ name: result.message });
        return null;
      case "locked":
        // Guidance, not a failure — the backend's message already says
        // where the Shared resource is actually managed (#570).
        toast.info(result.message);
        return null;
      case "notFound":
      case "error":
        toast.error(result.message);
        return null;
    }
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const savedId = await saveMcp(mcpId);
      if (savedId) {
        router.push(listPath);
      }
    } catch (error) {
      console.error("Error saving MCP:", error);
      toast.error("Failed to save MCP server");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!mcpId) return;

    setIsDeleting(true);
    const scope = workspaceId ? { orgId, workspaceId } : { orgId };
    const result = await writeEntity(backendUrl, "mcps", scope, {
      id: mcpId,
    });

    if (result.outcome === "success") {
      result.revalidateKeys.forEach((key) => globalMutate(key));
      router.push(listPath);
    } else if (result.outcome === "locked") {
      // Guidance, not a failure — the backend's message already says where
      // the Shared resource is actually managed (#570).
      toast.info(result.message);
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    } else {
      toast.error(result.message);
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);

    try {
      const payload: Record<string, unknown> = {
        url: formData.url,
        headers: buildHeadersObject(),
        authType: formData.authType,
        bearerToken:
          formData.authType === "Bearer" ? formData.bearerToken : undefined,
      };

      // For OAuth, include mcpId so the backend can use stored tokens
      if (formData.authType === "OAuth" && mcpId) {
        payload.mcpId = mcpId;
      }

      const outcome = await writeAt<{
        success: boolean;
        toolNames?: string[];
        error?: string;
      }>(joinUrl(backendUrl, `${collectionUrl}/test`), {
        method: "POST",
        data: payload,
      });

      if (outcome.outcome === "success" && outcome.data.success) {
        setTestResult({
          success: true,
          toolNames: outcome.data.toolNames,
        });
      } else if (outcome.outcome === "success") {
        setTestResult({
          success: false,
          error: outcome.data.error || "Failed to connect to MCP server",
        });
      } else {
        setTestResult({
          success: false,
          error: outcome.message,
        });
      }
    } finally {
      setIsTesting(false);
    }
  };

  // Listen for OAuth completion messages from the popup window
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === OAUTH_MCP_SUCCESS_EVENT) {
        mutateMcp();
        toast.success("OAuth authorization completed");
        setIsAuthorizing(false);
      } else if (event.data?.type === OAUTH_MCP_ERROR_EVENT) {
        toast.error(event.data.message || "OAuth authorization failed");
        setIsAuthorizing(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [mutateMcp]);

  const handleOAuthAuthorize = async () => {
    setIsAuthorizing(true);

    try {
      // If the MCP hasn't been saved yet, save it first
      let resolvedMcpId = mcpId;
      if (!resolvedMcpId) {
        resolvedMcpId = (await saveMcp()) ?? undefined;
        if (!resolvedMcpId) {
          // Validation errors were set by saveMcp
          setIsAuthorizing(false);
          return;
        }
      } else {
        // Save any pending changes (e.g. newly entered client credentials)
        const savedId = await saveMcp(resolvedMcpId);
        if (!savedId) {
          setIsAuthorizing(false);
          return;
        }
      }

      // When the MCP already holds an access token, ask the backend to wipe
      // it before running mcpAuth so the OAuth flow is always entered. Without
      // ?force=true a valid refresh token causes mcpAuth to silently rotate
      // and return alreadyAuthorized — which is fine on a normal page load
      // but surprising when the user just clicked "Reauthorize".
      const authorizeUrl = joinUrl(
        backendUrl,
        `${collectionUrl}/${resolvedMcpId}/oauth/authorize${
          oauthAuthorized ? "?force=true" : ""
        }`,
      );
      const outcome = await writeAt<{
        alreadyAuthorized?: boolean;
        authorizationUrl?: string;
        error?: string;
      }>(authorizeUrl, { method: "POST" });

      if (outcome.outcome !== "success") {
        toast.error(outcome.message);
        if (!mcpId && resolvedMcpId) {
          router.replace(editPath(resolvedMcpId));
        }
        setIsAuthorizing(false);
        return;
      }
      const data = outcome.data;

      if (data.alreadyAuthorized) {
        // Backend silently refreshed via stored refresh_token. Treat as
        // success rather than an error toast.
        toast.success("Already authorized");
        mutateMcp();
        setIsAuthorizing(false);
        return;
      }

      if (data.authorizationUrl) {
        // If we just created the MCP, redirect to the edit page so the URL
        // reflects the new mcpId and any later actions (retries, save,
        // re-authorize) update the existing record instead of creating
        // duplicates.
        if (!mcpId && resolvedMcpId) {
          router.replace(editPath(resolvedMcpId));
        }
        // Open OAuth in a popup so the main page is never navigated away.
        // This avoids bfcache issues where the browser restores stale auth
        // state when the user clicks the Back button.
        const width = 600;
        const height = 700;
        const left = window.screenX + (window.outerWidth - width) / 2;
        const top = window.screenY + (window.outerHeight - height) / 2;
        const popup = window.open(
          data.authorizationUrl,
          "mcp-oauth",
          `width=${width},height=${height},left=${left},top=${top},popup=yes`,
        );

        // If the popup was blocked, fall back to same-window redirect
        if (!popup) {
          window.location.replace(data.authorizationUrl);
        } else {
          // Reset Authorize button when popup closes without success
          // (e.g. upstream provider rejects with 400 — no postMessage fires).
          const interval = setInterval(() => {
            if (popup.closed) {
              clearInterval(interval);
              setIsAuthorizing(false);
            }
          }, 500);
        }
      } else {
        toast.error(data.error || "Failed to start OAuth authorization");

        // If we just created the MCP, redirect to the edit page so
        // subsequent actions (e.g. re-authorize) use the correct mcpId
        if (!mcpId && resolvedMcpId) {
          router.replace(editPath(resolvedMcpId));
        }
        setIsAuthorizing(false);
      }
    } catch (error) {
      console.error("OAuth authorize error:", error);
      toast.error("Failed to start OAuth authorization");
      setIsAuthorizing(false);
    }
  };

  const handleOAuthRevoke = async () => {
    if (!mcpId) return;
    setIsRevoking(true);

    const outcome = await writeAt(
      joinUrl(backendUrl, `${collectionUrl}/${mcpId}/oauth/revoke`),
      { method: "POST" },
    );

    if (outcome.outcome === "success") {
      toast.success("OAuth authorization revoked");
      mutateMcp();
      setTestResult(null);
    } else {
      toast.error(outcome.message);
    }
    setIsRevoking(false);
  };

  if (isLoading) {
    return <div className={classNames}>Loading...</div>;
  }

  const oauthAuthorized = mcp?.oauthAuthorized === true;

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
                    <SelectItem value="OAuth">OAuth</SelectItem>
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
                <InputGroup>
                  <InputGroupInput
                    id="bearerToken"
                    type={showBearerToken ? "text" : "password"}
                    placeholder="Bearer token"
                    value={formData.bearerToken}
                    onChange={handleChange}
                    disabled={isSubmitting}
                    aria-invalid={!!validationErrors.bearerToken}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      type="button"
                      size="icon-xs"
                      onClick={() => setShowBearerToken(!showBearerToken)}
                      disabled={isSubmitting}
                      aria-label={
                        showBearerToken
                          ? "Hide bearer token"
                          : "Show bearer token"
                      }
                    >
                      {showBearerToken ? <EyeOff /> : <Eye />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                {validationErrors.bearerToken && (
                  <FieldError>{validationErrors.bearerToken}</FieldError>
                )}
              </Field>
            )}
          </FieldGroup>

          {/* OAuth Client Credentials */}
          {formData.authType === "OAuth" && (
            <FieldGroup className="grid grid-cols-2 gap-4">
              <Field data-invalid={!!validationErrors.oauthClientId}>
                <FieldLabel htmlFor="oauthClientId">Client ID</FieldLabel>
                <Input
                  id="oauthClientId"
                  placeholder="OAuth Client ID"
                  value={formData.oauthClientId}
                  onChange={handleChange}
                  disabled={isSubmitting}
                  aria-invalid={!!validationErrors.oauthClientId}
                />
                {validationErrors.oauthClientId && (
                  <FieldError>{validationErrors.oauthClientId}</FieldError>
                )}
              </Field>

              <Field data-invalid={!!validationErrors.oauthClientSecret}>
                <FieldLabel htmlFor="oauthClientSecret">
                  Client Secret
                </FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="oauthClientSecret"
                    type={showOauthClientSecret ? "text" : "password"}
                    placeholder={
                      mcpId && mcp?.oauthClientId
                        ? "Leave blank to keep current"
                        : "OAuth Client Secret"
                    }
                    value={formData.oauthClientSecret}
                    onChange={handleChange}
                    disabled={isSubmitting}
                    aria-invalid={!!validationErrors.oauthClientSecret}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      type="button"
                      size="icon-xs"
                      onClick={() =>
                        setShowOauthClientSecret(!showOauthClientSecret)
                      }
                      disabled={isSubmitting}
                      aria-label={
                        showOauthClientSecret
                          ? "Hide client secret"
                          : "Show client secret"
                      }
                    >
                      {showOauthClientSecret ? <EyeOff /> : <Eye />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                {validationErrors.oauthClientSecret && (
                  <FieldError>{validationErrors.oauthClientSecret}</FieldError>
                )}
              </Field>
              <FieldDescription className="col-span-2">
                Leave blank if the server supports dynamic client registration.
              </FieldDescription>

              <Field
                className="col-span-2"
                data-invalid={!!validationErrors.oauthRequestedScope}
              >
                <FieldLabel htmlFor="oauthRequestedScope">
                  OAuth Scopes
                </FieldLabel>
                <Input
                  id="oauthRequestedScope"
                  placeholder="e.g. https://www.googleapis.com/auth/calendar"
                  value={formData.oauthRequestedScope || ""}
                  onChange={handleChange}
                  disabled={isSubmitting}
                  aria-invalid={!!validationErrors.oauthRequestedScope}
                />
                <FieldDescription>
                  Space-separated list of OAuth scopes to request. Required by
                  some providers (e.g. Google) that reject authorize requests
                  without an explicit scope parameter.
                </FieldDescription>
                {validationErrors.oauthRequestedScope && (
                  <FieldError>
                    {validationErrors.oauthRequestedScope}
                  </FieldError>
                )}
              </Field>
            </FieldGroup>
          )}

          {/* Custom Headers */}
          <div className="space-y-3">
            <div className="space-y-1">
              <FieldLabel>Custom Headers</FieldLabel>
              <FieldDescription>
                Optional HTTP headers sent with every request to the MCP server.
              </FieldDescription>
            </div>
            {formData.headerRows.map((row, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  placeholder="Header Name"
                  value={row.key}
                  onChange={(e) => {
                    const newRows = [...formData.headerRows];
                    newRows[index] = { ...newRows[index], key: e.target.value };
                    setFormData((prev) => ({
                      ...prev,
                      headerRows: newRows,
                    }));
                    setTestResult(null);
                  }}
                  disabled={isSubmitting}
                />
                <Input
                  placeholder="Header Value"
                  value={row.value}
                  onChange={(e) => {
                    const newRows = [...formData.headerRows];
                    newRows[index] = {
                      ...newRows[index],
                      value: e.target.value,
                    };
                    setFormData((prev) => ({
                      ...prev,
                      headerRows: newRows,
                    }));
                    setTestResult(null);
                  }}
                  disabled={isSubmitting}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0 cursor-pointer"
                  onClick={() => {
                    const newRows = formData.headerRows.filter(
                      (_, i) => i !== index,
                    );
                    setFormData((prev) => ({
                      ...prev,
                      headerRows: newRows,
                    }));
                    setTestResult(null);
                  }}
                  disabled={isSubmitting}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="cursor-pointer"
              onClick={() =>
                setFormData((prev) => ({
                  ...prev,
                  headerRows: [...prev.headerRows, { key: "", value: "" }],
                }))
              }
              disabled={isSubmitting}
            >
              <Plus className="h-4 w-4" />
              Add header
            </Button>
          </div>

          {/* OAuth Authorization Section */}
          {formData.authType === "OAuth" && (
            <div className="space-y-3">
              {oauthAuthorized ? (
                <Alert className="border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/20 dark:text-green-300 [&>svg]:text-green-600 dark:[&>svg]:text-green-400">
                  <ShieldCheck />
                  <AlertTitle>Authorized</AlertTitle>
                  <AlertDescription>
                    This MCP server is authorized via OAuth.
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert>
                  <ShieldOff />
                  <AlertTitle>Not Authorized</AlertTitle>
                  <AlertDescription>
                    This MCP server requires OAuth authorization before it can
                    be used.
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={oauthAuthorized ? "outline" : "default"}
                  className="cursor-pointer"
                  onClick={handleOAuthAuthorize}
                  disabled={isAuthorizing || isSubmitting}
                >
                  <ExternalLink />
                  {isAuthorizing
                    ? "Redirecting..."
                    : oauthAuthorized
                      ? "Re-authorize"
                      : "Authorize"}
                </Button>

                {oauthAuthorized && (
                  <Button
                    type="button"
                    variant="outline"
                    className="cursor-pointer"
                    onClick={handleOAuthRevoke}
                    disabled={isRevoking || isSubmitting}
                  >
                    <ShieldOff />
                    {isRevoking ? "Revoking..." : "Revoke"}
                  </Button>
                )}
              </div>
            </div>
          )}
        </FieldGroup>

        {/* Test Connection Section */}
        <div className="space-y-3">
          <Button
            type="button"
            variant="outline"
            className="cursor-pointer"
            onClick={handleTestConnection}
            disabled={
              isTesting ||
              isSubmitting ||
              !formData.url ||
              (formData.authType === "OAuth" && (!mcpId || !oauthAuthorized))
            }
          >
            <Plug />
            {isTesting ? "Testing..." : "Test connection"}
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
            !canSubmitForm(validationErrors, RETRACTABLE_FIELDS)
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

      <ConfirmDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete MCP server"
        description="Are you sure you want to delete this MCP server? This action cannot be undone."
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={handleDelete}
        loading={isDeleting}
      />
    </div>
  );
};

export { McpForm };
