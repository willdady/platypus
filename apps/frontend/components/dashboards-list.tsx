"use client";

import { useState } from "react";
import {
  Item,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ItemContent,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DeleteDashboardDialog } from "@/components/delete-dashboard-dialog";
import { EllipsisVertical, Pencil, Trash2 } from "lucide-react";
import { type Dashboard } from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { writeEntity } from "@/lib/api-write";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";

export const DashboardsList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [dashboardToDelete, setDashboardToDelete] = useState<Dashboard | null>(
    null,
  );

  const {
    data: dashboardsData,
    isLoading,
    mutate,
  } = useSWR<{ results: Dashboard[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/dashboards`,
        )
      : null,
    fetcher,
  );

  const dashboards = [...(dashboardsData?.results || [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const handleDeleteClick = (dashboard: Dashboard) => {
    setDashboardToDelete(dashboard);
    setDeleteError(null);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!dashboardToDelete || !backendUrl) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const outcome = await writeEntity(
        backendUrl,
        "dashboards",
        { orgId, workspaceId },
        { id: dashboardToDelete.id },
      );
      if (outcome.outcome === "success") {
        mutate();
        setDeleteDialogOpen(false);
        setDashboardToDelete(null);
      } else {
        setDeleteError(outcome.message);
      }
    } finally {
      setDeleting(false);
    }
  };

  if (isLoading) return <div>Loading...</div>;
  if (!dashboards.length) return null;

  return (
    <>
      <ul className="grid grid-cols-1 lg:grid-cols-2 gap-2 lg:gap-4">
        {dashboards.map((dashboard) => (
          <li key={dashboard.id}>
            <Item variant="outline" className="h-full cursor-pointer" asChild>
              <Link
                href={`/${orgId}/workspace/${workspaceId}/dashboards/${dashboard.id}`}
              >
                <ItemContent>
                  <ItemTitle>{dashboard.name}</ItemTitle>
                  {dashboard.description && (
                    <ItemDescription className="text-xs line-clamp-2">
                      {dashboard.description}
                    </ItemDescription>
                  )}
                </ItemContent>
                <ItemActions>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        className="cursor-pointer text-muted-foreground"
                        variant="ghost"
                        size="icon"
                        onClick={(e) => e.preventDefault()}
                      >
                        <EllipsisVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem className="cursor-pointer" asChild>
                        <Link
                          href={`/${orgId}/workspace/${workspaceId}/dashboards/${dashboard.id}/settings`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Pencil /> Edit
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="cursor-pointer text-destructive focus:text-destructive"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleDeleteClick(dashboard);
                        }}
                      >
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ItemActions>
              </Link>
            </Item>
          </li>
        ))}
      </ul>

      <DeleteDashboardDialog
        dashboardName={dashboardToDelete?.name ?? ""}
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteConfirm}
        loading={deleting}
        error={deleteError}
      />
    </>
  );
};
