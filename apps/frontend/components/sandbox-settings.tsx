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
import { Switch } from "@/components/ui/switch";
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

// The docker reference backend exposes host reachability via these two config
// fields. See ADR-0005. Other backends ignore them.
const DOCKER_BACKEND = "docker";

// Rows are kept as an ordered array (not a Record) so a user can edit keys, add
// empties, and tolerate duplicate-during-edit without the UI reshuffling on
// every keystroke. Converted on save.
type Row = { key: string; value: string };

type SandboxFormData = {
  name: string;
  backend: string;
  // Two-tier env (ADR-0006): admin-managed vs owner-managed.
  adminEnv: Row[];
  userEnv: Row[];
  // Docker host reachability (ADR-0005), admin-only.
  networks: string[];
  extraHosts: Row[]; // key = hostname, value = ip / host-gateway
};

const DEFAULT_FORM: SandboxFormData = {
  name: "",
  backend: "",
  adminEnv: [],
  userEnv: [],
  networks: [],
  extraHosts: [],
};

const recordToRows = (rec: Record<string, string> | undefined): Row[] =>
  Object.entries(rec ?? {}).map(([key, value]) => ({ key, value }));

const rowsToRecord = (rows: Row[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const { key, value } of rows) {
    const trimmedKey = key.trim();
    if (trimmedKey === "") continue;
    out[trimmedKey] = value;
  }
  return out;
};

// extraHosts travel as `["hostname:target", ...]`. Split on the first colon so
// IPv6 targets (which contain colons) survive intact.
const extraHostsToRows = (entries: string[] | undefined): Row[] =>
  (entries ?? []).map((entry) => {
    const idx = entry.indexOf(":");
    return idx === -1
      ? { key: entry, value: "" }
      : { key: entry.slice(0, idx), value: entry.slice(idx + 1) };
  });

const rowsToExtraHosts = (rows: Row[]): string[] =>
  rows
    .filter((r) => r.key.trim() !== "")
    .map((r) => `${r.key.trim()}:${r.value.trim()}`);

const findDuplicateKey = (rows: Row[]): string | null => {
  const seen = new Set<string>();
  for (const { key } of rows) {
    const trimmed = key.trim();
    if (trimmed === "") continue;
    if (seen.has(trimmed)) return trimmed;
    seen.add(trimmed);
  }
  return null;
};

const isForceRetryError = (errorMessage: unknown): boolean =>
  typeof errorMessage === "string" && errorMessage.includes("force=true");

// Reusable key/value editor used for both env tiers and extraHosts.
const RowsEditor = ({
  rows,
  onChange,
  disabled,
  readOnly,
  keyPlaceholder,
  valuePlaceholder,
  maskValue,
  addLabel,
}: {
  rows: Row[];
  onChange: (rows: Row[]) => void;
  disabled: boolean;
  readOnly?: boolean;
  keyPlaceholder: string;
  valuePlaceholder: string;
  maskValue?: boolean;
  addLabel: string;
}) => (
  <div className="flex flex-col gap-2">
    {rows.map((row, idx) => (
      <div key={idx} className="flex gap-2 items-start">
        <Input
          placeholder={keyPlaceholder}
          value={row.key}
          aria-label={`${keyPlaceholder} ${idx + 1}`}
          disabled={disabled || readOnly}
          onChange={(e) => {
            const next = [...rows];
            next[idx] = { ...next[idx], key: e.target.value };
            onChange(next);
          }}
          className="font-mono"
        />
        <Input
          placeholder={valuePlaceholder}
          value={row.value}
          aria-label={`${valuePlaceholder} ${idx + 1}`}
          disabled={disabled || readOnly}
          type={maskValue ? "password" : "text"}
          autoComplete="off"
          onChange={(e) => {
            const next = [...rows];
            next[idx] = { ...next[idx], value: e.target.value };
            onChange(next);
          }}
          className="font-mono"
        />
        {!readOnly && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove row ${idx + 1}`}
            disabled={disabled}
            onClick={() => onChange(rows.filter((_, i) => i !== idx))}
          >
            <X />
          </Button>
        )}
      </div>
    ))}
    {!readOnly && (
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...rows, { key: "", value: "" }])}
        >
          <Plus /> {addLabel}
        </Button>
      </div>
    )}
  </div>
);

const SandboxSettings = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const { user, isOrgAdmin } = useAuth();
  const backendUrl = useBackendUrl();

  const sandboxUrl = joinUrl(
    backendUrl,
    `/organizations/${orgId}/workspaces/${workspaceId}/sandbox`,
  );

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

  // Operator network allowlist — admin-only endpoint (ADR-0005).
  const { data: networksData } = useSWR<{ results: string[] }>(
    backendUrl && user && isOrgAdmin ? `${sandboxUrl}/networks` : null,
    fetcher,
  );
  const allowedNetworks = networksData?.results ?? [];

  const [isConfiguring, setIsConfiguring] = useState(false);
  const [formData, setFormData] = useState<SandboxFormData>(DEFAULT_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const [forceDialog, setForceDialog] = useState<{
    open: boolean;
    kind: "save" | "delete" | null;
    message: string;
  }>({ open: false, kind: null, message: "" });
  const [isForcing, setIsForcing] = useState(false);

  useEffect(() => {
    if (data) {
      const config = (data.config ?? {}) as {
        networks?: string[];
        extraHosts?: string[];
      };
      setFormData({
        name: data.name,
        backend: data.backend,
        adminEnv: recordToRows(data.adminEnv),
        userEnv: recordToRows(data.userEnv),
        networks: config.networks ?? [],
        extraHosts: extraHostsToRows(config.extraHosts),
      });
    } else if (backends.length > 0) {
      setFormData((prev) =>
        prev.backend ? prev : { ...prev, backend: backends[0].backend },
      );
    }
  }, [data, backends]);

  const clearError = (field: string) => {
    if (validationErrors[field]) {
      setValidationErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
  };

  const isDocker = formData.backend === DOCKER_BACKEND;

  const performSave = async (
    options: { force?: boolean } = {},
  ): Promise<{ ok: boolean; forceRetry?: boolean; errorMessage?: string }> => {
    setValidationErrors({});
    const isCreate = !data;
    const method = isCreate ? "POST" : "PUT";
    const url =
      isCreate || !options.force ? sandboxUrl : `${sandboxUrl}?force=true`;

    // Non-admin owners may only change name + userEnv (ADR-0006); everything
    // else is admin-controlled and ignored server-side, so we don't send it.
    const payload = isOrgAdmin
      ? {
          ...(isCreate ? { workspaceId } : {}),
          name: formData.name,
          backend: formData.backend,
          config: isDocker
            ? {
                networks: formData.networks,
                extraHosts: rowsToExtraHosts(formData.extraHosts),
              }
            : {},
          credentials: {},
          adminEnv: rowsToRecord(formData.adminEnv),
          userEnv: rowsToRecord(formData.userEnv),
        }
      : {
          name: formData.name,
          backend: formData.backend,
          userEnv: rowsToRecord(formData.userEnv),
        };

    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "include",
    });

    if (response.ok) return { ok: true };

    const errorData = await response.json().catch(() => ({}));

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
    const dupAdmin = findDuplicateKey(formData.adminEnv);
    const dupUser = findDuplicateKey(formData.userEnv);
    if (dupAdmin) {
      setValidationErrors({ adminEnv: `Duplicate env key: ${dupAdmin}` });
      return;
    }
    if (dupUser) {
      setValidationErrors({ userEnv: `Duplicate env key: ${dupUser}` });
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
            {!isOrgAdmin
              ? "No sandbox is configured for this workspace. Ask an organization admin to set one up."
              : noBackends
                ? "No sandbox backends are registered on this server. Set PLATYPUS_SANDBOX_DOCKER_ENABLED=true (or register another backend) and restart the backend."
                : "Configure a sandbox to run agent code in an isolated environment."}
          </EmptyDescription>
        </EmptyHeader>
        {isOrgAdmin && (
          <EmptyContent>
            <Button
              onClick={() => setIsConfiguring(true)}
              disabled={noBackends}
            >
              <Plus /> Configure sandbox
            </Button>
          </EmptyContent>
        )}
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
              onChange={(e) => {
                clearError("name");
                setFormData((prev) => ({ ...prev, name: e.target.value }));
              }}
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
              onValueChange={(value) => {
                clearError("backend");
                setFormData((prev) => ({ ...prev, backend: value }));
              }}
              disabled={isSubmitting || !isOrgAdmin}
            >
              <SelectTrigger
                id="backend"
                disabled={isSubmitting || !isOrgAdmin}
              >
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
              {!isOrgAdmin && " Managed by an organization admin."}
            </FieldDescription>
            {validationErrors.backend && (
              <FieldError>{validationErrors.backend}</FieldError>
            )}
          </Field>

          {/* Host reachability (ADR-0005) — admin-only, docker backend only. */}
          {isOrgAdmin && isDocker && (
            <>
              <Field data-invalid={!!validationErrors.networks}>
                <FieldLabel>Networks</FieldLabel>
                <FieldDescription>
                  Docker networks this sandbox may attach to. The list is
                  declared by the operator via
                  <span className="font-mono">
                    {" "}
                    PLATYPUS_SANDBOX_DOCKER_ALLOWED_NETWORKS
                  </span>
                  . Off by default.
                </FieldDescription>
                {allowedNetworks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No networks declared by the operator.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {allowedNetworks.map((net) => {
                      const checked = formData.networks.includes(net);
                      return (
                        <div
                          key={net}
                          className="flex items-center justify-between gap-2"
                        >
                          <span className="font-mono text-sm">{net}</span>
                          <Switch
                            checked={checked}
                            disabled={isSubmitting}
                            onCheckedChange={(on) =>
                              setFormData((prev) => ({
                                ...prev,
                                networks: on
                                  ? [...prev.networks, net]
                                  : prev.networks.filter((n) => n !== net),
                              }))
                            }
                            aria-label={`Attach network ${net}`}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
                {validationErrors.networks && (
                  <FieldError>{validationErrors.networks}</FieldError>
                )}
              </Field>

              <Field data-invalid={!!validationErrors.config}>
                <FieldLabel>Extra hosts</FieldLabel>
                <FieldDescription>
                  Extra <span className="font-mono">hostname → target</span>{" "}
                  entries added to the container (target is an IP or{" "}
                  <span className="font-mono">host-gateway</span>). Lets agent
                  code reach host services. Off by default.
                </FieldDescription>
                <RowsEditor
                  rows={formData.extraHosts}
                  onChange={(rows) => {
                    clearError("config");
                    setFormData((prev) => ({ ...prev, extraHosts: rows }));
                  }}
                  disabled={isSubmitting}
                  keyPlaceholder="hostname"
                  valuePlaceholder="host-gateway"
                  addLabel="Add host"
                />
                {validationErrors.config && (
                  <FieldError>{validationErrors.config}</FieldError>
                )}
              </Field>
            </>
          )}

          {/* Admin-managed env (ADR-0006). */}
          {isOrgAdmin && (
            <Field data-invalid={!!validationErrors.adminEnv}>
              <FieldLabel>Admin environment variables</FieldLabel>
              <FieldDescription>
                Org-admin-managed. Merged into every shell command and take
                precedence over workspace-owner variables. Kept server-side,
                never sent to the model.
              </FieldDescription>
              <RowsEditor
                rows={formData.adminEnv}
                onChange={(rows) => {
                  clearError("adminEnv");
                  setFormData((prev) => ({ ...prev, adminEnv: rows }));
                }}
                disabled={isSubmitting}
                keyPlaceholder="KEY"
                valuePlaceholder="value"
                maskValue
                addLabel="Add variable"
              />
              {validationErrors.adminEnv && (
                <FieldError>{validationErrors.adminEnv}</FieldError>
              )}
            </Field>
          )}

          {/* Owner-managed env (ADR-0006). Visible/editable to owner + admin. */}
          <Field data-invalid={!!validationErrors.userEnv}>
            <FieldLabel>Environment variables</FieldLabel>
            <FieldDescription>
              Merged into every shell command the agent runs in this sandbox.
              Values are kept server-side and never sent to the model. Cannot
              override an admin-managed key.
            </FieldDescription>
            {/* Admin keys are shown read-only so the owner knows which names
                are reserved (values are never returned to non-admins). */}
            {!isOrgAdmin && formData.adminEnv.length > 0 && (
              <div className="mb-2">
                <p className="text-xs text-muted-foreground mb-1">
                  Managed by admin (read-only):
                </p>
                <RowsEditor
                  rows={formData.adminEnv}
                  onChange={() => {}}
                  disabled
                  readOnly
                  keyPlaceholder="KEY"
                  valuePlaceholder="(hidden)"
                  addLabel=""
                />
              </div>
            )}
            <RowsEditor
              rows={formData.userEnv}
              onChange={(rows) => {
                clearError("userEnv");
                setFormData((prev) => ({ ...prev, userEnv: rows }));
              }}
              disabled={isSubmitting}
              keyPlaceholder="KEY"
              valuePlaceholder="value"
              maskValue
              addLabel="Add variable"
            />
            {validationErrors.userEnv && (
              <FieldError>{validationErrors.userEnv}</FieldError>
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
          isOrgAdmin && (
            <Button
              className="cursor-pointer"
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(true)}
              disabled={isSubmitting}
            >
              <Trash2 /> Delete
            </Button>
          )
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
