"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { ResourcePage } from "@/components/resource-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useBackendUrl } from "@/app/client-context";
import { joinUrl } from "@/lib/utils";
import { writeEntity } from "@/lib/api-write";
import type { Dashboard } from "@platypus/schemas";

const CreateDashboardPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = use(params);
  const router = useRouter();
  const backendUrl = useBackendUrl();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!backendUrl || !name.trim()) return;
    setLoading(true);
    setError(null);
    const outcome = await writeEntity<Dashboard>(
      backendUrl,
      "dashboards",
      { orgId, workspaceId },
      {
        data: {
          name: name.trim(),
          description: description.trim() || null,
        },
      },
    );
    if (outcome.outcome === "conflict") {
      setError(outcome.message);
    } else if (outcome.outcome === "success") {
      const dashboard = outcome.data;
      const dashUrl = joinUrl(
        backendUrl,
        `/organizations/${orgId}/workspaces/${workspaceId}/dashboards/${dashboard.id}`,
      );
      await mutate(dashUrl, dashboard, false);
      router.push(
        `/${orgId}/workspace/${workspaceId}/dashboards/${dashboard.id}`,
      );
    } else {
      setError(outcome.message);
    }
    setLoading(false);
  };

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/workspace/${workspaceId}`}
      title="New Dashboard"
      variant="create"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Dashboard"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={loading || !name.trim()}>
          {loading ? "Creating..." : "Create dashboard"}
        </Button>
      </form>
    </ResourcePage>
  );
};

export default CreateDashboardPage;
