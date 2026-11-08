"use client";

import { useScopedList } from "@/hooks/use-scoped-list";
import { Plus } from "lucide-react";
import Link from "next/link";
import { Button } from "./ui/button";
import type { Context } from "@platypus/schemas";
import { userRoutes } from "@/lib/routes";
import { ListState } from "./list-state";
import { EntityCardList } from "@/components/entity-card-list";
import { RowActionsMenu } from "@/components/row-actions-menu";
import { ListFooter } from "@/components/list-pagination";
import { CardGridSkeleton } from "./list-skeletons";

type ContextWithNames = {
  workspaceName?: string | null;
  organizationName?: string | null;
} & Context;

function ContextsList() {
  const {
    data,
    results: contexts,
    error,
    isLoading,
    mutate,
  } = useScopedList<ContextWithNames>("users/me/contexts", {});

  const workspaceContexts = contexts.filter((c) => c.workspaceId);

  // A section's controls sit below it in every state, so the footer never
  // blinks out while the list loads or fails.
  const addContext = (
    <Button variant="outline" asChild>
      <Link href={userRoutes.createContext}>
        <Plus /> Add workspace context
      </Link>
    </Button>
  );

  return (
    <>
      <EntityCardList
        singleColumn
        items={workspaceContexts.map((context) => ({
          ...context,
          name: context.workspaceName || "Unknown Workspace",
          description: context.organizationName || "Unknown Organization",
        }))}
        isLoading={isLoading}
        error={error}
        data={data}
        subject="workspace contexts"
        onRetry={() => void mutate()}
        skeleton={<CardGridSkeleton singleColumn descriptionLines={1} />}
        empty={
          <ListState variant="empty">No workspace contexts yet.</ListState>
        }
        // The Organization name is the card's second line and nothing follows
        // it.
        descriptionLines={1}
        href={(context) => userRoutes.contextDetail(context.id)}
        menu={(context) => (
          <RowActionsMenu
            name={context.name}
            edit={{ href: userRoutes.contextDetail(context.id) }}
          />
        )}
      />

      <ListFooter className="mt-4">{addContext}</ListFooter>
    </>
  );
}

export { ContextsList };
