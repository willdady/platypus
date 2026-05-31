"use client";

import useSWR from "swr";
import { fetcher, joinUrl } from "../lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import { useState } from "react";

type ResourceType = "mcp" | "provider";

/**
 * Admin-only picker for attaching an org-scoped Shared resource to a Workspace
 * (ADR-0007 / #154). Lists the organization's resources that are not yet
 * attached here; attaching one makes it appear in the workspace as a locked card.
 */
const AttachSharedResourceDialog = ({
  open,
  onOpenChange,
  orgId,
  workspaceId,
  resourceType,
  attachedIds,
  onAttached,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  workspaceId: string;
  resourceType: ResourceType;
  attachedIds: string[];
  onAttached: () => void;
}) => {
  const backendUrl = useBackendUrl();
  const collection = resourceType === "mcp" ? "mcps" : "providers";
  const label = resourceType === "mcp" ? "MCP server" : "provider";

  const { data } = useSWR<{ results: { id: string; name: string }[] }>(
    open && backendUrl
      ? joinUrl(backendUrl, `/organizations/${orgId}/${collection}`)
      : null,
    fetcher,
  );

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const available = (data?.results ?? []).filter(
    (r) => !attachedIds.includes(r.id),
  );

  const attach = async (resourceId: string) => {
    if (!backendUrl) return;
    setBusyId(resourceId);
    setError(null);
    try {
      const res = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/attachments`,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resourceType, resourceId }),
          credentials: "include",
        },
      );
      if (!res.ok) {
        const info = await res.json().catch(() => ({}));
        setError(info.error || "Failed to attach resource.");
        return;
      }
      onAttached();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach a shared {label}</DialogTitle>
          <DialogDescription>
            Organization {label}s appear in this workspace only where attached.
            Choose one to make it available here.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {available.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            No shared {label}s available to attach.
          </p>
        ) : (
          <ul className="max-h-72 overflow-y-auto">
            {available.map((r) => (
              <li key={r.id} className="mb-2">
                <Item variant="outline">
                  <ItemContent>
                    <ItemTitle>{r.name}</ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      size="sm"
                      disabled={busyId === r.id}
                      onClick={() => attach(r.id)}
                    >
                      Attach
                    </Button>
                  </ItemActions>
                </Item>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export { AttachSharedResourceDialog };
