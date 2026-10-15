"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useBackendUrl } from "@/components/auth-provider";
import { joinUrl } from "@/lib/utils";
import { writeAt } from "@/lib/api-write";
import {
  appRoutes,
  orgRoutes,
  withBasePath,
  workspaceRoutes,
} from "@/lib/routes";
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
  error: providerError,
  errorDescription,
}: {
  code?: string;
  state?: string;
  /** The provider's `?error=`, sent instead of a code when it refuses. */
  error?: string;
  errorDescription?: string;
}) => {
  const backendUrl = useBackendUrl();
  // The URL params are fixed for the lifetime of this view, so an error they
  // already carry is derived at init rather than set in an effect. A provider
  // refusal names its own reason; it is not a missing code.
  const providerMessage = providerError
    ? `Authorization was refused: ${errorDescription || providerError}`
    : null;
  const initialError =
    providerMessage ??
    (!code || !state ? "Missing authorization code or state parameter." : null);
  const [error, setError] = useState<string | null>(initialError);
  const [isProcessing, setIsProcessing] = useState(!initialError);
  const router = useRouter();
  // The code is single-use: a second POST (StrictMode's double effect, or a
  // `backendUrl` change) fails, and its failure could overwrite the success.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    if (providerMessage) {
      notifyOpenerAndClose({
        type: OAUTH_MCP_ERROR_EVENT,
        message: providerMessage,
      });
      return;
    }
    if (!code || !state) {
      return;
    }

    const exchangeCode = async () => {
      const outcome = await writeAt<{
        mcpId: string;
        orgId: string;
        workspaceId?: string;
      }>(joinUrl(backendUrl, "/oauth/mcp/callback"), {
        method: "POST",
        data: { code, state },
      });

      if (outcome.outcome === "success") {
        const data = outcome.data;

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
          ? workspaceRoutes(data.orgId, data.workspaceId).settings.mcpDetail(
              data.mcpId,
            )
          : orgRoutes(data.orgId).settings.mcpDetail(data.mcpId);
        window.location.replace(withBasePath(mcpEditPath));
        return;
      }

      const message = outcome.message;

      // Notify opener of failure if in a popup
      if (notifyOpenerAndClose({ type: OAUTH_MCP_ERROR_EVENT, message }))
        return;

      setError(message);
      setIsProcessing(false);
    };

    exchangeCode();
  }, [code, state, backendUrl, providerMessage]);

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
          onClick={() => router.push(appRoutes.home)}
        >
          Back to Home
        </Button>
      </div>
    );
  }

  return null;
};
