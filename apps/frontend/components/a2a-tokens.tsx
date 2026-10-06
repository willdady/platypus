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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
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
import { A2aTokenDialog } from "@/components/a2a-token-dialog";
import { CopyRow } from "@/components/copy-row";
import { TokenTime } from "@/components/bearer-token";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { scopedUrl, writeAt } from "@/lib/api-write";
import { a2aCardUrl } from "@/lib/a2a-endpoint";
import { TOKEN_STATUS_LABELS, TOKEN_STATUS_VARIANTS } from "@/lib/bearer-token";

/** The anchor a new endpoint's page opens at, so its first token is next. */
export const ACCESS_SECTION_ID = "access";

type IssuedToken = A2aToken & { token: string };

/**
 * An existing endpoint's card URL and tokens (ADR-0032): the list, and for
 * the Workspace Owner issuing, regenerating and deleting them. A new token's
 * value is shown once, in a dialog, and never again.
 */
export const A2aTokens = ({
  orgId,
  endpoint,
  mutate,
}: {
  orgId: string;
  endpoint: A2aEndpoint & { tokens: A2aToken[] };
  /** Rereads the endpoint, so the list shows a token issued or removed. */
  mutate: () => Promise<unknown>;
}) => {
  const backendUrl = useBackendUrl();
  const { ownsWorkspace } = useAuth();
  const readOnly = !ownsWorkspace;

  const [tokenName, setTokenName] = useState("");
  const [expiryDays, setExpiryDays] = useState<number>(
    DEFAULT_BEARER_TOKEN_EXPIRY_DAYS,
  );
  const [isIssuing, setIsIssuing] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const [tokenToDelete, setTokenToDelete] = useState<A2aToken | null>(null);
  const [isDeletingToken, setIsDeletingToken] = useState(false);
  const [tokenToRegenerate, setTokenToRegenerate] = useState<A2aToken | null>(
    null,
  );
  const [isRegenerating, setIsRegenerating] = useState(false);

  // The browser's own jump to #access fires before the endpoint loads, so
  // land on the card URL and token controls once they render.
  const accessRef = useRef<HTMLDivElement>(null);
  const tokenNameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (window.location.hash !== `#${ACCESS_SECTION_ID}`) return;
    // Drop the hash so a reload or Back doesn't land here again.
    history.replaceState(null, "", window.location.pathname);
    accessRef.current?.scrollIntoView({ block: "start" });
    tokenNameRef.current?.focus({ preventScroll: true });
  }, []);

  const tokensUrl = `${scopedUrl(backendUrl, "a2a-endpoints", {
    orgId,
    workspaceId: endpoint.workspaceId,
  })}/${endpoint.id}/tokens`;
  const cardUrl = backendUrl ? a2aCardUrl(backendUrl, endpoint.id) : null;

  const issueToken = async () => {
    setIsIssuing(true);
    const outcome = await writeAt<IssuedToken>(tokensUrl, {
      method: "POST",
      data: { name: tokenName.trim(), expiryDays },
    });
    if (outcome.outcome === "success") {
      setIssued(outcome.data.token);
      setTokenName("");
      await mutate();
    } else {
      toast.error(outcome.message);
    }
    setIsIssuing(false);
  };

  const deleteToken = async () => {
    if (!tokenToDelete) return;
    setIsDeletingToken(true);
    const outcome = await writeAt(`${tokensUrl}/${tokenToDelete.id}`, {
      method: "DELETE",
    });
    if (outcome.outcome === "success") {
      toast.success("Token deleted");
      await mutate();
    } else {
      toast.error(outcome.message);
    }
    setTokenToDelete(null);
    setIsDeletingToken(false);
  };

  const regenerateToken = async () => {
    if (!tokenToRegenerate) return;
    setIsRegenerating(true);
    const outcome = await writeAt<IssuedToken>(
      `${tokensUrl}/${tokenToRegenerate.id}/regenerate`,
      { method: "POST" },
    );
    if (outcome.outcome === "success") {
      setIssued(outcome.data.token);
      await mutate();
    } else {
      toast.error(outcome.message);
    }
    setTokenToRegenerate(null);
    setIsRegenerating(false);
  };

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

      <Field>
        <FieldLabel>Tokens</FieldLabel>
        <FieldDescription>
          Give each client its own token, so you can delete one without breaking
          the others. You get a notification 30 and 7 days before a token
          expires.
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
              ref={tokenNameRef}
              aria-label="Token name"
              placeholder="Who the token is for"
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
              className="shrink-0 cursor-pointer"
              disabled={isIssuing || !tokenName.trim()}
              onClick={() => void issueToken()}
            >
              <Plus className="h-4 w-4" /> Add token
            </Button>
          </div>
        )}
      </Field>

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

      {/* Whenever a token was issued, card URL or not: this is the only time
          its value can be shown. */}
      {issued && (
        <A2aTokenDialog
          token={issued}
          cardUrl={cardUrl}
          onClose={() => setIssued(null)}
        />
      )}
    </div>
  );
};
