"use client";

import { CopyRow } from "@/components/copy-row";
import { TokenDialog } from "@/components/bearer-token";

/** Shows an A2A token once, beside the card URL the client needs with it. */
export const A2aTokenDialog = ({
  token,
  cardUrl,
  onClose,
}: {
  token: string;
  cardUrl: string;
  onClose: () => void;
}) => (
  <TokenDialog
    description={
      <>
        Paste the agent card URL and this token into the A2A client. It sends
        the token as <code>Authorization: Bearer &lt;token&gt;</code>.
      </>
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
    <CopyRow
      id="a2a-token-card-url"
      label="Agent card URL"
      value={cardUrl}
      copiedMessage="Agent card URL copied to clipboard"
    />
  </TokenDialog>
);
