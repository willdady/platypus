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

export function TokenDialog({
  description,
  lostHint,
  children,
  onClose,
}: {
  description: ReactNode;
  lostHint: ReactNode;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        // why: closing is the one irreversible step, so only the button may do it
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>Copy the token now</DialogTitle>
          <DialogDescription>
            {description}
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
          <Button type="button" onClick={onClose}>
            I&apos;ve copied it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TokenTime({ value }: { value: string | null }) {
  return value ? (
    <time dateTime={new Date(value).toISOString()}>
      {formatDateTime(value)}
    </time>
  ) : (
    <>Never</>
  );
}

export function TokenCells({
  token,
}: {
  token: {
    tokenStatus: BearerTokenStatus;
    tokenExpiresAt: string | null;
    lastUsedAt: string | null;
    lastRejectedAt: string | null;
  };
}) {
  return (
    <>
      <TableCell>
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
}
