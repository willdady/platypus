"use client";

import { useState } from "react";
import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useScopedList } from "@/hooks/use-scoped-list";
import { toast } from "sonner";
import { Box, KeyRound, Plus } from "lucide-react";
import { type Sandbox } from "@platypus/schemas";

import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { canConfigureSandbox } from "@/lib/authorization";
import {
  scopedUrl,
  writeAt,
  type FormDraft,
  type WriteOutcome,
} from "@/lib/api-write";
import { optionalFetcher } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  KeyValueRowsEditor,
  newRow,
  recordToRows,
  rowsToRecord,
  type KeyValueRow,
} from "@/components/key-value-rows-editor";
import { Switch } from "@/components/ui/switch";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldTitle,
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
import { EmptyCard } from "@/components/empty-card";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import { ListError } from "@/components/list-state";
import { Skeleton } from "@/components/ui/skeleton";

type SandboxBackend = { backend: string; name: string };

// The docker reference backend exposes host reachability via these two config
// fields. See ADR-0005. Other backends ignore them.
const DOCKER_BACKEND = "docker";

// The SSH reference backend (ADR-0012) attaches to a pre-existing host. Its
// config (host/port/user/rootDir) and credentials (privateKey/passphrase) are
// all admin-only, inherited from the existing requireSandboxAdmin gating.
const SSH_BACKEND = "ssh";
const DEFAULT_SSH_PORT = "22";

type SandboxFormData = {
  name: string;
  backend: string;
  // Two-tier env (ADR-0006): admin-managed vs owner-managed.
  adminEnv: KeyValueRow[];
  userEnv: KeyValueRow[];
  // Docker host reachability (ADR-0005), admin-only.
  networks: string[];
  extraHosts: KeyValueRow[]; // key = hostname, value = ip / host-gateway
  // SSH connection (ADR-0012), admin-only. Port is kept as a string for the
  // input and parsed on save. privateKey/passphrase are credentials: GET never
  // returns them (only `hasCredentials`), so blank means "keep the stored key".
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshRootDir: string;
  // Optional host-key pin (ADR-0012). Part of config, not credentials — returned
  // by GET like the rest of the SSH config.
  sshHostKey: string;
  sshPrivateKey: string;
  sshPassphrase: string;
};

const DEFAULT_FORM: SandboxFormData = {
  name: "",
  backend: "",
  adminEnv: [],
  userEnv: [],
  networks: [],
  extraHosts: [],
  sshHost: "",
  sshPort: DEFAULT_SSH_PORT,
  sshUser: "",
  sshRootDir: "",
  sshHostKey: "",
  sshPrivateKey: "",
  sshPassphrase: "",
};

// extraHosts travel as `["hostname:target", ...]`. Split on the first colon so
// IPv6 targets (which contain colons) survive intact.
const extraHostsToRows = (entries: string[] | undefined): KeyValueRow[] =>
  (entries ?? []).map((entry) => {
    const idx = entry.indexOf(":");
    return idx === -1
      ? newRow(entry)
      : newRow(entry.slice(0, idx), entry.slice(idx + 1));
  });

const rowsToExtraHosts = (rows: KeyValueRow[]): string[] =>
  rows
    .filter((r) => r.key.trim() !== "")
    .map((r) => `${r.key.trim()}:${r.value.trim()}`);

const findDuplicateKey = (rows: KeyValueRow[]): string | null => {
  const seen = new Set<string>();
  for (const { key } of rows) {
    const trimmed = key.trim();
    if (trimmed === "") continue;
    if (seen.has(trimmed)) return trimmed;
    seen.add(trimmed);
  }
  return null;
};

const SAVED_MESSAGE = "Sandbox configured";
const DELETED_MESSAGE = "Sandbox deleted";

// A teardown the backend could not finish asks to be retried with `force=true`.
const isForceRetry = (outcome: WriteOutcome<unknown>): boolean =>
  outcome.outcome === "error" &&
  outcome.httpStatus === 500 &&
  outcome.message.includes("force=true");

// One label / control / description field, at the form's sizes.
const FieldSkeleton = ({
  control,
  description = true,
}: {
  control: string;
  description?: boolean;
}) => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-4 w-28" />
    <Skeleton className={control} />
    {description && <Skeleton className="h-4 w-3/4" />}
  </div>
);

// Mirrors the configured-sandbox form — the shape most workspaces land on —
// rather than the Empty card: name, backend, the env editors, then Save.
const SandboxSettingsSkeleton = ({
  canConfigure,
}: {
  canConfigure: boolean;
}) => (
  <div aria-label="Loading sandbox">
    <div className="mb-6 flex flex-col gap-7">
      <FieldSkeleton control="h-9 w-full" description={false} />
      <FieldSkeleton control="h-9 w-full" />
      {canConfigure && <FieldSkeleton control="h-8 w-32" />}
      <FieldSkeleton control="h-8 w-32" />
    </div>
    <Skeleton className="h-9 w-16" />
  </div>
);

const SandboxSettings = ({
  orgId,
  workspaceId,
  draft,
}: {
  orgId: string;
  /** Absent only for a draft, whose Workspace does not exist yet. */
  workspaceId?: string;
  /** Collect the Sandbox rather than save it (see `FormDraft`). */
  draft?: FormDraft;
}) => {
  const { actor } = useAuth();
  const backendUrl = useBackendUrl();
  // Credential- and reach-bearing sandbox config is admin-managed (ADR-0006).
  const canConfigure = canConfigureSandbox(actor);

  const scope = { orgId, workspaceId };

  // The same URL the reads above key on, so a write and its revalidation
  // can't drift apart.
  const sandboxUrl = scopedUrl(backendUrl, "sandbox", scope);

  const { data, error, isLoading, mutate } = useScopedSWR<Sandbox | null>(
    "sandbox",
    draft ? null : scope,
    { fetcher: optionalFetcher },
  );

  const { results: backends, isLoading: backendsLoading } =
    useScopedList<SandboxBackend>("sandbox-backends", { orgId });

  // Operator network allowlist — admin-only endpoint (ADR-0005).
  const { results: allowedNetworks, isLoading: networksLoading } =
    useScopedList<string>(
      "sandbox-backends/networks",
      canConfigure ? { orgId } : null,
    );

  const [isConfiguring, setIsConfiguring] = useState(false);
  // Whether the admin chose to replace a stored SSH key, revealing the textarea
  // in place of the "Key stored" state.
  const [isReplacingKey, setIsReplacingKey] = useState(false);

  const [forceDialog, setForceDialog] = useState<{
    open: boolean;
    kind: "save" | "delete" | null;
    message: string;
  }>({ open: false, kind: null, message: "" });
  const [isForcing, setIsForcing] = useState(false);

  // A sandbox is the Workspace's singleton, read from the collection path
  // itself with no id, so the hook only writes and the read above seeds.
  const {
    formData,
    setFormData,
    seedFormData,
    validationErrors,
    setValidationErrors,
    isSubmitting,
    clearErrors,
    submit,
  } = useEntityForm<SandboxFormData>({
    initialData: DEFAULT_FORM,
    entity: "sandbox",
    scope,
    write: () => writeSandbox(),
    // A rejected save toasts, as there is no one field to key a conflict to.
    conflictField: null,
    onError: (message, outcome) => {
      if (isForceRetry(outcome)) {
        setForceDialog({
          open: true,
          kind: "save",
          message:
            "Failed to tear down previous sandbox — switch anyway? External resources may leak.",
        });
      } else {
        toast.error(message);
      }
    },
    failureMessage: "Failed to save sandbox",
    // A draft stays put: the wizard moves on once `write` accepts it.
    successMessage: draft ? undefined : SAVED_MESSAGE,
    onSuccess: draft ? undefined : () => reseedFromServer(),
  });

  const {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    deleteError,
    openDeleteDialog,
    handleDelete,
  } = useEntityDelete({
    entity: "sandbox",
    scope,
    id: data?.id,
    successMessage: DELETED_MESSAGE,
    write: () => deleteSandbox(),
    // A failed destroy is offered as a forced retry in its own dialog; every
    // other refusal stays inline.
    onError: (_message, outcome) => {
      if (!isForceRetry(outcome)) return false;
      setIsDeleteDialogOpen(false);
      setForceDialog({
        open: true,
        kind: "delete",
        message: "Failed to destroy sandbox — delete anyway?",
      });
      return true;
    },
    onSuccess: async () => {
      setIsDeleteDialogOpen(false);
      await clearDeleted();
    },
  });

  function seedFrom(record: Sandbox) {
    setIsReplacingKey(false);
    const config = (record.config ?? {}) as {
      networks?: string[];
      extraHosts?: string[];
      host?: string;
      port?: number;
      user?: string;
      rootDir?: string;
      hostKey?: string;
    };
    seedFormData({
      ...DEFAULT_FORM,
      name: record.name,
      backend: record.backend,
      adminEnv: recordToRows(record.adminEnv),
      userEnv: recordToRows(record.userEnv),
      networks: config.networks ?? [],
      extraHosts: extraHostsToRows(config.extraHosts),
      // SSH config. The key and passphrase stay blank: GET strips them, and an
      // edit that doesn't enter a new key preserves the stored one.
      sshHost: config.host ?? "",
      sshPort: config.port ? String(config.port) : DEFAULT_SSH_PORT,
      sshUser: config.user ?? "",
      sshRootDir: config.rootDir ?? "",
      sshHostKey: config.hostKey ?? "",
    });
  }

  // Keyed on the id, not the record: SWR hands back a new object on every
  // revalidation, and re-seeding on that would overwrite the edit in progress.
  // A save re-seeds explicitly from what it wrote back.
  useResetOnChange(data ? data.id : data, () => {
    setIsReplacingKey(false);
    if (data) seedFrom(data);
  });

  // When creating (no existing record), default the backend to the first
  // available one until the user picks another.
  useResetOnChange(backends, () => {
    if (!data && backends.length > 0) {
      seedFormData((prev) =>
        prev.backend ? prev : { ...prev, backend: backends[0].backend },
      );
    }
  });

  const isDocker = formData.backend === DOCKER_BACKEND;
  const isSsh = formData.backend === SSH_BACKEND;

  function writeSandbox(
    options: { force?: boolean } = {},
  ): Promise<WriteOutcome<unknown>> {
    const isCreate = !data;
    const method = isCreate ? "POST" : "PUT";
    const url =
      isCreate || !options.force ? sandboxUrl : `${sandboxUrl}?force=true`;

    // Backend-specific config. Docker carries host reachability (ADR-0005); SSH
    // carries the connection target (ADR-0012). Other backends take no config.
    const config = isDocker
      ? {
          networks: formData.networks,
          extraHosts: rowsToExtraHosts(formData.extraHosts),
        }
      : isSsh
        ? {
            host: formData.sshHost.trim(),
            port: Number(formData.sshPort) || Number(DEFAULT_SSH_PORT),
            user: formData.sshUser.trim(),
            // rootDir is optional — omit when blank so the backend applies its
            // `$HOME/platypus-workspace` default.
            ...(formData.sshRootDir.trim()
              ? { rootDir: formData.sshRootDir.trim() }
              : {}),
            // hostKey is optional — omit when blank so the backend connects with
            // the MITM warning rather than pinning.
            ...(formData.sshHostKey.trim()
              ? { hostKey: formData.sshHostKey.trim() }
              : {}),
          }
        : {};

    // The `credentials` slice of the payload (spread below). For SSH (ADR-0012)
    // we only send credentials when a private key was entered: omitting
    // `credentials` preserves the stored value server-side rather than clearing
    // it. The passphrase travels only with a key, so it is never dropped
    // silently. Other backends send an empty credentials object, as before.
    const credentialsPayload =
      isSsh && formData.sshPrivateKey.trim()
        ? {
            credentials: {
              privateKey: formData.sshPrivateKey,
              ...(formData.sshPassphrase
                ? { passphrase: formData.sshPassphrase }
                : {}),
            },
          }
        : isSsh
          ? {} // omit credentials — preserve stored
          : { credentials: {} };

    // Non-admin owners may only change name + userEnv (ADR-0006); everything
    // else is admin-controlled and ignored server-side, so we don't send it.
    const payload = canConfigure
      ? {
          ...(isCreate ? { workspaceId } : {}),
          name: formData.name,
          backend: formData.backend,
          config,
          ...credentialsPayload,
          adminEnv: rowsToRecord(formData.adminEnv, {}),
          userEnv: rowsToRecord(formData.userEnv, {}),
        }
      : {
          name: formData.name,
          backend: formData.backend,
          userEnv: rowsToRecord(formData.userEnv, {}),
        };

    return draft
      ? draft.write(payload)
      : writeAt(url, { method, data: payload });
  }

  function deleteSandbox(options: { force?: boolean } = {}) {
    const url = options.force ? `${sandboxUrl}?force=true` : sandboxUrl;
    return writeAt(url, { method: "DELETE" });
  }

  async function reseedFromServer() {
    const saved = await mutate();
    if (saved) seedFrom(saved);
    setIsConfiguring(false);
  }

  async function clearDeleted() {
    await mutate(null, { revalidate: false });
    setIsConfiguring(false);
    seedFormData(DEFAULT_FORM);
    mutate();
  }

  const handleSave = () => {
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
    void submit();
  };

  const closeForceDialog = () =>
    setForceDialog({ open: false, kind: null, message: "" });

  const handleForceConfirm = async () => {
    setIsForcing(true);
    try {
      if (forceDialog.kind === "save") {
        const outcome = await writeSandbox({ force: true });
        if (outcome.outcome === "success") {
          await reseedFromServer();
          toast.success(SAVED_MESSAGE);
        } else {
          toast.error("Failed to switch sandbox backend");
        }
      } else if (forceDialog.kind === "delete") {
        const outcome = await deleteSandbox({ force: true });
        if (outcome.outcome === "success") {
          await clearDeleted();
          toast.success(DELETED_MESSAGE);
        } else {
          toast.error("Failed to delete sandbox");
        }
      }
    } catch (err) {
      console.error("Force retry error:", err);
      toast.error("Operation failed");
    } finally {
      closeForceDialog();
      setIsForcing(false);
    }
  };

  if (isLoading || backendsLoading) {
    return <SandboxSettingsSkeleton canConfigure={canConfigure} />;
  }

  if (error) {
    return <ListError error={error} subject="sandbox" />;
  }

  const hasSandbox = !!data;
  const keyStored =
    data?.backend === SSH_BACKEND && data.hasCredentials && !isReplacingKey;
  const showForm = hasSandbox || isConfiguring || !!draft;
  const noBackends = backends.length === 0;

  if (!showForm) {
    return (
      <EmptyCard
        icon={<Box />}
        title="No sandbox configured"
        description={
          !canConfigure
            ? "No sandbox is configured for this workspace. Ask an organization admin to set one up."
            : noBackends
              ? "No sandbox backends are registered on this server. Add @platypus/docker to PLATYPUS_PLUGINS (or register another backend) and restart the backend."
              : "Configure a sandbox to run agent code in an isolated environment."
        }
        action={
          canConfigure && (
            <Button
              onClick={() => setIsConfiguring(true)}
              disabled={noBackends}
            >
              <Plus /> Configure sandbox
            </Button>
          )
        }
      />
    );
  }

  return (
    <div>
      <FieldSet className="mb-6">
        <FieldGroup>
          <Field data-invalid={!!validationErrors.name}>
            <FieldLabel htmlFor="sandbox-name">Name</FieldLabel>
            <Input
              id="sandbox-name"
              placeholder="My sandbox"
              value={formData.name}
              onChange={(e) => {
                clearErrors("name");
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
                clearErrors("backend");
                setFormData((prev) => ({ ...prev, backend: value }));
              }}
              disabled={isSubmitting || !canConfigure}
            >
              <SelectTrigger
                id="backend"
                disabled={isSubmitting || !canConfigure}
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
              {!canConfigure && " Managed by an organization admin."}
            </FieldDescription>
            {validationErrors.backend && (
              <FieldError>{validationErrors.backend}</FieldError>
            )}
          </Field>

          {/* Host reachability (ADR-0005) — admin-only, docker backend only. */}
          {canConfigure && isDocker && (
            <>
              <Field
                aria-labelledby="sandbox-networks-label"
                data-invalid={!!validationErrors.networks}
              >
                <FieldTitle id="sandbox-networks-label">Networks</FieldTitle>
                <FieldDescription>
                  Docker networks this sandbox may attach to. The list is
                  declared by the operator in the deployment&apos;s plugin
                  configuration. Off by default.
                </FieldDescription>
                {networksLoading ? (
                  // A network row, in place of the false "none declared"
                  // while the allowlist is still loading.
                  <div
                    className="flex items-center justify-between gap-2"
                    aria-label="Loading networks"
                  >
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-[1.15rem] w-8 rounded-full" />
                  </div>
                ) : allowedNetworks.length === 0 ? (
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

              <Field
                aria-labelledby="sandbox-extra-hosts-label"
                data-invalid={!!validationErrors.config}
              >
                <FieldTitle id="sandbox-extra-hosts-label">
                  Extra hosts
                </FieldTitle>
                <FieldDescription>
                  Extra <span className="font-mono">hostname → target</span>{" "}
                  entries added to the container (target is an IP or{" "}
                  <span className="font-mono">host-gateway</span>). Lets agent
                  code reach host services. Off by default.
                </FieldDescription>
                <KeyValueRowsEditor
                  rows={formData.extraHosts}
                  onChange={(rows) => {
                    clearErrors("config");
                    setFormData((prev) => ({ ...prev, extraHosts: rows }));
                  }}
                  disabled={isSubmitting}
                  keyPlaceholder="hostname"
                  valuePlaceholder="host-gateway"
                  addLabel="Add host"
                  mono
                />
                {validationErrors.config && (
                  <FieldError>{validationErrors.config}</FieldError>
                )}
              </Field>
            </>
          )}

          {/* SSH connection (ADR-0012) — admin-only, ssh backend only. */}
          {canConfigure && isSsh && (
            <>
              <Field data-invalid={!!validationErrors.config}>
                <FieldLabel htmlFor="ssh-host">Host</FieldLabel>
                <Input
                  id="ssh-host"
                  placeholder="ssh.example.com"
                  value={formData.sshHost}
                  onChange={(e) => {
                    clearErrors("config");
                    setFormData((prev) => ({
                      ...prev,
                      sshHost: e.target.value,
                    }));
                  }}
                  disabled={isSubmitting}
                  className="font-mono"
                />
                <FieldDescription>
                  Hostname or IP of the operator-owned host to attach to.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="ssh-port">Port</FieldLabel>
                <Input
                  id="ssh-port"
                  type="number"
                  placeholder={DEFAULT_SSH_PORT}
                  value={formData.sshPort}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      sshPort: e.target.value,
                    }))
                  }
                  disabled={isSubmitting}
                  className="font-mono"
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="ssh-user">User</FieldLabel>
                <Input
                  id="ssh-user"
                  placeholder="platypus"
                  value={formData.sshUser}
                  onChange={(e) => {
                    clearErrors("config");
                    setFormData((prev) => ({
                      ...prev,
                      sshUser: e.target.value,
                    }));
                  }}
                  disabled={isSubmitting}
                  className="font-mono"
                />
                <FieldDescription>
                  SSH login user. Public-key auth only.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="ssh-root-dir">
                  Workspace root (optional)
                </FieldLabel>
                <Input
                  id="ssh-root-dir"
                  placeholder="$HOME/platypus-workspace"
                  value={formData.sshRootDir}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      sshRootDir: e.target.value,
                    }))
                  }
                  disabled={isSubmitting}
                  className="font-mono"
                />
                <FieldDescription>
                  Absolute or $HOME-relative directory the sandbox works in.
                  Defaults to{" "}
                  <span className="font-mono">$HOME/platypus-workspace</span>,
                  created on first connect.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="ssh-host-key">
                  Host key (optional)
                </FieldLabel>
                <textarea
                  id="ssh-host-key"
                  placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5..."
                  value={formData.sshHostKey}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      sshHostKey: e.target.value,
                    }))
                  }
                  disabled={isSubmitting}
                  rows={3}
                  autoComplete="off"
                  spellCheck={false}
                  className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                />
                <FieldDescription>
                  Pin the host&apos;s public key to reject a man-in-the-middle.
                  Obtain it with{" "}
                  <span className="font-mono">
                    ssh-keyscan -t ed25519 {formData.sshHost || "<host>"}
                  </span>
                  . Leave blank to connect unverified (a warning is logged).
                </FieldDescription>
              </Field>

              <Field>
                {/* Once stored there is no control to label, only the status
                    row, so the caption drops to plain text. */}
                {keyStored ? (
                  <FieldTitle>Private key</FieldTitle>
                ) : (
                  <FieldLabel htmlFor="ssh-private-key">Private key</FieldLabel>
                )}
                {keyStored ? (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-input px-3 py-2 text-sm">
                    <span className="flex items-center gap-2">
                      <KeyRound className="size-4 text-muted-foreground" />
                      Key stored
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setIsReplacingKey(true)}
                      disabled={isSubmitting}
                    >
                      Replace key
                    </Button>
                  </div>
                ) : (
                  <textarea
                    id="ssh-private-key"
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    value={formData.sshPrivateKey}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        sshPrivateKey: e.target.value,
                        // The passphrase only travels with a key, so clearing
                        // the key clears it rather than dropping it on save.
                        sshPassphrase: e.target.value.trim()
                          ? prev.sshPassphrase
                          : "",
                      }))
                    }
                    disabled={isSubmitting}
                    rows={5}
                    autoComplete="off"
                    spellCheck={false}
                    className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  />
                )}
                <FieldDescription>
                  PEM or OpenSSH private key. Kept server-side, never sent to
                  the model.
                  {isReplacingKey && " Leave blank to keep the stored key."}
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="ssh-passphrase">
                  Key passphrase (optional)
                </FieldLabel>
                <Input
                  id="ssh-passphrase"
                  type="password"
                  placeholder="Passphrase for the private key"
                  value={formData.sshPassphrase}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      sshPassphrase: e.target.value,
                    }))
                  }
                  disabled={isSubmitting || !formData.sshPrivateKey.trim()}
                  autoComplete="off"
                  className="font-mono"
                />
                <FieldDescription>
                  Enter a private key first. A new key replaces the stored
                  passphrase too, so re-enter it here if the key is encrypted.
                </FieldDescription>
              </Field>
            </>
          )}

          {/* Admin-managed env (ADR-0006). */}
          {canConfigure && (
            <Field
              aria-labelledby="sandbox-admin-env-label"
              data-invalid={!!validationErrors.adminEnv}
            >
              <FieldTitle id="sandbox-admin-env-label">
                Admin environment variables
              </FieldTitle>
              <FieldDescription>
                Org-admin-managed. Merged into every shell command and take
                precedence over workspace-owner variables. Kept server-side,
                never sent to the model.
              </FieldDescription>
              <KeyValueRowsEditor
                rows={formData.adminEnv}
                onChange={(rows) => {
                  clearErrors("adminEnv");
                  setFormData((prev) => ({ ...prev, adminEnv: rows }));
                }}
                disabled={isSubmitting}
                keyPlaceholder="KEY"
                valuePlaceholder="value"
                maskValue
                mono
                addLabel="Add variable"
              />
              {validationErrors.adminEnv && (
                <FieldError>{validationErrors.adminEnv}</FieldError>
              )}
            </Field>
          )}

          {/* Owner-managed env (ADR-0006). Visible/editable to owner + admin. */}
          <Field
            aria-labelledby="sandbox-user-env-label"
            data-invalid={!!validationErrors.userEnv}
          >
            <FieldTitle id="sandbox-user-env-label">
              Environment variables
            </FieldTitle>
            <FieldDescription>
              Merged into every shell command the agent runs in this sandbox.
              Values are kept server-side and never sent to the model. Cannot
              override an admin-managed key.
            </FieldDescription>
            {/* Admin keys are shown read-only so the owner knows which names
                are reserved (values are never returned to non-admins). */}
            {!canConfigure && formData.adminEnv.length > 0 && (
              <div className="mb-2">
                <p className="text-xs text-muted-foreground mb-1">
                  Managed by admin (read-only):
                </p>
                <KeyValueRowsEditor
                  rows={formData.adminEnv}
                  onChange={() => {}}
                  disabled
                  readOnly
                  keyPlaceholder="KEY"
                  valuePlaceholder="(hidden)"
                  addLabel=""
                  mono
                />
              </div>
            )}
            <KeyValueRowsEditor
              rows={formData.userEnv}
              onChange={(rows) => {
                clearErrors("userEnv");
                setFormData((prev) => ({ ...prev, userEnv: rows }));
              }}
              disabled={isSubmitting}
              keyPlaceholder="KEY"
              valuePlaceholder="value"
              maskValue
              mono
              addLabel="Add variable"
            />
            {validationErrors.userEnv && (
              <FieldError>{validationErrors.userEnv}</FieldError>
            )}
          </Field>
        </FieldGroup>
      </FieldSet>

      {draft ? (
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={draft.onBack}
            disabled={isSubmitting}
          >
            Back
          </Button>
          <Button onClick={handleSave} disabled={isSubmitting}>
            {draft.submitText}
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <FormFooterButtons
            submitText="Save"
            onSubmit={handleSave}
            submitDisabled={isSubmitting}
            deleteVisible={hasSandbox && canConfigure}
            deleteDisabled={isSubmitting}
            onDelete={openDeleteDialog}
          />

          {!hasSandbox && (
            <Button
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
      )}

      <DeleteConfirmDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete sandbox"
        description="Are you sure you want to delete this sandbox? This action cannot be undone."
        onConfirm={handleDelete}
        loading={isDeleting}
        error={deleteError}
      />

      <ConfirmDialog
        open={forceDialog.open}
        onOpenChange={(open) => {
          if (!open && !isForcing) closeForceDialog();
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
