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
import {
  retractExactKeys,
  retractFieldError,
  type FormErrors,
} from "@/lib/form-errors";
import {
  buildSchemaValues,
  fieldText,
  fieldsFromSchema,
  type BackendJsonSchema,
  type BackendSchemaSlice,
} from "@/lib/backend-schema-fields";
import { Button } from "@/components/ui/button";
import {
  KeyValueRowsEditor,
  findDuplicateKey,
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
import { SandboxSchemaFields } from "@/components/sandbox-schema-fields";
import {
  DEFAULT_SSH_PORT,
  SandboxSshFields,
  type SandboxKeyState,
} from "@/components/sandbox-ssh-fields";

type SandboxBackend = {
  backend: string;
  name: string;
  configSchema?: BackendJsonSchema;
  credentialsSchema?: BackendJsonSchema;
};

const DOCKER_BACKEND = "docker";

const SSH_BACKEND = "ssh";

export type SandboxFormData = {
  name: string;
  backend: string;
  adminEnv: KeyValueRow[];
  userEnv: KeyValueRow[];
  networks: string[];
  extraHosts: KeyValueRow[];
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshRootDir: string;
  sshHostKey: string;
  sshPrivateKey: string;
  sshPassphrase: string;
  configValues: Record<string, unknown>;
  credentialsValues: Record<string, unknown>;
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
  configValues: {},
  credentialsValues: {},
};

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

type SetConfigField = <K extends SandboxConfigField>(
  field: K,
  value: SandboxFormData[K],
) => void;

export type SandboxConfigFieldsProps = {
  formData: SandboxFormData;
  setConfigField: SetConfigField;
  errors: FormErrors;
  disabled: boolean;
};

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

const SAVED_MESSAGE = "Sandbox configured";
const DELETED_MESSAGE = "Sandbox deleted";

function isForceRetry(outcome: WriteOutcome<unknown>): boolean {
  return (
    outcome.outcome === "error" &&
    outcome.httpStatus === 502 &&
    outcome.message.includes("force=true")
  );
}

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

type ForceRetry = {
  title: string;
  message: string;
  confirmLabel: string;
  successMessage: string;
  retry: () => Promise<WriteOutcome<unknown>>;
  // why: onSuccess runs before the toast, so the list is right when it appears
  onSuccess: () => Promise<void>;
};

function SandboxSettings({
  orgId,
  workspaceId,
  draft,
}: {
  orgId: string;
  workspaceId?: string;
  draft?: FormDraft;
}) {
  const { actor } = useAuth();
  const backendUrl = useBackendUrl();
  const canConfigure = canConfigureSandbox(actor);

  const scope = { orgId, workspaceId };

  // why: the write and its revalidation share one URL, so they cannot drift
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
  const [isReplacingKey, setIsReplacingKey] = useState(false);

  const [forceDialog, setForceDialog] = useState<
    (ForceRetry & { error: string | null }) | null
  >(null);

  function openForceRetry(retry: ForceRetry) {
    setForceDialog({ ...retry, error: null });
  }

  // why: a sandbox is a singleton, so the hook only writes and the read seeds
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

  const setConfigField: SetConfigField = useCallback(
    <K extends SandboxConfigField>(field: K, value: SandboxFormData[K]) => {
      setValidationErrors((prev) =>
        retractFieldError(retractFieldError(prev, "credentials"), "config"),
      );
      setFormData((prev) => ({ ...prev, [field]: value }));
    },
    [setValidationErrors, setFormData],
  );

  // why: retract only this field's key, so a sibling's error stays until edited
  const setSchemaValue = useCallback(
    (slice: BackendSchemaSlice, key: string, value: unknown) => {
      setValidationErrors((prev) =>
        retractExactKeys(prev, [slice, `${slice}.${key}`]),
      );
      setFormData((prev) => ({
        ...prev,
        [slice === "config" ? "configValues" : "credentialsValues"]: {
          ...(slice === "config" ? prev.configValues : prev.credentialsValues),
          [key]: value,
        },
      }));
    },
    [setValidationErrors, setFormData],
  );

  const selectBackend = useCallback(
    (backend: string) => {
      setValidationErrors((prev) =>
        retractFieldError(
          retractFieldError(retractFieldError(prev, "backend"), "config"),
          "credentials",
        ),
      );
      setFormData((prev) => ({
        ...prev,
        backend,
        configValues:
          data && data.backend === backend ? (data.config ?? {}) : {},
        credentialsValues: {},
      }));
    },
    [data, setValidationErrors, setFormData],
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
      sshHost: config.host ?? "",
      sshPort: config.port ? String(config.port) : DEFAULT_SSH_PORT,
      sshUser: config.user ?? "",
      sshRootDir: config.rootDir ?? "",
      sshHostKey: config.hostKey ?? "",
      configValues: record.config ?? {},
    });
  }

  useResetOnChange(data ? data.id : data, () => {
    setIsReplacingKey(false);
    if (data) seedFrom(data);
  });

  useResetOnChange(backends, () => {
    if (!data && backends.length > 0) {
      seedFormData((prev) =>
        prev.backend ? prev : { ...prev, backend: backends[0].backend },
      );
    }
  });

  const isDocker = formData.backend === DOCKER_BACKEND;
  const isSsh = formData.backend === SSH_BACKEND;
  const isGenerated = !isDocker && !isSsh;
  const selectedBackend = backends.find(
    (option) => option.backend === formData.backend,
  );
  const configFields = isGenerated
    ? fieldsFromSchema(selectedBackend?.configSchema, "config")
    : [];
  const credentialFields = isGenerated
    ? fieldsFromSchema(selectedBackend?.credentialsSchema, "credentials")
    : [];
  const backendChanged = !!data && data.backend !== formData.backend;
  const hasStoredCredentials = !!data?.hasCredentials && !backendChanged;

  function writeSandbox(
    options: { force?: boolean } = {},
  ): Promise<WriteOutcome<unknown>> {
    const isCreate = !data;
    const method = isCreate ? "POST" : "PUT";
    const url =
      isCreate || !options.force ? sandboxUrl : `${sandboxUrl}?force=true`;

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
            // why: omit rootDir when blank, or the backend's $HOME default never applies
            ...(formData.sshRootDir.trim()
              ? { rootDir: formData.sshRootDir.trim() }
              : {}),
            // why: omit a blank hostKey, so the backend connects unverified not pinned
            ...(formData.sshHostKey.trim()
              ? { hostKey: formData.sshHostKey.trim() }
              : {}),
          }
        : buildSchemaValues(
            selectedBackend?.configSchema,
            configFields,
            formData.configValues,
          );

    const credentialsEntered = credentialFields.some((field) => {
      const value = formData.credentialsValues[field.key];
      return field.kind === "boolean"
        ? value !== undefined
        : fieldText(value ?? "").trim() !== "";
    });
    const credentialsPayload = isSsh
      ? formData.sshPrivateKey.trim()
        ? {
            credentials: {
              privateKey: formData.sshPrivateKey,
              ...(formData.sshPassphrase
                ? { passphrase: formData.sshPassphrase }
                : {}),
            },
          }
        : {}
      : isDocker
        ? { credentials: {} }
        : isCreate || backendChanged || credentialsEntered
          ? {
              credentials: buildSchemaValues(
                selectedBackend?.credentialsSchema,
                credentialFields,
                formData.credentialsValues,
              ),
            }
          : {};

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
          setForceDialog((prev) => prev && { ...prev, error: outcome.message });
          return;
        }
        closeForceDialog();
        await forceDialog.onSuccess();
        toast.success(forceDialog.successMessage);
      } catch (err) {
        // why: a thrown failure is not a refusal, so it keeps the toast, not inline
        console.error("Force retry error:", err);
        toast.error("Operation failed");
      }
    },
  );

  if (isLoading || backendsLoading) {
    return <SandboxSettingsSkeleton canConfigure={canConfigure} />;
  }

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
            onValueChange={selectBackend}
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

          {canConfigure && isDocker && (
            <SandboxDockerFields
              orgId={orgId}
              formData={formData}
              setConfigField={setConfigField}
              errors={validationErrors}
              disabled={isSubmitting}
            />
          )}

          {canConfigure && isSsh && (
            <SandboxSshFields
              formData={formData}
              setConfigField={setConfigField}
              errors={validationErrors}
              disabled={isSubmitting}
              keyState={keyState}
              onReplaceKey={() => setIsReplacingKey(true)}
            />
          )}

          {canConfigure && isGenerated && selectedBackend?.configSchema && (
            <SandboxSchemaFields
              slice="config"
              schema={selectedBackend.configSchema}
              values={formData.configValues}
              onChange={(key, value) => setSchemaValue("config", key, value)}
              errors={validationErrors}
              disabled={isSubmitting}
            />
          )}

          {canConfigure &&
            isGenerated &&
            selectedBackend?.credentialsSchema && (
              <SandboxSchemaFields
                slice="credentials"
                schema={selectedBackend.credentialsSchema}
                values={formData.credentialsValues}
                onChange={(key, value) =>
                  setSchemaValue("credentials", key, value)
                }
                errors={validationErrors}
                disabled={isSubmitting}
                hasStoredCredentials={hasStoredCredentials}
              />
            )}

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
