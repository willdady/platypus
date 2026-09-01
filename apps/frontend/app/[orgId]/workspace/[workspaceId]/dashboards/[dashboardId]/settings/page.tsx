"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Trash2 } from "lucide-react";
import { ResourcePage } from "@/components/resource-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { fetcher, joinUrl } from "@/lib/utils";
import { writeEntity } from "@/lib/api-write";
import type { Dashboard } from "@platypus/schemas";
import { toast } from "sonner";

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
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const router = useRouter();

  const dashUrl =
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/dashboards/${dashboardId}`,
        )
      : null;

  const { data: dashboard, mutate } = useSWR<Dashboard>(dashUrl, fetcher);

  const [name, setName] = useState("");
  const [description, setDescription] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Initialise fields once the dashboard loads (null = not yet touched by user)
  const displayName = name !== "" ? name : (dashboard?.name ?? "");
  const displayDescription =
    description !== null ? description : (dashboard?.description ?? "");

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!backendUrl || !displayName.trim()) return;
    setSaving(true);
    setSaveError(null);
    const outcome = await writeEntity(
      backendUrl,
      "dashboards",
      { orgId, workspaceId },
      {
        id: dashboardId,
        data: {
          name: displayName.trim(),
          description: displayDescription.trim() || null,
        },
      },
    );
    if (outcome.outcome === "conflict") {
      setSaveError(outcome.message);
    } else if (outcome.outcome === "success") {
      await mutate();
      setName("");
      setDescription(null);
      toast.success("Dashboard updated");
    } else {
      setSaveError(outcome.message);
    }
    setSaving(false);
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
      router.push(`/${orgId}/workspace/${workspaceId}`);
    } else {
      toast.error(outcome.message);
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  if (!dashboard) {
    return null;
  }

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/workspace/${workspaceId}/dashboards/${dashboardId}`}
      title="Dashboard Settings"
      variant="settings"
    >
      <form onSubmit={handleSave} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={displayName}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Dashboard"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            value={displayDescription}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description"
          />
        </div>
        {saveError && <p className="text-sm text-destructive">{saveError}</p>}
        <div className="flex gap-2">
          <Button
            type="submit"
            disabled={saving || deleting || !displayName.trim()}
          >
            Update
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

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete Dashboard"
        description={
          <>
            This action cannot be undone. This will permanently delete the
            dashboard <span className="font-semibold">{dashboard.name}</span>{" "}
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
