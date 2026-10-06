"use client";

import { CopyRow } from "@/components/copy-row";
import { TokenDialog } from "@/components/bearer-token";

/**
 * Shows an A2A token once, beside the card URL the client needs with it. With
 * no backend URL configured there is no card URL to give yet, but the token
 * still shows: closing this is the last chance to copy it.
 */
export const A2aTokenDialog = ({
  token,
  cardUrl,
  onClose,
}: {
  token: string;
  cardUrl: string | null;
  onClose: () => void;
}) => (
  <TokenDialog
    description={
      cardUrl ? (
        <>
          Paste the agent card URL and this token into the A2A client. It sends
          the token as <code>Authorization: Bearer &lt;token&gt;</code>.
        </>
      ) : (
        <>
          Paste this token into the A2A client. It sends the token as{" "}
          <code>Authorization: Bearer &lt;token&gt;</code>. The agent card URL
          appears on this page once the backend URL is configured.
        </>
      )
    }
    lostHint="This is the only time the token is shown. If you lose it, regenerate it."
    onClose={onClose}
  >
    <CopyRow
      id="a2a-token"
      label="Token"
      value={token}
      copiedMessage="Token copied to clipboard"
    />
    {cardUrl && (
      <CopyRow
        id="a2a-token-card-url"
        label="Agent card URL"
        value={cardUrl}
        copiedMessage="Agent card URL copied to clipboard"
      />
    )}
  </TokenDialog>
);
