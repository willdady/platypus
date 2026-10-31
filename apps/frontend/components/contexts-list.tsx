"use client";

import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import { cn } from "../lib/utils";
import { useScopedList } from "@/hooks/use-scoped-list";
import { Pencil, Plus, Folder } from "lucide-react";
import Link from "next/link";
import { Button } from "./ui/button";
import type { Context } from "@platypus/schemas";
import { userRoutes } from "@/lib/routes";
import { Skeleton } from "./ui/skeleton";
import { ListError } from "./list-state";
import { EmptyCard } from "@/components/empty-card";

type ContextWithNames = {
  workspaceName?: string | null;
  organizationName?: string | null;
} & Context;

function ContextsList({ className }: { className?: string }) {
  const {
    results: contexts,
    error,
    isLoading,
    mutate,
  } = useScopedList<ContextWithNames>("users/me/contexts", {});

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

  if (error) {
    return (
      <ListError
        error={error}
        subject="workspace contexts"
        onRetry={() => void mutate()}
      />
    );
  }

  const workspaceContexts = contexts.filter((c) => c.workspaceId);

  if (!workspaceContexts.length) {
    return (
      <EmptyCard
        icon={<Folder />}
        title="No workspace contexts yet"
        description="Add a context to tell the AI about you within one workspace, on top of your global context."
        action={
          <Button asChild>
            <Link href={userRoutes.createContext}>
              <Plus /> Add workspace context
            </Link>
          </Button>
        }
      />
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
          <Plus />
          Add workspace context
        </Link>
      </Button>
    </>
  );
}

export { ContextsList };
