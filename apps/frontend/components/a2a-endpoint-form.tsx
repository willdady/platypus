"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  A2A_ENDPOINT_DESCRIPTION_MAX_LENGTH,
  A2A_ENDPOINT_NAME_MAX_LENGTH,
  A2A_TOKEN_NAME_MAX_LENGTH,
  DEFAULT_INBOUND_TRIGGER_TOKEN_EXPIRY_DAYS,
  INBOUND_TRIGGER_TOKEN_EXPIRY_DAYS,
  type A2aEndpoint,
  type A2aToken,
  type Agent,
} from "@platypus/schemas";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FormTextField } from "@/components/form-text-field";
import { FormTextareaField } from "@/components/form-textarea-field";
import { FormSelectField } from "@/components/form-select-field";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import { DetailFormState } from "@/components/detail-form-state";
import { EntityDeleteDialog } from "@/components/entity-delete-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { AgentAvatar } from "@/components/agent-avatar";
import { A2aEndpointNotices } from "@/components/a2a-endpoint-notices";
import { A2aTokenDialog } from "@/components/a2a-token-dialog";
import { CopyRow } from "@/components/copy-row";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { scopedUrl, writeAt } from "@/lib/api-write";
import { a2aCardUrl } from "@/lib/a2a-endpoint";
import { formatDate, formatDateTime } from "@/lib/format-date";
import {
  INBOUND_TOKEN_STATUS_LABELS,
  INBOUND_TOKEN_STATUS_VARIANTS,
} from "@/lib/inbound-trigger";
import { workspaceRoutes } from "@/lib/routes";

type Endpoint = A2aEndpoint & { tokens: A2aToken[] };

const INITIAL_DATA = {
  agentId: "",
  name: "",
  description: "",
  enabled: true,
};

/**
 * Creates or edits an A2A endpoint (ADR-0032), and on an existing one shows
 * its card URL and manages its tokens. Only the Workspace Owner edits; an Org
 * Admin sees it read-only.
 */
const A2aEndpointForm = ({
  orgId,
  workspaceId,
  endpointId,
}: {
  orgId: string;
  workspaceId: string;
  endpointId?: string;
}) => {
  const router = useRouter();
  const backendUrl = useBackendUrl();
  const { ownsWorkspace } = useAuth();
  const scope = { orgId, workspaceId };
  const routes = workspaceRoutes(orgId, workspaceId).settings;
  const isEditMode = !!endpointId;
  const readOnly = !ownsWorkspace;

  const { data: agentsData } = useScopedSWR<{ results: Agent[] }>(
    "agents",
    scope,
  );
  const agents = agentsData?.results ?? [];

  const {
    record: endpoint,
    mutateRecord,
    loadState,
    formData,
    setField,
    validationErrors,
    isSubmitting,
    canSubmit,
    toFieldChange,
    submit,
  } = useEntityForm<typeof INITIAL_DATA, A2aEndpoint, Endpoint>({
    initialData: INITIAL_DATA,
    entity: "a2a-endpoints",
    scope,
    id: endpointId,
    fromRecord: (record) => ({
      agentId: record.agentId,
      name: record.name,
      description: record.description,
      enabled: record.enabled,
    }),
    retractableFields: ["agentId", "name", "description", "enabled"],
    // On create, a blank name or description is left for the backend to copy
    // from the Agent; the Agent can't change once the endpoint exists.
    buildPayload: (data) =>
      isEditMode
        ? {
            name: data.name,
            description: data.description,
            enabled: data.enabled,
          }
        : {
            agentId: data.agentId,
            enabled: data.enabled,
            ...(data.name.trim() ? { name: data.name } : {}),
            ...(data.description.trim()
              ? { description: data.description }
              : {}),
          },
    successMessage: () =>
      isEditMode ? "A2A endpoint updated" : "A2A endpoint created",
    // A new endpoint lands on its own page, where its tokens are issued.
    onSuccess: (saved) =>
      router.push(
        isEditMode ? routes.a2aEndpoints : routes.a2aEndpointDetail(saved.id),
      ),
  });

  const {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    openDeleteDialog,
    handleDelete,
  } = useEntityDelete({
    entity: "a2a-endpoints",
    scope,
    id: endpointId,
    successMessage: "A2A endpoint deleted",
    onSuccess: () => router.push(routes.a2aEndpoints),
    onError: (message, _outcome, { close }) => {
      toast.error(message);
      close();
    },
  });

  const [tokenName, setTokenName] = useState("");
  const [expiryDays, setExpiryDays] = useState<number>(
    DEFAULT_INBOUND_TRIGGER_TOKEN_EXPIRY_DAYS,
  );
  const [isIssuing, setIsIssuing] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const [tokenToDelete, setTokenToDelete] = useState<A2aToken | null>(null);
  const [isDeletingToken, setIsDeletingToken] = useState(false);
  const [tokenToRegenerate, setTokenToRegenerate] = useState<A2aToken | null>(
    null,
  );
  const [isRegenerating, setIsRegenerating] = useState(false);

  const tokensUrl = backendUrl
    ? `${scopedUrl(backendUrl, "a2a-endpoints", scope)}/${endpointId}/tokens`
    : null;

  const issueToken = async () => {
    if (!tokensUrl) return;
    setIsIssuing(true);
    const outcome = await writeAt<A2aToken & { token: string }>(tokensUrl, {
      method: "POST",
      data: { name: tokenName.trim(), expiryDays },
    });
    if (outcome.outcome === "success") {
      setIssued(outcome.data.token);
      setTokenName("");
      await mutateRecord();
    } else {
      toast.error(outcome.message);
    }
    setIsIssuing(false);
  };

  const deleteToken = async () => {
    if (!tokensUrl || !tokenToDelete) return;
    setIsDeletingToken(true);
    const outcome = await writeAt(`${tokensUrl}/${tokenToDelete.id}`, {
      method: "DELETE",
    });
    if (outcome.outcome === "success") {
      toast.success("Token deleted");
      await mutateRecord();
    } else {
      toast.error(outcome.message);
    }
    setTokenToDelete(null);
    setIsDeletingToken(false);
  };

  const regenerateToken = async () => {
    if (!tokensUrl || !tokenToRegenerate) return;
    setIsRegenerating(true);
    const outcome = await writeAt<A2aToken & { token: string }>(
      `${tokensUrl}/${tokenToRegenerate.id}/regenerate`,
      { method: "POST" },
    );
    if (outcome.outcome === "success") {
      setIssued(outcome.data.token);
      await mutateRecord();
    } else {
      toast.error(outcome.message);
    }
    setTokenToRegenerate(null);
    setIsRegenerating(false);
  };

  const cardUrl =
    endpoint && backendUrl ? a2aCardUrl(backendUrl, endpoint.id) : null;

  const form = (
    <div>
      <A2aEndpointNotices orgId={orgId} workspaceId={workspaceId} />

      <FieldSet className="mb-6">
        <FieldGroup>
          <FormSelectField
            label="Agent"
            name="agentId"
            value={formData.agentId}
            onValueChange={(value) => setField("agentId", value)}
            disabled={isSubmitting || isEditMode || readOnly}
            placeholder="Select an agent"
            error={validationErrors.agentId}
            description={
              isEditMode
                ? "An endpoint stays with the agent it was made for."
                : "The agent outside callers talk to."
            }
          >
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                <AgentAvatar agent={agent} className="size-5" />
                {agent.name}
              </SelectItem>
            ))}
          </FormSelectField>

          <FormTextField
            label="Name"
            name="name"
            value={formData.name}
            onChange={toFieldChange("name")}
            disabled={isSubmitting || readOnly}
            error={validationErrors.name}
            maxLength={A2A_ENDPOINT_NAME_MAX_LENGTH}
            placeholder={isEditMode ? undefined : "The agent's name"}
            description="Shown to outside callers on the agent card."
          />

          <FormTextareaField
            label="Description"
            name="description"
            value={formData.description}
            onChange={toFieldChange("description")}
            disabled={isSubmitting || readOnly}
            error={validationErrors.description}
            maxLength={A2A_ENDPOINT_DESCRIPTION_MAX_LENGTH}
            placeholder={isEditMode ? undefined : "The agent's description"}
            description="Shown to outside callers on the agent card, in place of the agent's own description."
          />

          <Field>
            <div className="flex items-center gap-3">
              <Switch
                id="enabled"
                checked={formData.enabled}
                onCheckedChange={(checked) => setField("enabled", checked)}
                disabled={isSubmitting || readOnly}
              />
              <FieldLabel htmlFor="enabled" className="mb-0">
                Enabled
              </FieldLabel>
            </div>
            <FieldDescription>
              When disabled, the endpoint answers every call with Not Found.
            </FieldDescription>
          </Field>

          {cardUrl && (
            <CopyRow
              id="a2a-card-url"
              label="Agent card URL"
              value={cardUrl}
              copiedMessage="Agent card URL copied to clipboard"
            />
          )}

          {endpoint && (
            <Field>
              <FieldLabel>Tokens</FieldLabel>
              <FieldDescription>
                Give each client its own token, so you can delete one without
                breaking the others. You get a notification 30 and 7 days before
                a token expires.
              </FieldDescription>
              {endpoint.tokens.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tokens yet.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {endpoint.tokens.map((token) => (
                    <li
                      key={token.id}
                      className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium">
                            {token.name}
                          </p>
                          <Badge
                            variant={
                              INBOUND_TOKEN_STATUS_VARIANTS[token.tokenStatus]
                            }
                          >
                            {INBOUND_TOKEN_STATUS_LABELS[token.tokenStatus]}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Created {formatDate(token.createdAt)} · Expires{" "}
                          {formatDateTime(token.tokenExpiresAt)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Last used{" "}
                          {token.lastUsedAt
                            ? formatDateTime(token.lastUsedAt)
                            : "never"}{" "}
                          · Last rejected{" "}
                          {token.lastRejectedAt
                            ? formatDateTime(token.lastRejectedAt)
                            : "never"}
                        </p>
                      </div>
                      {!readOnly && (
                        <div className="flex shrink-0 gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            aria-label={`Regenerate token ${token.name}`}
                            className="cursor-pointer"
                            onClick={() => setTokenToRegenerate(token)}
                          >
                            <RefreshCw className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            aria-label={`Delete token ${token.name}`}
                            className="cursor-pointer"
                            onClick={() => setTokenToDelete(token)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {!readOnly && (
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Token name"
                    placeholder="Who the token is for, e.g. Hermes on Telegram"
                    value={tokenName}
                    maxLength={A2A_TOKEN_NAME_MAX_LENGTH}
                    onChange={(e) => setTokenName(e.target.value)}
                    disabled={isIssuing}
                  />
                  <Select
                    value={String(expiryDays)}
                    onValueChange={(value) => setExpiryDays(Number(value))}
                    disabled={isIssuing}
                  >
                    <SelectTrigger
                      aria-label="Token lifetime"
                      className="w-32 shrink-0"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {INBOUND_TRIGGER_TOKEN_EXPIRY_DAYS.map((days) => (
                        <SelectItem key={days} value={String(days)}>
                          {days} days
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0 cursor-pointer"
                    disabled={isIssuing || !tokenName.trim()}
                    onClick={() => void issueToken()}
                  >
                    <Plus className="h-4 w-4" /> Add token
                  </Button>
                </div>
              )}
            </Field>
          )}
        </FieldGroup>
      </FieldSet>

      {!readOnly && (
        <FormFooterButtons
          submitText={isEditMode ? "Update" : "Save"}
          onSubmit={() => void submit()}
          submitDisabled={isSubmitting || !canSubmit || !formData.agentId}
          deleteVisible={isEditMode}
          deleteDisabled={isSubmitting}
          onDelete={openDeleteDialog}
        />
      )}

      <EntityDeleteDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete A2A endpoint"
        description="Its URL and every one of its tokens stop working straight away."
        onConfirm={handleDelete}
        loading={isDeleting}
      />

      <ConfirmDialog
        open={tokenToDelete !== null}
        onOpenChange={(open) => !open && setTokenToDelete(null)}
        title="Delete token"
        description={`The client using "${tokenToDelete?.name}" stops getting in straight away.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={deleteToken}
        loading={isDeletingToken}
      />

      <ConfirmDialog
        open={tokenToRegenerate !== null}
        onOpenChange={(open) => !open && setTokenToRegenerate(null)}
        title="Regenerate token"
        description={`The current "${tokenToRegenerate?.name}" token stops working straight away. Update the client that uses it with the new one.`}
        confirmLabel="Regenerate"
        onConfirm={regenerateToken}
        loading={isRegenerating}
      />

      {issued && cardUrl && (
        <A2aTokenDialog
          token={issued}
          cardUrl={cardUrl}
          onClose={() => setIssued(null)}
        />
      )}
    </div>
  );

  return (
    <DetailFormState
      {...loadState}
      subject="A2A endpoint"
      backHref={routes.a2aEndpoints}
      backLabel="Back to A2A endpoints"
    >
      {form}
    </DetailFormState>
  );
};

export { A2aEndpointForm };
