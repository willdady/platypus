"use client";

import { useEffect, useState } from "react";
import { useBackendUrl } from "@/app/client-context";
import { joinUrl } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

import {
  OAUTH_MCP_SUCCESS_EVENT,
  OAUTH_MCP_ERROR_EVENT,
} from "@/lib/constants";

/** Post a message to the opener window (if any) and close this popup. */
const notifyOpenerAndClose = (data: Record<string, unknown>): boolean => {
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage(data, window.location.origin);
    window.close();
    return true;
  }
  return false;
};

export const OAuthCallbackHandler = ({
  code,
  state,
}: {
  code?: string;
  state?: string;
}) => {
  const backendUrl = useBackendUrl();
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(true);

  useEffect(() => {
    if (!code || !state) {
      setError("Missing authorization code or state parameter.");
      setIsProcessing(false);
      return;
    }

    const exchangeCode = async () => {
      try {
        const response = await fetch(
          joinUrl(backendUrl, "/oauth/mcp/callback"),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code, state }),
            credentials: "include",
          },
        );

        if (response.ok) {
          const data = await response.json();

          // If opened as a popup, notify the opener and close
          if (
            notifyOpenerAndClose({
              type: OAUTH_MCP_SUCCESS_EVENT,
              mcpId: data.mcpId,
            })
          )
            return;

          // Fallback: if not a popup (e.g. popup was blocked and we fell
          // back to same-window redirect), navigate to the MCP edit page. An
          // org-scoped (Shared) MCP has no workspaceId, so it edits under the
          // organization settings surface.
          const mcpEditPath = data.workspaceId
            ? `/${data.orgId}/workspace/${data.workspaceId}/settings/mcp/${data.mcpId}`
            : `/${data.orgId}/settings/mcp/${data.mcpId}`;
          window.location.replace(mcpEditPath);
        } else {
          const data = await response.json().catch(() => ({}));
          const message =
            data.error || "Failed to complete OAuth authorization.";

          // Notify opener of failure if in a popup
          if (notifyOpenerAndClose({ type: OAUTH_MCP_ERROR_EVENT, message }))
            return;

          setError(message);
          setIsProcessing(false);
        }
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Network error during OAuth exchange.";

        if (notifyOpenerAndClose({ type: OAUTH_MCP_ERROR_EVENT, message }))
          return;

        setError(message);
        setIsProcessing(false);
      }
    };

    exchangeCode();
  }, [code, state, backendUrl]);

  if (isProcessing) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-muted-foreground">Completing authorization...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-12">
        <p className="text-destructive">{error}</p>
        <Button
          variant="outline"
          className="cursor-pointer"
          onClick={() => (window.location.href = "/")}
        >
          Back to Home
        </Button>
      </div>
    );
  }

  return null;
};
