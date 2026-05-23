"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Box, Plus, Trash2, X } from "lucide-react";
import { type Sandbox } from "@platypus/schemas";

import { useAuth } from "@/components/auth-provider";
import { useBackendUrl } from "@/app/client-context";
import { fetcher, joinUrl, parseValidationErrors } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ConfirmDialog } from "@/components/confirm-dialog";

type SandboxBackend = { backend: string; name: string };

// Env rows are kept as an ordered array (not a Record) so a user can edit
// keys, add empties, and tolerate duplicate-during-edit without the UI
// reshuffling on every keystroke. Converted to Record<string,string> on save.
type EnvRow = { key: string; value: string };

type SandboxFormData = {
  name: string;
  backend: string;
  env: EnvRow[];
};

const DEFAULT_FORM: SandboxFormData = {
  name: "",
  backend: "",
  env: [],
};

const envRecordToRows = (env: Record<string, string> | undefined): EnvRow[] =>
  Object.entries(env ?? {}).map(([key, value]) => ({ key, value }));

const envRowsToRecord = (rows: EnvRow[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const { key, value } of rows) {
    const trimmedKey = key.trim();
    if (trimmedKey === "") continue;
    out[trimmedKey] = value;
  }
  return out;
};

const findDuplicateEnvKey = (rows: EnvRow[]): string | null => {
  const seen = new Set<string>();
  for (const { key } of rows) {
    const trimmed = key.trim();
    if (trimmed === "") continue;
    if (seen.has(trimmed)) return trimmed;
    seen.add(trimmed);
  }
  return null;
};

/**
 * Returns true when the backend's error message indicates the caller should
 * retry the request with `?force=true`. The backend signals this by including
 * the literal string "force=true" in the error message (see backend route).
 */
const isForceRetryError = (errorMessage: unknown): boolean =>
  typeof errorMessage === "string" && errorMessage.includes("force=true");

const SandboxSettings = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const sandboxUrl = joinUrl(
    backendUrl,
    `/organizations/${orgId}/workspaces/${workspaceId}/sandbox`,
  );

  /**
   * Custom fetcher — treats 404 as "no sandbox configured" by returning null
   * instead of throwing. Any other non-OK response throws.
   */
  const sandboxFetcher = async (url: string): Promise<Sandbox | null> => {
    const res = await fetch(url, { credentials: "include" });
    if (res.status === 404) return null;
    if (!res.ok) {
      const error = new Error("Failed to load sandbox");
      const info = await res.json().catch(() => ({}));
      (error as any).info = info;
      (error as any).status = res.status;
      throw error;
    }
    return res.json();
  };

  const { data, error, isLoading, mutate } = useSWR<Sandbox | null>(
    backendUrl && user ? sandboxUrl : null,
    sandboxFetcher,
  );

  const { data: backendsData, isLoading: backendsLoading } = useSWR<{
    results: SandboxBackend[];
  }>(backendUrl && user ? `${sandboxUrl}/backends` : null, fetcher);
  const backends = backendsData?.results ?? [];

  const [isConfiguring, setIsConfiguring] = useState(false);
  const [formData, setFormData] = useState<SandboxFormData>(DEFAULT_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Force-retry dialog state. Used both for failed teardown during backend
  // change (PUT) and for failed destroy on DELETE.
  const [forceDialog, setForceDialog] = useState<{
    open: boolean;
    kind: "save" | "delete" | null;
    message: string;
  }>({ open: false, kind: null, message: "" });
  const [isForcing, setIsForcing] = useState(false);

  // Sync form state with loaded sandbox data, or fall back to the first
  // available backend when creating fresh.
  useEffect(() => {
    if (data) {
      setFormData({
        name: data.name,
        backend: data.backend,
        env: envRecordToRows(data.env),
      });
    } else if (backends.length > 0) {
      setFormData((prev) =>
        prev.backend ? prev : { ...prev, backend: backends[0].backend },
      );
    }
  }, [data, backends]);

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (validationErrors.name) {
      setValidationErrors((prev) => {
        const next = { ...prev };
        delete next.name;
        return next;
      });
    }
    setFormData((prev) => ({ ...prev, name: e.target.value }));
  };

  const handleBackendChange = (value: string) => {
    if (validationErrors.backend) {
      setValidationErrors((prev) => {
        const next = { ...prev };
        delete next.backend;
        return next;
      });
    }
    setFormData((prev) => ({ ...prev, backend: value }));
  };

  /**
   * Performs the save (POST for create, PUT for update). Returns
   * `{ ok: true }` on success, `{ ok: false, forceRetry: true }` when the
   * backend reports a teardown failure that can be retried with force, and
   * `{ ok: false }` for validation / other errors (validationErrors set).
   */
  const performSave = async (
    options: { force?: boolean } = {},
  ): Promise<{ ok: boolean; forceRetry?: boolean; errorMessage?: string }> => {
    setValidationErrors({});
    const isCreate = !data;
    const method = isCreate ? "POST" : "PUT";
    const url =
      isCreate || !options.force ? sandboxUrl : `${sandboxUrl}?force=true`;

    const payload = {
      ...(isCreate ? { workspaceId } : {}),
      name: formData.name,
      backend: formData.backend,
      config: {},
      credentials: {},
      env: envRowsToRecord(formData.env),
    };

    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "include",
    });

    if (response.ok) return { ok: true };

    const errorData = await response.json().catch(() => ({}));

    // Backend teardown failures surface as 500 with { error: "...force=true..." }
    if (
      response.status === 500 &&
      isForceRetryError((errorData as any)?.error)
    ) {
      return {
        ok: false,
        forceRetry: true,
        errorMessage: (errorData as any).error,
      };
    }

    const fieldErrors = parseValidationErrors(errorData);
    if (Object.keys(fieldErrors).length > 0) {
      setValidationErrors(fieldErrors);
    } else {
      toast.error((errorData as any)?.error || "Failed to save sandbox");
    }
    return { ok: false };
  };

  const handleSave = async () => {
    const dup = findDuplicateEnvKey(formData.env);
    if (dup) {
      setValidationErrors({ env: `Duplicate env key: ${dup}` });
      return;
    }
    setIsSubmitting(true);
    try {
      const result = await performSave();
      if (result.ok) {
        await mutate();
        toast.success("Sandbox configured");
        setIsConfiguring(false);
      } else if (result.forceRetry) {
        setForceDialog({
          open: true,
          kind: "save",
          message:
            "Failed to tear down previous sandbox — switch anyway? External resources may leak.",
        });
      }
    } catch (err) {
      console.error("Error saving sandbox:", err);
      toast.error("Failed to save sandbox");
    } finally {
      setIsSubmitting(false);
    }
  };

  const performDelete = async (
    options: { force?: boolean } = {},
  ): Promise<{ ok: boolean; forceRetry?: boolean }> => {
    const url = options.force ? `${sandboxUrl}?force=true` : sandboxUrl;
    const response = await fetch(url, {
      method: "DELETE",
      credentials: "include",
    });

    if (response.ok) return { ok: true };

    const errorData = await response.json().catch(() => ({}));
    if (
      response.status === 500 &&
      isForceRetryError((errorData as any)?.error)
    ) {
      return { ok: false, forceRetry: true };
    }
    toast.error((errorData as any)?.error || "Failed to delete sandbox");
    return { ok: false };
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      const result = await performDelete();
      if (result.ok) {
        await mutate(null, { revalidate: false });
        toast.success("Sandbox deleted");
        setIsDeleteDialogOpen(false);
        setIsConfiguring(false);
        setFormData(DEFAULT_FORM);
        // Revalidate in the background to ensure SWR cache is fresh
        mutate();
      } else if (result.forceRetry) {
        setIsDeleteDialogOpen(false);
        setForceDialog({
          open: true,
          kind: "delete",
          message: "Failed to destroy sandbox — delete anyway?",
        });
      } else {
        setIsDeleteDialogOpen(false);
      }
    } catch (err) {
      console.error("Error deleting sandbox:", err);
      toast.error("Failed to delete sandbox");
      setIsDeleteDialogOpen(false);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleForceConfirm = async () => {
    setIsForcing(true);
    try {
      if (forceDialog.kind === "save") {
        const result = await performSave({ force: true });
        if (result.ok) {
          await mutate();
          toast.success("Sandbox configured");
          setIsConfiguring(false);
          setForceDialog({ open: false, kind: null, message: "" });
        } else {
          toast.error("Failed to switch sandbox backend");
          setForceDialog({ open: false, kind: null, message: "" });
        }
      } else if (forceDialog.kind === "delete") {
        const result = await performDelete({ force: true });
        if (result.ok) {
          await mutate(null, { revalidate: false });
          toast.success("Sandbox deleted");
          setIsConfiguring(false);
          setFormData(DEFAULT_FORM);
          mutate();
        } else {
          toast.error("Failed to delete sandbox");
        }
        setForceDialog({ open: false, kind: null, message: "" });
      }
    } catch (err) {
      console.error("Force retry error:", err);
      toast.error("Operation failed");
      setForceDialog({ open: false, kind: null, message: "" });
    } finally {
      setIsForcing(false);
    }
  };

  if (isLoading || backendsLoading) {
    return null;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-destructive">
          Failed to load sandbox. {error.info?.message || error.message}
        </p>
      </div>
    );
  }

  const hasSandbox = !!data;
  const showForm = hasSandbox || isConfiguring;
  const noBackends = backends.length === 0;

  if (!showForm) {
    return (
      <Empty className="border-2 border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Box className="size-6" />
          </EmptyMedia>
          <EmptyTitle>No sandbox configured</EmptyTitle>
          <EmptyDescription>
            {noBackends
              ? "No sandbox backends are registered on this server. Set PLATYPUS_SANDBOX_DOCKER_ENABLED=true (or register another backend) and restart the backend."
              : "Configure a sandbox to run agent code in an isolated environment."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => setIsConfiguring(true)} disabled={noBackends}>
            <Plus /> Configure sandbox
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <div>
      <FieldSet className="mb-6">
        <FieldGroup>
          <Field data-invalid={!!validationErrors.name}>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              placeholder="My sandbox"
              value={formData.name}
              onChange={handleNameChange}
              disabled={isSubmitting}
              aria-invalid={!!validationErrors.name}
              autoFocus
            />
            {validationErrors.name && (
              <FieldError>{validationErrors.name}</FieldError>
            )}
          </Field>

          <Field data-invalid={!!validationErrors.backend}>
            <FieldLabel htmlFor="backend">Backend</FieldLabel>
            <Select
              value={formData.backend}
              onValueChange={handleBackendChange}
              disabled={isSubmitting}
            >
              <SelectTrigger id="backend" disabled={isSubmitting}>
                <SelectValue placeholder="Select a backend" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Backend</SelectLabel>
                  {backends.map((option) => (
                    <SelectItem key={option.backend} value={option.backend}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              The runtime that hosts the sandbox environment.
            </FieldDescription>
            {validationErrors.backend && (
              <FieldError>{validationErrors.backend}</FieldError>
            )}
          </Field>

          <Field data-invalid={!!validationErrors.env}>
            <FieldLabel>Environment variables</FieldLabel>
            <FieldDescription>
              Merged into every shell command the agent runs in this sandbox.
              Values are kept server-side and never sent to the model. Workspace
              defaults override any env the agent passes on the same key.
            </FieldDescription>
            <div className="flex flex-col gap-2">
              {formData.env.map((row, idx) => (
                <div key={idx} className="flex gap-2 items-start">
                  <Input
                    placeholder="KEY"
                    value={row.key}
                    aria-label={`Env key ${idx + 1}`}
                    disabled={isSubmitting}
                    onChange={(e) => {
                      const next = [...formData.env];
                      next[idx] = { ...next[idx], key: e.target.value };
                      setFormData((prev) => ({ ...prev, env: next }));
                      if (validationErrors.env) {
                        setValidationErrors((prev) => {
                          const n = { ...prev };
                          delete n.env;
                          return n;
                        });
                      }
                    }}
                    className="font-mono"
                  />
                  <Input
                    placeholder="value"
                    value={row.value}
                    aria-label={`Env value ${idx + 1}`}
                    disabled={isSubmitting}
                    type="password"
                    autoComplete="off"
                    onChange={(e) => {
                      const next = [...formData.env];
                      next[idx] = { ...next[idx], value: e.target.value };
                      setFormData((prev) => ({ ...prev, env: next }));
                    }}
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove env row ${idx + 1}`}
                    disabled={isSubmitting}
                    onClick={() => {
                      const next = formData.env.filter((_, i) => i !== idx);
                      setFormData((prev) => ({ ...prev, env: next }));
                    }}
                  >
                    <X />
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isSubmitting}
                  onClick={() =>
                    setFormData((prev) => ({
                      ...prev,
                      env: [...prev.env, { key: "", value: "" }],
                    }))
                  }
                >
                  <Plus /> Add variable
                </Button>
              </div>
            </div>
            {validationErrors.env && (
              <FieldError>{validationErrors.env}</FieldError>
            )}
          </Field>
        </FieldGroup>
      </FieldSet>

      <div className="flex gap-2">
        <Button
          className="cursor-pointer"
          onClick={handleSave}
          disabled={isSubmitting}
        >
          {hasSandbox ? "Update" : "Save"}
        </Button>

        {hasSandbox ? (
          <Button
            className="cursor-pointer"
            variant="outline"
            onClick={() => setIsDeleteDialogOpen(true)}
            disabled={isSubmitting}
          >
            <Trash2 /> Delete
          </Button>
        ) : (
          <Button
            className="cursor-pointer"
            variant="ghost"
            onClick={() => {
              setIsConfiguring(false);
              setFormData(DEFAULT_FORM);
              setValidationErrors({});
            }}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete sandbox"
        description="Are you sure you want to delete this sandbox? This action cannot be undone."
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={handleDelete}
        loading={isDeleting}
      />

      <ConfirmDialog
        open={forceDialog.open}
        onOpenChange={(open) => {
          if (!open && !isForcing) {
            setForceDialog({ open: false, kind: null, message: "" });
          }
        }}
        title={
          forceDialog.kind === "delete"
            ? "Force delete sandbox"
            : "Force switch backend"
        }
        description={forceDialog.message}
        confirmLabel={
          forceDialog.kind === "delete" ? "Delete anyway" : "Switch anyway"
        }
        confirmVariant="destructive"
        onConfirm={handleForceConfirm}
        loading={isForcing}
      />
    </div>
  );
};

export { SandboxSettings };
