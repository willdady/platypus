"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { useEntityForm } from "@/hooks/use-entity-form";
import { DetailFormState } from "@/components/detail-form-state";
import { Trash2 } from "lucide-react";
import { ResourcePage } from "@/components/resource-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useBackendUrl } from "@/components/auth-provider";
import { writeEntity } from "@/lib/api-write";
import type { Dashboard } from "@platypus/schemas";
import { toast } from "sonner";
import { workspaceRoutes } from "@/lib/routes";

const DashboardSettingsPage = ({
  params,
}: {
  params: Promise<{
    orgId: string;
    workspaceId: string;
    dashboardId: string;
  }>;
}) => {
  const { orgId, workspaceId, dashboardId } = use(params);
  const routes = workspaceRoutes(orgId, workspaceId);
  const backendUrl = useBackendUrl();
  const router = useRouter();

  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

  const handleDelete = async () => {
    if (!backendUrl) return;
    setDeleting(true);
    const outcome = await writeEntity(
      backendUrl,
      "dashboards",
      { orgId, workspaceId },
      { id: dashboardId },
    );
    if (outcome.outcome === "success") {
      router.push(routes.root);
    } else {
      toast.error(outcome.message);
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  return (
    <ResourcePage
      backFallbackHref={routes.dashboards.detail(dashboardId)}
      title="Dashboard Settings"
      variant="stacked"
    >
      <DetailFormState
        {...loadState}
        subject="dashboard"
        backHref={routes.root}
        backLabel="Back to workspace"
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={handleChange}
              placeholder="My Dashboard"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={handleChange}
              placeholder="Optional description"
            />
          </div>
          {saveError && <p className="text-sm text-destructive">{saveError}</p>}
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={saving || deleting || !formData.name.trim()}
            >
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteOpen(true)}
              disabled={saving || deleting}
            >
              <Trash2 /> Delete
            </Button>
          </div>
        </form>
      </DetailFormState>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete Dashboard"
        description={
          <>
            This action cannot be undone. This will permanently delete the
            dashboard <span className="font-semibold">{dashboard?.name}</span>{" "}
            and all of its widgets.
          </>
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        confirmPhrase="delete dashboard"
        loadingLabel="Deleting..."
        onConfirm={handleDelete}
        loading={deleting}
      />
    </ResourcePage>
  );
};

export default DashboardSettingsPage;
