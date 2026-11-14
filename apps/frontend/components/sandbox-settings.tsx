"use client";

import { useCallback, useState } from "react";
import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { useMutation } from "@/hooks/use-mutation";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useScopedList } from "@/hooks/use-scoped-list";
import { toast } from "sonner";
import { Box, Plus } from "lucide-react";
import { type Sandbox } from "@platypus/schemas";

import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { canConfigureSandbox } from "@/lib/authorization";
import {
  scopedUrl,
  writeAt,
  type FormDraft,
  type WriteOutcome,
  type Serialized,
} from "@/lib/api-write";
import { optionalFetcher } from "@/lib/utils";
import { retractFieldError, type FormErrors } from "@/lib/form-errors";
import { Button } from "@/components/ui/button";
import {
  KeyValueRowsEditor,
  newRow,
  recordToRows,
  rowsToRecord,
  type KeyValueRow,
} from "@/components/key-value-rows-editor";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select";
import { EmptyCard } from "@/components/empty-card";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  FormFooterButtons,
  PENDING_SUBMIT_TEXT,
} from "@/components/form-footer-buttons";
import { FormSelectField } from "@/components/form-select-field";
import { FormTextField } from "@/components/form-text-field";
import { ListError } from "@/components/list-state";
import { LoadingRegion } from "@/components/list-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FieldSkeleton,
  FormSkeletonGroup,
  FormSkeletonSet,
} from "@/components/form-skeleton";
import { SandboxDockerFields } from "@/components/sandbox-docker-fields";
import {
  DEFAULT_SSH_PORT,
  SandboxSshFields,
  type SandboxKeyState,
} from "@/components/sandbox-ssh-fields";

type SandboxBackend = { backend: string; name: string };

// The docker reference backend exposes host reachability via these two config
// fields. See ADR-0005. Other backends ignore them.
const DOCKER_BACKEND = "docker";

// The SSH reference backend (ADR-0012) attaches to a pre-existing host. Its
// config (host/port/user/rootDir) and credentials (privateKey/passphrase) are
// all admin-only, inherited from the existing requireSandboxAdmin gating.
const SSH_BACKEND = "ssh";

/**
 * The form's values. Exported for the per-backend field components, which read
 * and write the backend-config fields through `setConfigField`.
 */
export type SandboxFormData = {
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

/** The fields that travel in the backend's `config`, which share one error key. */
type SandboxConfigField =
  | "networks"
  | "extraHosts"
  | "sshHost"
  | "sshPort"
  | "sshUser"
  | "sshRootDir"
  | "sshHostKey"
  | "sshPrivateKey"
  | "sshPassphrase";

/** Sets one backend-config field, retracting its errors as it lands. */
type SetConfigField = <K extends SandboxConfigField>(
  field: K,
  value: SandboxFormData[K],
) => void;

/** What a per-backend config field component takes. */
export type SandboxConfigFieldsProps = {
  formData: SandboxFormData;
  setConfigField: SetConfigField;
  errors: FormErrors;
  disabled: boolean;
};

// extraHosts travel as `["hostname:target", ...]`. Split on the first colon so
// IPv6 targets (which contain colons) survive intact.
function extraHostsToRows(entries: string[] | undefined): KeyValueRow[] {
  return (entries ?? []).map((entry) => {
    const idx = entry.indexOf(":");
    return idx === -1
      ? newRow(entry)
      : newRow(entry.slice(0, idx), entry.slice(idx + 1));
  });
}

function rowsToExtraHosts(rows: KeyValueRow[]): string[] {
  return rows
    .filter((r) => r.key.trim() !== "")
    .map((r) => `${r.key.trim()}:${r.value.trim()}`);
}

function findDuplicateKey(rows: KeyValueRow[]): string | null {
  const seen = new Set<string>();
  for (const { key } of rows) {
    const trimmed = key.trim();
    if (trimmed === "") continue;
    if (seen.has(trimmed)) return trimmed;
    seen.add(trimmed);
  }
  return null;
}

const SAVED_MESSAGE = "Sandbox configured";
const DELETED_MESSAGE = "Sandbox deleted";

// A teardown the backend could not finish asks to be retried with `force=true`.
function isForceRetry(outcome: WriteOutcome<unknown>): boolean {
  return (
    outcome.outcome === "error" &&
    outcome.httpStatus === 502 &&
    outcome.message.includes("force=true")
  );
}

// Mirrors the configured-sandbox form — the shape most workspaces land on —
// rather than the Empty card: name, backend, the env editors, then Save.
function SandboxSettingsSkeleton({ canConfigure }: { canConfigure: boolean }) {
  return (
    <LoadingRegion label="Loading sandbox">
      <FormSkeletonSet>
        <FormSkeletonGroup>
          <FieldSkeleton />
          <FieldSkeleton description={1} />
          {canConfigure && <FieldSkeleton description={1} />}
          <FieldSkeleton description={1} />
        </FormSkeletonGroup>
      </FormSkeletonSet>
      <Skeleton className="h-9 w-16" />
    </LoadingRegion>
  );
}

/**
 * A teardown the backend could not finish, offered as a forced retry in its own
 * dialog: the write it retries, and what a successful retry does.
 */
type ForceRetry = {
  title: string;
  message: string;
  confirmLabel: string;
  /** Toast shown once the forced write succeeds. */
  successMessage: string;
  /** The forced write the dialog confirms. */
  retry: () => Promise<WriteOutcome<unknown>>;
  /** Runs once the forced write succeeds, before its toast. */
  onSuccess: () => Promise<void>;
};

function SandboxSettings({
  orgId,
  workspaceId,
  draft,
}: {
  orgId: string;
  /** Absent only for a draft, whose Workspace does not exist yet. */
  workspaceId?: string;
  /** Collect the Sandbox rather than save it (see `FormDraft`). */
  draft?: FormDraft;
}) {
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

  const {
    data: backendsData,
    results: backends,
    error: backendsError,
    isLoading: backendsLoading,
    mutate: mutateBackends,
  } = useScopedList<SandboxBackend>("sandbox-backends", { orgId });

  const [isConfiguring, setIsConfiguring] = useState(false);
  // Whether the admin chose to replace a stored SSH key, revealing the textarea
  // in place of the "Key stored" state.
  const [isReplacingKey, setIsReplacingKey] = useState(false);

  const [forceDialog, setForceDialog] = useState<
    (ForceRetry & { error: string | null }) | null
  >(null);

  function openForceRetry(retry: ForceRetry) {
    setForceDialog({ ...retry, error: null });
  }

  // A sandbox is the Workspace's singleton, read from the collection path
  // itself with no id, so the hook only writes and the read above seeds.
  const {
    formData,
    setFormData,
    seedFormData,
    validationErrors,
    setValidationErrors,
    isSubmitting,
    setField,
    toFieldChange,
    submit,
  } = useEntityForm<SandboxFormData>({
    initialData: DEFAULT_FORM,
    write: () => writeSandbox(),
    // A rejected save toasts, as there is no one field to key a conflict to.
    conflictField: null,
    onError: (message, outcome) => {
      if (!isForceRetry(outcome)) {
        toast.error(message);
        return;
      }
      openForceRetry({
        title: "Force switch backend",
        message:
          "Failed to tear down previous sandbox — switch anyway? External resources may leak.",
        confirmLabel: "Switch anyway",
        successMessage: SAVED_MESSAGE,
        retry: () => writeSandbox({ force: true }),
        onSuccess: reseedFromServer,
      });
    },
    failureMessage: "Failed to save sandbox",
    // A draft stays put: the wizard moves on once `write` accepts it.
    successMessage: draft ? undefined : SAVED_MESSAGE,
    onSuccess: draft ? undefined : () => reseedFromServer(),
  });

  const { setIsDeleteDialogOpen, dialogProps, openDeleteDialog } =
    useEntityDelete({
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
        openForceRetry({
          title: "Force delete sandbox",
          message: "Failed to destroy sandbox — delete anyway?",
          confirmLabel: "Delete anyway",
          successMessage: DELETED_MESSAGE,
          retry: () => deleteSandbox({ force: true }),
          onSuccess: clearDeleted,
        });
        return true;
      },
      onSuccess: async () => {
        setIsDeleteDialogOpen(false);
        await clearDeleted();
      },
    });

  // Backend config fields key their server error to `config`, so they share one
  // setter that retracts it — and the field's own key, which `networks` uses.
  // A top-level field's own name is the key, so it goes through `setField`.
  const setConfigField: SetConfigField = useCallback(
    <K extends SandboxConfigField>(field: K, value: SandboxFormData[K]) => {
      setValidationErrors((prev) =>
        retractFieldError(retractFieldError(prev, "config"), field),
      );
      setFormData((prev) => ({ ...prev, [field]: value }));
    },
    [setValidationErrors, setFormData],
  );

  function seedFrom(record: Serialized<Sandbox>) {
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
          ...(isCreate && workspaceId ? { workspaceId } : {}),
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
    void mutate();
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

  const closeForceDialog = () => setForceDialog(null);

  const { run: handleForceConfirm, pending: isForcing } = useMutation(
    async () => {
      if (!forceDialog) return;
      setForceDialog((prev) => prev && { ...prev, error: null });
      try {
        const outcome = await forceDialog.retry();
        if (outcome.outcome !== "success") {
          // A refused force stays in the open dialog with the backend's
          // message, so it can be read and retried.
          setForceDialog((prev) => prev && { ...prev, error: outcome.message });
          return;
        }
        closeForceDialog();
        await forceDialog.onSuccess();
        toast.success(forceDialog.successMessage);
      } catch (err) {
        // A thrown failure is not a refusal with a backend message, so it keeps
        // the plain toast rather than posing as one inline.
        console.error("Force retry error:", err);
        toast.error("Operation failed");
      }
    },
  );

  if (isLoading || backendsLoading) {
    return <SandboxSettingsSkeleton canConfigure={canConfigure} />;
  }

  // Only a cold failure replaces the form; a failed revalidation keeps the
  // loaded sandbox (or the "none configured" state) on screen.
  if (error && data === undefined) {
    return (
      <EmptyCard
        icon={<Box />}
        title="Couldn't load sandbox"
        description="The sandbox settings could not be read. Try again in a moment."
        action={<Button onClick={() => void mutate()}>Retry</Button>}
      />
    );
  }

  const hasSandbox = !!data;
  // A stored key stays "stored" until the admin opts to replace it; with none
  // stored the field starts empty and offers no stored state.
  const keyState: SandboxKeyState =
    data?.backend === SSH_BACKEND && data.hasCredentials
      ? isReplacingKey
        ? "replacing"
        : "stored"
      : "none";
  const showForm = hasSandbox || isConfiguring || !!draft;
  const noBackends = backends.length === 0;
  const backendsFailed = Boolean(backendsError && !backendsData);

  if (!showForm) {
    // Without the backends list there is no telling a server with none
    // registered from one whose list didn't load, so neither the "add a
    // backend" prompt nor a disabled Configure button is shown.
    if (backendsFailed) {
      return (
        <ListError
          error={backendsError}
          subject="sandbox backends"
          onRetry={() => void mutateBackends()}
        />
      );
    }

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
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        handleSave();
      }}
    >
      <FieldSet className="mb-6">
        <FieldGroup>
          <FormTextField
            label="Name"
            name="sandbox-name"
            placeholder="My sandbox"
            value={formData.name}
            onChange={toFieldChange("name")}
            disabled={isSubmitting}
            error={validationErrors.name}
            autoFocus
          />

          <FormSelectField
            label="Backend"
            name="backend"
            value={formData.backend}
            onValueChange={(value) => setField("backend", value)}
            disabled={isSubmitting || !canConfigure}
            placeholder="Select a backend"
            description={
              <>
                The runtime that hosts the sandbox environment.
                {!canConfigure && " Managed by an organization admin."}
              </>
            }
            error={validationErrors.backend}
          >
            <SelectGroup>
              <SelectLabel>Backend</SelectLabel>
              {backends.map((option) => (
                <SelectItem key={option.backend} value={option.backend}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </FormSelectField>

          {/* Host reachability (ADR-0005) — admin-only, docker backend only. */}
          {canConfigure && isDocker && (
            <SandboxDockerFields
              orgId={orgId}
              formData={formData}
              setConfigField={setConfigField}
              errors={validationErrors}
              disabled={isSubmitting}
            />
          )}

          {/* SSH connection (ADR-0012) — admin-only, ssh backend only. */}
          {canConfigure && isSsh && (
            <SandboxSshFields
              formData={formData}
              setConfigField={setConfigField}
              disabled={isSubmitting}
              keyState={keyState}
              onReplaceKey={() => setIsReplacingKey(true)}
            />
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
                onChange={(rows) => setField("adminEnv", rows)}
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
              onChange={(rows) => setField("userEnv", rows)}
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
            type="button"
            variant="outline"
            onClick={draft.onBack}
            disabled={isSubmitting}
          >
            Back
          </Button>
          <Button type="button" onClick={handleSave} disabled={isSubmitting}>
            {isSubmitting && draft.submitText === "Save"
              ? PENDING_SUBMIT_TEXT.Save
              : draft.submitText}
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <FormFooterButtons
            type="submit"
            submitText="Save"
            pending={isSubmitting}
            submitDisabled={isSubmitting}
            deleteVisible={hasSandbox && canConfigure}
            deleteDisabled={isSubmitting}
            onDelete={openDeleteDialog}
          />

          {!hasSandbox && (
            <Button
              type="button"
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

      <DeleteConfirmDialog noun="sandbox" {...dialogProps} />

      <ConfirmDialog
        open={!!forceDialog}
        onOpenChange={(open) => {
          if (!open && !isForcing) closeForceDialog();
        }}
        title={forceDialog?.title ?? ""}
        description={forceDialog?.message ?? ""}
        confirmLabel={forceDialog?.confirmLabel}
        confirmVariant="destructive"
        onConfirm={handleForceConfirm}
        loading={isForcing}
        error={forceDialog?.error ?? null}
      />
    </form>
  );
}

export { SandboxSettings };
