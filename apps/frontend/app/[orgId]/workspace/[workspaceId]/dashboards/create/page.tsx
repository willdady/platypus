"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { BackButton } from "@/components/back-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useBackendUrl } from "@/app/client-context";
import { joinUrl } from "@/lib/utils";

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
    try {
      const res = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/dashboards`,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim() || null,
          }),
        },
      );
      if (res.status === 409) {
        const body = await res.json();
        setError(body.error);
        return;
      }
      if (res.ok) {
        const dashboard = await res.json();
        const dashUrl = joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/dashboards/${dashboard.id}`,
        );
        await mutate(dashUrl, dashboard, false);
        router.push(
          `/${orgId}/workspace/${workspaceId}/dashboards/${dashboard.id}`,
        );
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex justify-center pb-8">
      <div className="w-full px-4 md:px-0 md:w-4/5 xl:w-2/5">
        <BackButton fallbackHref={`/${orgId}/workspace/${workspaceId}`} />
        <h1 className="text-2xl mb-4 font-bold">New Dashboard</h1>
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
      </div>
    </div>
  );
};

export default CreateDashboardPage;
