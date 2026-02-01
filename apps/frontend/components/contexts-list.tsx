"use client";

import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import useSWR from "swr";
import { cn, fetcher, joinUrl } from "../lib/utils";
import { useAuth } from "@/components/auth-provider";
import { Pencil, Plus, Folder } from "lucide-react";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { Button } from "./ui/button";
import { useState, useEffect } from "react";
import type { Context, Organization, Workspace } from "@platypus/schemas";

interface ContextWithWorkspaceName extends Context {
  workspaceName?: string | null;
}

interface WorkspaceWithOrg extends Workspace {
  organizationName?: string;
}

const ContextsList = ({ className }: { className?: string }) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const { data, error, isLoading } = useSWR<{
    results: ContextWithWorkspaceName[];
  }>(user ? joinUrl(backendUrl, "/users/me/contexts") : null, fetcher);

  // Fetch organizations
  const { data: orgs } = useSWR<{ results: Organization[] }>(
    user ? joinUrl(backendUrl, "/organizations") : null,
    fetcher,
  );

  // Fetch workspaces for all orgs
  const [workspaces, setWorkspaces] = useState<WorkspaceWithOrg[]>([]);

  useEffect(() => {
    if (!orgs?.results || !backendUrl) return;

    const fetchWorkspaces = async () => {
      const allWorkspaces: WorkspaceWithOrg[] = [];

      for (const org of orgs.results) {
        try {
          const response = await fetch(
            joinUrl(backendUrl, `/organizations/${org.id}/workspaces`),
            { credentials: "include" },
          );
          if (response.ok) {
            const data = await response.json();
            const orgWorkspaces = data.results.map((w: Workspace) => ({
              ...w,
              organizationName: org.name,
            }));
            allWorkspaces.push(...orgWorkspaces);
          }
        } catch (error) {
          console.error(`Failed to fetch workspaces for org ${org.id}:`, error);
        }
      }

      setWorkspaces(allWorkspaces);
    };

    fetchWorkspaces();
  }, [orgs, backendUrl]);

  if (isLoading || error) return null;

  const contexts = data?.results ?? [];
  const workspaceContexts = contexts.filter((c) => c.workspaceId);

  if (!workspaceContexts.length) {
    return (
      <div className="text-center py-12 border border-dashed rounded-lg">
        <Folder className="mx-auto h-12 w-12 text-muted-foreground mb-4 opacity-50" />
        <p className="text-muted-foreground mb-4">No workspace contexts.</p>
        <Button asChild>
          <Link href="/settings/contexts/create">
            <Plus className="w-4 h-4" />
            Add Workspace Context
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <>
      <ul className={cn("mb-4", className)}>
        {workspaceContexts.map((context) => {
          // Find the workspace to get org name
          const workspace = workspaces.find(
            (w) => w.id === context.workspaceId,
          );

          return (
            <li key={context.id} className="mb-2">
              <Item variant="outline" asChild>
                <Link href={`/settings/contexts/${context.id}`}>
                  <ItemContent>
                    <div>
                      <p className="text-xs text-muted-foreground mb-0.5">
                        {workspace?.organizationName || "Unknown Organization"}
                      </p>
                      <ItemTitle>
                        {context.workspaceName || "Unknown Workspace"}
                      </ItemTitle>
                    </div>
                  </ItemContent>
                  <ItemActions>
                    <Pencil className="size-4" />
                  </ItemActions>
                </Link>
              </Item>
            </li>
          );
        })}
      </ul>
      <Button asChild>
        <Link href="/settings/contexts/create">
          <Plus className="w-4 h-4" />
          Add Workspace Context
        </Link>
      </Button>
    </>
  );
};

export { ContextsList };
