"use client";

import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import type { BearerTokenStatus } from "@platypus/schemas";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format-date";
import { TOKEN_STATUS_LABELS, TOKEN_STATUS_VARIANTS } from "@/lib/bearer-token";

/**
 * Shows a bearer token the one time it is readable — an Inbound Trigger's or
 * an A2A token's, on creation and on regenerate. Only its hash is stored, so
 * once this closes the token can't be shown again; a lost one is replaced by
 * regenerating it.
 */
export const TokenDialog = ({
  description,
  lostHint,
  children,
  onClose,
}: {
  description: ReactNode;
  /** The alert's body: what to do if the token is lost. */
  lostHint: ReactNode;
  /** The token and whatever the caller needs with it. */
  children: ReactNode;
  onClose: () => void;
}) => (
  <Dialog open onOpenChange={(next) => !next && onClose()}>
    <DialogContent
      // Closing is the one irreversible step, so neither a stray click
      // outside, Escape nor a corner X may do it: only the button does.
      onPointerDownOutside={(e) => e.preventDefault()}
      onEscapeKeyDown={(e) => e.preventDefault()}
      showCloseButton={false}
    >
      <DialogHeader>
        <DialogTitle>Copy the token now</DialogTitle>
        <DialogDescription>
          {description}
          {/* Escape and outside clicks are blocked, so tell someone who
              can't see the footer what does close it. */}
          <span className="sr-only">
            {" "}
            This dialog closes only with the &ldquo;I&apos;ve copied it&rdquo;
            button, so copy the token before you press it.
          </span>
        </DialogDescription>
      </DialogHeader>

      <Alert>
        <TriangleAlert />
        <AlertTitle>Shown only once</AlertTitle>
        <AlertDescription>{lostHint}</AlertDescription>
      </Alert>

      {children}

      <DialogFooter>
        <Button type="button" className="cursor-pointer" onClick={onClose}>
          I&apos;ve copied it
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

/**
 * One of a token's times — created, expires, last used or last rejected — in
 * the one format every token list shows, or "Never" for one that hasn't
 * happened yet.
 */
export const TokenTime = ({ value }: { value: Date | string | null }) =>
  value ? (
    <time dateTime={new Date(value).toISOString()}>
      {formatDateTime(value)}
    </time>
  ) : (
    <>Never</>
  );

/**
 * The Expires, Last used and Last rejected cells of an Org Admin's oversight
 * row for one token. Never the token.
 */
export const TokenCells = ({
  token,
}: {
  token: {
    tokenStatus: BearerTokenStatus;
    tokenExpiresAt: Date | string | null;
    lastUsedAt: Date | string | null;
    lastRejectedAt: Date | string | null;
  };
}) => (
  <>
    <TableCell>
      {/* A date like the other columns; only a token that needs attention
          gets a badge under it. */}
      {token.tokenExpiresAt ? (
        <div className="flex flex-col gap-1">
          <TokenTime value={token.tokenExpiresAt} />
          {(token.tokenStatus === "expiring" ||
            token.tokenStatus === "expired") && (
            <Badge
              variant={TOKEN_STATUS_VARIANTS[token.tokenStatus]}
              className="w-fit text-xs"
            >
              {TOKEN_STATUS_LABELS[token.tokenStatus]}
            </Badge>
          )}
        </div>
      ) : (
        TOKEN_STATUS_LABELS.none
      )}
    </TableCell>
    <TableCell>
      <TokenTime value={token.lastUsedAt} />
    </TableCell>
    <TableCell>
      <TokenTime value={token.lastRejectedAt} />
    </TableCell>
  </>
);
