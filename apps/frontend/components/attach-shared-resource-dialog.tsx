"use client";

import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { joinUrl } from "../lib/utils";
import { writeAt } from "../lib/api-write";
import { useBackendUrl } from "@/components/auth-provider";
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
import { Skeleton } from "./ui/skeleton";
import { useState } from "react";

type ResourceType = "mcp" | "provider" | "skill" | "agent";

const COLLECTION: Record<ResourceType, string> = {
  mcp: "mcps",
  provider: "providers",
  skill: "skills",
  agent: "agents",
};

const LABEL: Record<ResourceType, string> = {
  mcp: "MCP server",
  provider: "provider",
  skill: "skill",
  agent: "agent",
};

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
  const collection = COLLECTION[resourceType];
  const label = LABEL[resourceType];

  const { data, isLoading } = useScopedSWR<{
    results: { id: string; name: string }[];
  }>(collection, open ? { orgId } : null);

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
      const outcome = await writeAt(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/attachments`,
        ),
        { method: "POST", data: { resourceType, resourceId } },
      );
      if (outcome.outcome !== "success") {
        setError(outcome.message);
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
        <DialogHeader className="text-left">
          <DialogTitle>Attach a shared {label}</DialogTitle>
          <DialogDescription>
            Organization {label}s appear in this workspace only where attached.
            Choose one to make it available here.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {isLoading ? (
          // Rows shaped like the loaded ones, in place of the false "none
          // available" while the list is still loading.
          <ul aria-label={`Loading shared ${label}s`}>
            {[0, 1, 2].map((i) => (
              <li key={i} className="mb-2">
                <Item variant="outline">
                  <ItemContent>
                    <Skeleton className="h-5 w-40" />
                  </ItemContent>
                  <ItemActions>
                    <Skeleton className="h-8 w-[70px]" />
                  </ItemActions>
                </Item>
              </li>
            ))}
          </ul>
        ) : available.length === 0 ? (
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
