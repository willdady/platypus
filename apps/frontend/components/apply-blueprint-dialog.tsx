"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import type { Workspace } from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";

// Apply a Blueprint to an existing Workspace (ADR-0008). The macro is additive
// and idempotent, so re-applying only attaches what is missing — we report the
// outcome rather than treating an all-skipped run as an error.
export const ApplyBlueprintDialog = ({
  orgId,
  blueprintId,
  blueprintName,
  open,
  onOpenChange,
}: {
  orgId: string;
  blueprintId: string;
  blueprintName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    attached: number;
    skipped: number;
    total: number;
  } | null>(null);

  const { data } = useSWR<{ results: Workspace[] }>(
    backendUrl && user && open
      ? joinUrl(backendUrl, `/organizations/${orgId}/workspaces`)
      : null,
    fetcher,
  );
  const workspaces = [...(data?.results || [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const reset = () => {
    setWorkspaceId("");
    setError(null);
    setResult(null);
    setApplying(false);
  };

  const handleApply = async () => {
    if (!workspaceId || !backendUrl) return;
    setApplying(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/blueprints/${blueprintId}/apply`,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId }),
          credentials: "include",
        },
      );
      if (response.ok) {
        setResult(await response.json());
      } else {
        const info = await response.json().catch(() => ({}));
        setError(info.error || "Failed to apply blueprint.");
      }
    } catch {
      setError("An unexpected error occurred.");
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!applying) {
          if (!next) reset();
          onOpenChange(next);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Apply “{blueprintName}”</DialogTitle>
          <DialogDescription>
            Attach this blueprint’s shared resources to a workspace. Re-applying
            is safe — only what isn’t already attached is added.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="py-2 px-4 bg-muted text-sm rounded">
            Attached {result.attached} of {result.total} resource
            {result.total !== 1 ? "s" : ""}
            {result.skipped > 0
              ? ` (${result.skipped} already attached).`
              : "."}
          </div>
        ) : (
          <Field>
            <FieldLabel htmlFor="apply-workspace">Workspace</FieldLabel>
            <Select value={workspaceId} onValueChange={setWorkspaceId}>
              <SelectTrigger id="apply-workspace" disabled={applying}>
                <SelectValue placeholder="Select a workspace" />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((ws) => (
                  <SelectItem key={ws.id} value={ws.id}>
                    {ws.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}

        {error && (
          <div className="py-2 px-4 bg-destructive/10 text-destructive text-sm rounded">
            {error}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              Done
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
                disabled={applying}
              >
                Cancel
              </Button>
              <Button onClick={handleApply} disabled={applying || !workspaceId}>
                Apply
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
