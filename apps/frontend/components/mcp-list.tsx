"use client";

import { MCP, type Workspace } from "@platypus/schemas";
import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import useSWR from "swr";
import { cn, fetcher, joinUrl } from "../lib/utils";
import { useAuth } from "@/components/auth-provider";
import {
  Building,
  ExternalLink,
  Link2,
  Pencil,
  Plus,
  Unlink,
} from "lucide-react";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { NoMcpEmptyState } from "./no-mcp-empty-state";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { AttachSharedResourceDialog } from "./attach-shared-resource-dialog";
import { useState } from "react";

const McpList = ({
  className,
  orgId,
  workspaceId,
}: {
  className?: string;
  orgId: string;
  workspaceId?: string;
}) => {
  // Add scope to the MCP type for this component
  type McpWithScope = MCP & { scope?: "organization" | "workspace" };

  const { user, isOrgAdmin } = useAuth();
  const backendUrl = useBackendUrl();
  const [selectedOrgMcp, setSelectedOrgMcp] = useState<McpWithScope | null>(
    null,
  );
  const [attachOpen, setAttachOpen] = useState(false);
  const [detaching, setDetaching] = useState(false);

  const fetchUrl =
    backendUrl && user
      ? workspaceId
        ? joinUrl(
            backendUrl,
            `/organizations/${orgId}/workspaces/${workspaceId}/mcps`,
          )
        : joinUrl(backendUrl, `/organizations/${orgId}/mcps`)
      : null;

  const { data, error, isLoading, mutate } = useSWR<{
    results: McpWithScope[];
  }>(fetchUrl, fetcher);

  // Attaching/detaching org-scoped Shared resources is an Org Admin action,
  // available only inside a workspace (ADR-0007 / #154).
  const canAttach = Boolean(workspaceId) && isOrgAdmin;

  const detachOrgMcp = async (mcpId: string) => {
    if (!backendUrl || !workspaceId) return;
    setDetaching(true);
    try {
      await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/attachments/mcp/${mcpId}`,
        ),
        { method: "DELETE", credentials: "include" },
      );
      setSelectedOrgMcp(null);
      await mutate();
    } finally {
      setDetaching(false);
    }
  };

  // Workspace-scoped MCP config is admin-only unless the workspace delegates
  // it (ADR-0006). Org-level MCP management lives behind an admin-only route
  // (the org settings layout already requires admin), so it is always
  // manageable here.
  const { data: workspace } = useSWR<Workspace>(
    backendUrl && user && workspaceId
      ? joinUrl(backendUrl, `/organizations/${orgId}/workspaces/${workspaceId}`)
      : null,
    fetcher,
  );
  const canManage = workspaceId
    ? isOrgAdmin || workspace?.mcpSelfManagement === true
    : true;

  if (isLoading) {
    return null;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-destructive">
          Failed to load MCP servers. {error.info?.message || error.message}
        </p>
      </div>
    );
  }

  const mcps: McpWithScope[] = data?.results ?? [];
  const attachedOrgIds = mcps
    .filter((m) => m.scope === "organization")
    .map((m) => m.id);
  // When an admin can attach Shared resources, fall through to the main render
  // (which offers the Attach button) even if the workspace has no MCPs yet.
  if (!mcps.length && workspaceId && !canAttach) {
    return (
      <NoMcpEmptyState
        orgId={orgId}
        workspaceId={workspaceId}
        canManage={canManage}
      />
    );
  }

  return (
    <>
      <ul className={cn("mb-4", className)}>
        {mcps.map((mcp) => {
          // Org-scoped (Shared) MCPs are locked inside a workspace: they can
          // only be edited from the organization settings surface.
          const isOrgScopedInWorkspace =
            workspaceId && mcp.scope === "organization";

          return (
            <li key={mcp.id} className="mb-2">
              <Item
                variant="outline"
                asChild={!isOrgScopedInWorkspace}
                onClick={
                  isOrgScopedInWorkspace
                    ? () => setSelectedOrgMcp(mcp)
                    : undefined
                }
                className={cn(isOrgScopedInWorkspace && "cursor-pointer")}
              >
                {isOrgScopedInWorkspace ? (
                  <>
                    <ItemContent>
                      <div className="flex items-center gap-2">
                        <ItemTitle>{mcp.name}</ItemTitle>
                        <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-[10px] font-medium text-secondary-foreground uppercase tracking-wider">
                          <Building className="size-3" />
                          Organization
                        </div>
                      </div>
                    </ItemContent>
                    <ItemActions>
                      <Pencil className="size-4" />
                    </ItemActions>
                  </>
                ) : (
                  <Link
                    href={
                      workspaceId
                        ? `/${orgId}/workspace/${workspaceId}/settings/mcp/${mcp.id}`
                        : `/${orgId}/settings/mcp/${mcp.id}`
                    }
                  >
                    <ItemContent>
                      <div className="flex items-center gap-2">
                        <ItemTitle>{mcp.name}</ItemTitle>
                        {mcp.scope === "organization" && (
                          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-[10px] font-medium text-secondary-foreground uppercase tracking-wider">
                            <Building className="size-3" />
                            Organization
                          </div>
                        )}
                      </div>
                    </ItemContent>
                    <ItemActions>
                      <Pencil className="size-4" />
                    </ItemActions>
                  </Link>
                )}
              </Item>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-2">
        {canManage && (
          <Button asChild>
            <Link
              href={
                workspaceId
                  ? `/${orgId}/workspace/${workspaceId}/settings/mcp/create`
                  : `/${orgId}/settings/mcp/create`
              }
            >
              <Plus /> Add MCP
            </Link>
          </Button>
        )}
        {canAttach && (
          <Button variant="outline" onClick={() => setAttachOpen(true)}>
            <Link2 className="size-4" /> Attach shared MCP
          </Button>
        )}
      </div>
      {canAttach && workspaceId && (
        <AttachSharedResourceDialog
          open={attachOpen}
          onOpenChange={setAttachOpen}
          orgId={orgId}
          workspaceId={workspaceId}
          resourceType="mcp"
          attachedIds={attachedOrgIds}
          onAttached={() => {
            setAttachOpen(false);
            mutate();
          }}
        />
      )}
      <Dialog
        open={!!selectedOrgMcp}
        onOpenChange={(open) => !open && setSelectedOrgMcp(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Organization MCP</DialogTitle>
            <DialogDescription>
              The MCP server <strong>{selectedOrgMcp?.name}</strong> is managed
              at the organization level. It can only be edited from the
              organization settings.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedOrgMcp(null)}>
              Close
            </Button>
            {canAttach && selectedOrgMcp && (
              <Button
                variant="destructive"
                disabled={detaching}
                onClick={() => detachOrgMcp(selectedOrgMcp.id)}
              >
                <Unlink className="size-4" />
                Detach
              </Button>
            )}
            {isOrgAdmin && (
              <Button asChild>
                <Link href={`/${orgId}/settings/mcp/${selectedOrgMcp?.id}`}>
                  <ExternalLink className="size-4" />
                  Org settings
                </Link>
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export { McpList };
