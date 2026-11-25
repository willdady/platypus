"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  A2A_TOKEN_NAME_MAX_LENGTH,
  BEARER_TOKEN_EXPIRY_DAYS,
  DEFAULT_BEARER_TOKEN_EXPIRY_DAYS,
  type A2aEndpoint,
  type A2aToken,
} from "@platypus/schemas";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldTitle,
} from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { A2aTokenDialog } from "@/components/a2a-token-dialog";
import { CopyRow } from "@/components/copy-row";
import { TokenTime } from "@/components/bearer-token";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { scopedUrl, writeAt, type Serialized } from "@/lib/api-write";
import { a2aCardUrl } from "@/lib/a2a-endpoint";
import { TOKEN_STATUS_LABELS, TOKEN_STATUS_VARIANTS } from "@/lib/bearer-token";
import { ListState } from "@/components/list-state";
import { useConfirmFlow, useDeleteFlow } from "@/hooks/use-delete-flow";
import { useEntityForm } from "@/hooks/use-entity-form";

export const ACCESS_SECTION_ID = "access";

type IssuedToken = Serialized<A2aToken> & { token: string };

export function A2aTokens({
  orgId,
  endpoint,
  mutate,
}: {
  orgId: string;
  endpoint: Serialized<A2aEndpoint> & { tokens: Serialized<A2aToken>[] };
  mutate: () => Promise<unknown>;
}) {
  const backendUrl = useBackendUrl();
  const { ownsWorkspace } = useAuth();
  const readOnly = !ownsWorkspace;

  const [issued, setIssued] = useState<string | null>(null);

  const accessRef = useRef<HTMLDivElement>(null);
  const tokenNameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (window.location.hash !== `#${ACCESS_SECTION_ID}`) return;
    history.replaceState(null, "", window.location.pathname);
    accessRef.current?.scrollIntoView({ block: "start" });
    tokenNameRef.current?.focus({ preventScroll: true });
  }, []);

  const tokensUrl = `${scopedUrl(backendUrl, "a2a-endpoints", {
    orgId,
    workspaceId: endpoint.workspaceId,
  })}/${endpoint.id}/tokens`;
  const cardUrl = backendUrl ? a2aCardUrl(backendUrl, endpoint.id) : null;

  const {
    formData: tokenForm,
    validationErrors,
    isSubmitting: isIssuing,
    setField,
    submit: issueToken,
  } = useEntityForm<{ name: string; expiryDays: number }, IssuedToken>({
    initialData: { name: "", expiryDays: DEFAULT_BEARER_TOKEN_EXPIRY_DAYS },
    guardUnsavedChanges: false,
    invalidMessage: null,
    write: (data) =>
      writeAt<IssuedToken>(tokensUrl, {
        method: "POST",
        data: { ...data, name: data.name.trim() },
      }),
    onSuccess: async (token) => {
      setIssued(token.token);
      setField("name", "");
      await mutate();
    },
  });

  const tokenDelete = useDeleteFlow<Serialized<A2aToken>>({
    delete: (token) =>
      writeAt(`${tokensUrl}/${token.id}`, { method: "DELETE" }),
    mutate,
    onSuccess: () => {
      toast.success("Token deleted");
    },
  });

  const regenerateToken = useConfirmFlow<Serialized<A2aToken>, IssuedToken>({
    delete: (token) =>
      writeAt<IssuedToken>(`${tokensUrl}/${token.id}/regenerate`, {
        method: "POST",
      }),
    mutate,
    onSuccess: (_token, data) => setIssued(data.token),
  });

  return (
    <div
      id={ACCESS_SECTION_ID}
      ref={accessRef}
      className="flex scroll-mt-4 flex-col gap-7"
    >
      {cardUrl && (
        <CopyRow
          id="a2a-card-url"
          label="Agent card URL"
          value={cardUrl}
          copiedMessage="Agent card URL copied to clipboard"
        />
      )}

      <Field aria-labelledby="a2a-tokens-label">
        <FieldTitle id="a2a-tokens-label">Tokens</FieldTitle>
        <FieldDescription>
          Give each client its own token, so you can delete one without breaking
          the others. You get a notification 30 and 7 days before a token
          expires.
        </FieldDescription>
        {endpoint.tokens.length === 0 ? (
          <ListState variant="empty">No tokens yet.</ListState>
        ) : (
          <ul className="flex flex-col gap-2">
            {endpoint.tokens.map((token) => (
              <li
                key={token.id}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{token.name}</p>
                    <Badge variant={TOKEN_STATUS_VARIANTS[token.tokenStatus]}>
                      {TOKEN_STATUS_LABELS[token.tokenStatus]}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Created: <TokenTime value={token.createdAt} /> · Expires:{" "}
                    <TokenTime value={token.tokenExpiresAt} />
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Last used: <TokenTime value={token.lastUsedAt} /> · Last
                    rejected: <TokenTime value={token.lastRejectedAt} />
                  </p>
                </div>
                {!readOnly && (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={`Regenerate token ${token.name}`}
                      onClick={() => regenerateToken.request(token)}
                    >
                      <RefreshCw />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={`Delete token ${token.name}`}
                      onClick={() => tokenDelete.request(token)}
                    >
                      <Trash2 />
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
              ref={tokenNameRef}
              aria-label="Token name"
              placeholder="Who the token is for"
              value={tokenForm.name}
              maxLength={A2A_TOKEN_NAME_MAX_LENGTH}
              onChange={(e) => setField("name", e.target.value)}
              disabled={isIssuing}
              aria-invalid={!!validationErrors.name}
            />
            <Select
              value={String(tokenForm.expiryDays)}
              onValueChange={(value) => setField("expiryDays", Number(value))}
              disabled={isIssuing}
            >
              <SelectTrigger
                aria-label="Token lifetime"
                className="w-32 shrink-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BEARER_TOKEN_EXPIRY_DAYS.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {days} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              disabled={isIssuing || !tokenForm.name.trim()}
              onClick={() => void issueToken()}
            >
              <Plus /> Add token
            </Button>
          </div>
        )}
        {(validationErrors.name || validationErrors.expiryDays) && (
          <FieldError>
            {validationErrors.name ?? validationErrors.expiryDays}
          </FieldError>
        )}
      </Field>

      <DeleteConfirmDialog
        noun="token"
        name={tokenDelete.target?.name}
        consequence="The client using it stops getting in straight away."
        {...tokenDelete.dialogProps}
      />

      <ConfirmDialog
        title="Regenerate token"
        description={`The current "${regenerateToken.target?.name}" token stops working straight away. Update the client that uses it with the new one.`}
        confirmLabel="Regenerate"
        {...regenerateToken.dialogProps}
      />

      {issued && (
        <A2aTokenDialog
          token={issued}
          cardUrl={cardUrl}
          onClose={() => setIssued(null)}
        />
      )}
    </div>
  );
}
