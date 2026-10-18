"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { DetailFormState } from "@/components/detail-form-state";
import { FooterSkeleton } from "@/components/form-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2 } from "lucide-react";
import { ResourcePage } from "@/components/resource-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import type { Dashboard } from "@platypus/schemas";
import { workspaceRoutes } from "@/lib/routes";

function DashboardSettingsPage({
  params,
}: {
  params: Promise<{
    orgId: string;
    workspaceId: string;
    dashboardId: string;
  }>;
}) {
  const { orgId, workspaceId, dashboardId } = use(params);
  const routes = workspaceRoutes(orgId, workspaceId);
  const router = useRouter();

  const [saveError, setSaveError] = useState<string | null>(null);

  const {
    record: dashboard,
    loadState,
    formData,
    handleChange,
    isSubmitting: saving,
    submit,
  } = useEntityForm<{ name: string; description: string }, unknown, Dashboard>({
    initialData: { name: "", description: "" },
    entity: "dashboards",
    scope: { orgId, workspaceId },
    id: dashboardId,
    fromRecord: (dashboard) => ({
      name: dashboard.name,
      description: dashboard.description ?? "",
    }),
    buildPayload: (data) => ({
      name: data.name.trim(),
      description: data.description.trim() || null,
    }),
    successMessage: "Dashboard updated",
    onInvalid: (_fieldErrors, message) => setSaveError(message),
    onConflict: setSaveError,
    onError: setSaveError,
  });

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) return;
    setSaveError(null);
    await submit();
  };

  const {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    deleteError,
    openDeleteDialog,
    handleDelete,
  } = useEntityDelete({
    entity: "dashboards",
    scope: { orgId, workspaceId },
    id: dashboardId,
    onSuccess: () => router.push(routes.root),
  });

  return (
    <ResourcePage
      backFallbackHref={routes.dashboards.detail(dashboardId)}
      title="Dashboard Settings"
      variant="stacked"
    >
      <DetailFormState
        {...loadState}
        subject="dashboard"
        skeleton={
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-9 w-full" />
            </div>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-16 w-full" />
            </div>
            <FooterSkeleton buttons={2} />
          </div>
        }
        backHref={routes.root}
        backLabel="Back to workspace"
      >
        <form onSubmit={handleSave} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={handleChange}
              placeholder="My Dashboard"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={handleChange}
              placeholder="Optional description"
            />
          </div>
          {saveError && (
            <p role="alert" className="text-sm text-destructive">
              {saveError}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={saving || isDeleting || !formData.name.trim()}
            >
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={openDeleteDialog}
              disabled={saving || isDeleting}
            >
              <Trash2 /> Delete
            </Button>
          </div>
        </form>
      </DetailFormState>

      <DeleteConfirmDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete Dashboard"
        description={
          <>
            This action cannot be undone. This will permanently delete the
            dashboard <span className="font-semibold">{dashboard?.name}</span>{" "}
            and all of its widgets.
          </>
        }
        confirmPhrase="delete dashboard"
        onConfirm={handleDelete}
        loading={isDeleting}
        error={deleteError}
      />
    </ResourcePage>
  );
}

export default DashboardSettingsPage;
