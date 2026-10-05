"use client";

import { formatDateTime } from "@/lib/format-date";
import { CopyRow } from "@/components/copy-row";
import { TokenDialog } from "@/components/bearer-token";

/** The fire endpoint an external caller POSTs to (ADR-0030). */
export const inboundEndpointUrl = (backendUrl: string, triggerId: string) =>
  `${backendUrl.replace(/\/+$/, "")}/hooks/triggers/${triggerId}`;

/** A ready-to-run test call, each declared input filled with a placeholder. */
export const inboundCurlCommand = (
  endpointUrl: string,
  token: string,
  inputNames: string[],
) => {
  const inputs = Object.fromEntries(inputNames.map((n) => [n, `<${n}>`]));
  return [
    `curl -X POST '${endpointUrl}' \\`,
    `  -H 'Authorization: Bearer ${token}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${JSON.stringify({ inputs })}'`,
  ].join("\n");
};

/** Shows an Inbound Trigger's token once, with how to call it. */
export const InboundTokenDialog = ({
  token,
  endpointUrl,
  inputNames,
  expiresAt,
  onClose,
}: {
  token: string;
  endpointUrl: string;
  inputNames: string[];
  expiresAt?: string | Date | null;
  onClose: () => void;
}) => (
  <TokenDialog
    description={
      <>
        The system that calls this trigger sends this token as{" "}
        <code>Authorization: Bearer &lt;token&gt;</code>.
      </>
    }
    lostHint={
      <>
        This is the only time the token is shown. If you lose it, regenerate it
        on the trigger&apos;s page. That stops the old one working.
      </>
    }
    onClose={onClose}
  >
    <CopyRow
      id="inbound-token"
      label="Token"
      value={token}
      copiedMessage="Token copied to clipboard"
    />
    <CopyRow
      id="inbound-endpoint"
      label="Endpoint"
      value={endpointUrl}
      copiedMessage="Endpoint copied to clipboard"
    />
    <CopyRow
      id="inbound-curl"
      label="Test with curl"
      value={inboundCurlCommand(endpointUrl, token, inputNames)}
      copiedMessage="Command copied to clipboard"
      multiline
    />
    {expiresAt && (
      <p className="text-sm text-muted-foreground">
        Expires {formatDateTime(expiresAt)}.
      </p>
    )}
  </TokenDialog>
);
