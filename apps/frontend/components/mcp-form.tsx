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
import { FormTextField } from "@/components/form-text-field";
import { FormSelectField } from "@/components/form-select-field";
import { RevealableInput } from "@/components/ui/revealable-input";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select";
import { EntityDeleteDialog } from "@/components/entity-delete-dialog";
import { DetailFormState } from "@/components/detail-form-state";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import {
  FieldSkeleton,
  FooterSkeleton,
  FormSkeletonGroup,
  FormSkeletonSet,
} from "@/components/form-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { useState, useEffect } from "react";
import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { useRouter } from "next/navigation";
import { type MCP } from "@platypus/schemas";
import { joinUrl } from "@/lib/utils";
import { scopedPath, writeAt } from "@/lib/api-write";
import { toastGuidanceOrError } from "@/lib/apply-write-outcome";
import { toast } from "sonner";
import { useBackendUrl } from "@/components/auth-provider";
import {
  Trash2,
  Plug,
  Check,
  X,
  ExternalLink,
  ShieldCheck,
  ShieldOff,
  Plus,
} from "lucide-react";
import {
  OAUTH_MCP_SUCCESS_EVENT,
  OAUTH_MCP_ERROR_EVENT,
} from "@/lib/constants";
import { orgRoutes, workspaceRoutes } from "@/lib/routes";

type HeaderRow = { key: string; value: string };

type McpRecord = MCP & {
  oauthAuthorized?: boolean;
  headers?: Record<string, string>;
};

type McpFormData = Omit<
  MCP,
  "id" | "createdAt" | "updatedAt" | "workspaceId" | "oauthAuthorized" | "slug"
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

const McpFormSkeleton = ({
  className,
  editing,
}: {
  className?: string;
  editing: boolean;
}) => (
  <div className={className}>
    <FormSkeletonSet>
      <FormSkeletonGroup>
        <FieldSkeleton />
        <FieldSkeleton description={1} />
        <div className="grid grid-cols-3 gap-4">
          <FieldSkeleton className="col-span-1" />
        </div>
        {/* Custom Headers: label, description, Add header */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
          <Skeleton className="h-8 w-28" />
        </div>
      </FormSkeletonGroup>
      <Skeleton className="h-9 w-40" />
    </FormSkeletonSet>
    <FooterSkeleton buttons={editing ? 2 : 1} />
  </div>
);

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
  const backendUrl = useBackendUrl();

  // An MCP is scoped to either a Workspace or the Organization (ADR-0007).
  // The scope determines the backend collection and the settings/edit paths.
  const scope = workspaceId ? { orgId, workspaceId } : { orgId };
  const collectionUrl = scopedPath("mcps", scope);
  const listPath = workspaceId
    ? workspaceRoutes(orgId, workspaceId).settings.mcp
    : orgRoutes(orgId).settings.mcp;
  const editPath = (id: string) =>
    workspaceId
      ? workspaceRoutes(orgId, workspaceId).settings.mcpDetail(id)
      : orgRoutes(orgId).settings.mcpDetail(id);

  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    toolNames?: string[];
    invalidToolNames?: string[];
    error?: string;
  } | null>(null);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);

  const router = useRouter();

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

  const {
    record: mcp,
    mutateRecord: mutateMcp,
    loadState,
    formData,
    setFormData,
    validationErrors,
    clearErrors,
    isSubmitting,
    canSubmit,
    handleChange: onFieldChange,
    toFieldChange: toFieldChangeBase,
    submit,
  } = useEntityForm<McpFormData, { id: string }, McpRecord>({
    initialData: {
      name: "",
      url: "",
      authType: "None",
      bearerToken: "",
      oauthClientId: "",
      oauthClientSecret: "",
      oauthRequestedScope: "",
      headerRows: [],
    },
    entity: "mcps",
    scope,
    id: mcpId,
    // OAuth status is read from `mcp` itself, not seeded: Authorize/Revoke
    // revalidate the record, and that must not wipe unsaved edits.
    fromRecord: (mcp) => ({
      name: mcp.name,
      url: mcp.url || "",
      authType: mcp.authType,
      bearerToken: mcp.bearerToken || "",
      oauthClientId: mcp.oauthClientId || "",
      oauthClientSecret: "",
      oauthRequestedScope: mcp.oauthRequestedScope || "",
      headerRows: Object.entries(mcp.headers ?? {}).map(([key, value]) => ({
        key,
        value,
      })),
    }),
    retractableFields: RETRACTABLE_FIELDS,
    buildPayload: (data) => ({
      // Scope discriminator — the backend routes also enforce this from the
      // URL, but sending it keeps the create payload self-describing.
      ...(workspaceId ? { workspaceId } : { organizationId: orgId }),
      name: data.name,
      url: data.url,
      headers: buildHeadersObject(),
      authType: data.authType,
      bearerToken: data.authType === "Bearer" ? data.bearerToken : undefined,
      oauthClientId: data.authType === "OAuth" ? data.oauthClientId : undefined,
      oauthClientSecret:
        data.authType === "OAuth" && data.oauthClientSecret
          ? data.oauthClientSecret
          : undefined,
      oauthRequestedScope:
        data.authType === "OAuth" && data.oauthRequestedScope?.trim()
          ? data.oauthRequestedScope.trim()
          : undefined,
    }),
    onError: toastGuidanceOrError,
    failureMessage: "Failed to save MCP server",
  });

  const {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    openDeleteDialog,
    handleDelete,
  } = useEntityDelete({
    entity: "mcps",
    scope,
    id: mcpId,
    onSuccess: () => router.push(listPath),
    onError: (message, outcome, { close }) => {
      toastGuidanceOrError(message, outcome);
      close();
    },
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFieldChange(e);
    // Clear test result when form changes
    setTestResult(null);
  };

  // Adapts FormTextField's `onChange(value)` to handleChange's `onChange(e)`
  // so the centralized clear-error-and-set-formData logic stays in one place.
  const toFieldChange = (id: string) => (value: string) => {
    toFieldChangeBase(id)(value);
    // Clear test result when form changes
    setTestResult(null);
  };

  const handleSelectChange = (id: string, value: string) => {
    // Clear the error for this field, including any reported against a path
    // inside it. Switching authType away from bearer also retracts a stale
    // bearerToken error: that field disappears from the form, so nothing
    // could otherwise clear it.
    if (id === "authType") clearErrors(id, "bearerToken");
    else clearErrors(id);

    setFormData((prevData) => ({
      ...prevData,
      [id]: value,
    }));

    // Clear test result when form changes
    setTestResult(null);
  };

  /**
   * Saves the MCP (create or update). Returns the saved record's ID on
   * success, or null on failure.
   */
  const saveMcp = async (): Promise<string | null> => {
    const saved = await submit({ silent: true });
    return saved?.id ?? null;
  };

  const handleSubmit = async () => {
    const savedId = await saveMcp();
    if (savedId) {
      router.push(listPath);
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
        // So the backend can report the tool-namespace-prefixed names this MCP
        // will actually contribute once saved (issue #467).
        name: formData.name,
      };

      // For OAuth, include mcpId so the backend can use stored tokens
      if (formData.authType === "OAuth" && mcpId) {
        payload.mcpId = mcpId;
      }

      const outcome = await writeAt<{
        success: boolean;
        toolNames?: string[];
        invalidToolNames?: string[];
        error?: string;
      }>(joinUrl(backendUrl, `${collectionUrl}/test`), {
        method: "POST",
        data: payload,
      });

      if (outcome.outcome === "success" && outcome.data.success) {
        setTestResult({
          success: true,
          toolNames: outcome.data.toolNames,
          invalidToolNames: outcome.data.invalidToolNames,
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
        const savedId = await saveMcp();
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

  const oauthAuthorized = mcp?.oauthAuthorized === true;

  const form = (
    <div className={classNames}>
      <FieldSet className="mb-6">
        <FieldGroup>
          <FormTextField
            label="Name"
            name="name"
            placeholder="My MCP Server"
            value={formData.name}
            onChange={toFieldChange("name")}
            disabled={isSubmitting}
            error={validationErrors.name}
            autoFocus
          />

          <FormTextField
            label="URL"
            name="url"
            type="url"
            placeholder="https://example.com/mcp"
            value={formData.url}
            onChange={toFieldChange("url")}
            disabled={isSubmitting}
            error={validationErrors.url}
            description="The URL endpoint for the MCP integration."
          />

          <FieldGroup className="grid grid-cols-3 gap-4">
            <FormSelectField
              className="col-span-1"
              label="Auth"
              name="authType"
              value={formData.authType}
              onValueChange={(value) => handleSelectChange("authType", value)}
              disabled={isSubmitting}
              placeholder="Select authentication type"
            >
              <SelectGroup>
                <SelectLabel>Authentication</SelectLabel>
                <SelectItem value="None">None</SelectItem>
                <SelectItem value="Bearer">Bearer</SelectItem>
                <SelectItem value="OAuth">OAuth</SelectItem>
              </SelectGroup>
            </FormSelectField>

            {formData.authType === "Bearer" && (
              <Field
                className="col-span-2"
                data-invalid={!!validationErrors.bearerToken}
              >
                <FieldLabel htmlFor="bearerToken">Bearer Token</FieldLabel>
                <RevealableInput
                  id="bearerToken"
                  placeholder="Bearer token"
                  value={formData.bearerToken}
                  onChange={handleChange}
                  disabled={isSubmitting}
                  aria-invalid={!!validationErrors.bearerToken}
                  revealLabel="bearer token"
                />
                {validationErrors.bearerToken && (
                  <FieldError>{validationErrors.bearerToken}</FieldError>
                )}
              </Field>
            )}
          </FieldGroup>

          {/* OAuth Client Credentials */}
          {formData.authType === "OAuth" && (
            <FieldGroup className="grid grid-cols-2 gap-4">
              <FormTextField
                label="Client ID"
                name="oauthClientId"
                placeholder="OAuth Client ID"
                value={formData.oauthClientId ?? ""}
                onChange={toFieldChange("oauthClientId")}
                disabled={isSubmitting}
                error={validationErrors.oauthClientId}
              />

              <Field data-invalid={!!validationErrors.oauthClientSecret}>
                <FieldLabel htmlFor="oauthClientSecret">
                  Client Secret
                </FieldLabel>
                <RevealableInput
                  id="oauthClientSecret"
                  placeholder={
                    mcpId && mcp?.oauthClientId
                      ? "Leave blank to keep current"
                      : "OAuth Client Secret"
                  }
                  value={formData.oauthClientSecret}
                  onChange={handleChange}
                  disabled={isSubmitting}
                  aria-invalid={!!validationErrors.oauthClientSecret}
                  revealLabel="client secret"
                />
                {validationErrors.oauthClientSecret && (
                  <FieldError>{validationErrors.oauthClientSecret}</FieldError>
                )}
              </Field>
              <FieldDescription className="col-span-2">
                Leave blank if the server supports dynamic client registration.
              </FieldDescription>

              <FormTextField
                className="col-span-2"
                label="OAuth Scopes"
                name="oauthRequestedScope"
                placeholder="e.g. https://www.googleapis.com/auth/calendar"
                value={formData.oauthRequestedScope || ""}
                onChange={toFieldChange("oauthRequestedScope")}
                disabled={isSubmitting}
                error={validationErrors.oauthRequestedScope}
                description="Space-separated list of OAuth scopes to request. Required by some providers (e.g. Google) that reject authorize requests without an explicit scope parameter."
              />
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
                    {testResult.invalidToolNames &&
                      testResult.invalidToolNames.length > 0 && (
                        <div className="mt-2">
                          <p className="text-xs font-medium mb-1 text-destructive">
                            These tools&apos; names are too long once namespaced
                            and will be unavailable. Rename this MCP shorter to
                            fix this:
                          </p>
                          <div className="flex flex-wrap gap-1">
                            {testResult.invalidToolNames.map((name) => (
                              <span
                                key={name}
                                className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono bg-destructive/10 text-destructive"
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

      <FormFooterButtons
        submitText={mcpId ? "Update" : "Save"}
        onSubmit={() => void handleSubmit()}
        submitDisabled={isSubmitting || isTesting || !canSubmit}
        deleteVisible={!!mcpId}
        deleteDisabled={isSubmitting || isTesting}
        onDelete={openDeleteDialog}
      />

      <EntityDeleteDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete MCP server"
        description="Are you sure you want to delete this MCP server? This action cannot be undone."
        onConfirm={handleDelete}
        loading={isDeleting}
      />
    </div>
  );

  return (
    <DetailFormState
      {...loadState}
      subject="MCP server"
      skeleton={<McpFormSkeleton className={classNames} editing={!!mcpId} />}
      backHref={listPath}
      backLabel="Back to MCP servers"
    >
      {form}
    </DetailFormState>
  );
};

export { McpForm };
