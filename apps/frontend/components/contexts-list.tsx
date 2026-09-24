"use client";

import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import { cn } from "../lib/utils";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { Pencil, Plus, Folder } from "lucide-react";
import Link from "next/link";
import { Button } from "./ui/button";
import type { Context } from "@platypus/schemas";
import { userRoutes } from "@/lib/routes";
import { Skeleton } from "./ui/skeleton";
import { ListError } from "./list-state";

interface ContextWithNames extends Context {
  workspaceName?: string | null;
  organizationName?: string | null;
}

const ContextsList = ({ className }: { className?: string }) => {
  const { data, error, isLoading } = useScopedSWR<{
    results: ContextWithNames[];
  }>("users/me/contexts", {});

  if (isLoading) {
    // Mirrors the loaded rows (organization label over workspace title) and
    // the Add button below them.
    return (
      <div aria-label="Loading workspace contexts">
        <ul className={cn("mb-4", className)}>
          {[0, 1].map((i) => (
            <li key={i} className="mb-2">
              <Item variant="outline">
                <ItemContent>
                  <div>
                    <Skeleton className="h-3 w-24 mb-1.5" />
                    <Skeleton className="h-4 w-40 my-0.5" />
                  </div>
                </ItemContent>
                <ItemActions>
                  <Skeleton className="size-4" />
                </ItemActions>
              </Item>
            </li>
          ))}
        </ul>
        <Skeleton className="h-9 w-52" />
      </div>
    );
  }

  if (error) return <ListError error={error} subject="workspace contexts" />;

  const contexts = data?.results ?? [];
  const workspaceContexts = contexts.filter((c) => c.workspaceId);

  if (!workspaceContexts.length) {
    return (
      <div className="text-center py-12 border border-dashed rounded-lg">
        <Folder className="mx-auto h-12 w-12 text-muted-foreground mb-4 opacity-50" />
        <p className="text-muted-foreground mb-4">No workspace contexts.</p>
        <Button asChild>
          <Link href={userRoutes.createContext}>
            <Plus className="w-4 h-4" />
            Add workspace context
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <>
      <ul className={cn("mb-4", className)}>
        {workspaceContexts.map((context) => (
          <li key={context.id} className="mb-2">
            <Item variant="outline" asChild>
              <Link href={userRoutes.contextDetail(context.id)}>
                <ItemContent>
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">
                      {context.organizationName || "Unknown Organization"}
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
        ))}
      </ul>
      <Button asChild>
        <Link href={userRoutes.createContext}>
          <Plus className="w-4 h-4" />
          Add workspace context
        </Link>
      </Button>
    </>
  );
};

export { ContextsList };
