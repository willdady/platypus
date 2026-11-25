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

function notifyOpenerAndClose(data: Record<string, unknown>): boolean {
  const opener = window.opener as Window | null;
  if (opener && !opener.closed) {
    opener.postMessage(data, window.location.origin);
    window.close();
    return true;
  }
  return false;
}

export function OAuthCallbackHandler({
  code,
  state,
  error: providerError,
  errorDescription,
}: {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}) {
  const backendUrl = useBackendUrl();
  const providerMessage = providerError
    ? `Authorization was refused: ${errorDescription || providerError}`
    : null;
  const initialError =
    providerMessage ??
    (!code || !state ? "Missing authorization code or state parameter." : null);
  const [error, setError] = useState<string | null>(initialError);
  const [isProcessing, setIsProcessing] = useState(!initialError);
  const router = useRouter();
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

        if (
          notifyOpenerAndClose({
            type: OAUTH_MCP_SUCCESS_EVENT,
            mcpId: data.mcpId,
          })
        )
          return;

        const mcpEditPath = data.workspaceId
          ? workspaceRoutes(data.orgId, data.workspaceId).settings.mcpDetail(
              data.mcpId,
            )
          : orgRoutes(data.orgId).settings.mcpDetail(data.mcpId);
        window.location.replace(withBasePath(mcpEditPath));
        return;
      }

      const message = outcome.message;

      if (notifyOpenerAndClose({ type: OAUTH_MCP_ERROR_EVENT, message }))
        return;

      setError(message);
      setIsProcessing(false);
    };

    void exchangeCode();
  }, [code, state, backendUrl, providerMessage]);

  if (isProcessing) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-12">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
        <p className="text-muted-foreground">Completing authorization...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-12">
        <p role="alert" className="text-destructive">
          {error}
        </p>
        <Button variant="outline" onClick={() => router.push(appRoutes.home)}>
          Back to Home
        </Button>
      </div>
    );
  }

  return null;
}
