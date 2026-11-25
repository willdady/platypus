"use client";

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSWRConfig, type KeyedMutator } from "swr";
import {
  writeEntity,
  type EntityPayload,
  type EntityWithRequestSchemas,
  type Scope,
  type Serialized,
  type WriteOptions,
  type WriteOutcome,
} from "@/lib/api-write";
import {
  applyDeleteOutcome,
  applyWriteOutcome,
  FIX_FORM_ERRORS_MESSAGE,
  toastGuidanceOrError,
  type ApplyWriteOutcomeOptions,
} from "@/lib/apply-write-outcome";
import {
  canSubmitForm,
  retractFieldError,
  type FormErrors,
} from "@/lib/form-errors";
import { useBackendUrl } from "@/components/auth-provider";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useUnsavedChangesGuard } from "@/components/unsaved-changes-guard";
import type { DeleteDialogProps } from "@/hooks/use-delete-flow";
import { deepEqual } from "@/lib/deep-equal";

type Message = string | (() => string);

function resolveMessage(message: Message | undefined): string | undefined {
  return typeof message === "function" ? message() : message;
}

const NO_RETRACTABLE_FIELDS: readonly string[] = [];

type EntityFormCommonOptions<TForm extends object, TResult> = {
  initialData: TForm;
  sideState?: unknown;
  guardUnsavedChanges?: boolean;
  retractableFields?: readonly string[];
  transformField?: (id: string, value: string) => unknown;
  conflictField?: string | null;
  successMessage?: Message;
  failureMessage?: string;
  onSuccess?: (data: Serialized<TResult>) => void | Promise<void>;
  onInvalid?: ApplyWriteOutcomeOptions<TResult>["onInvalid"];
  invalidMessage?: string | null;
  onConflict?: ApplyWriteOutcomeOptions<TResult>["onConflict"];
  onError?: ApplyWriteOutcomeOptions<TResult>["onError"];
};

type EntityFormEntityOptions<TForm extends object, TRecord> = {
  [TEntity in EntityWithRequestSchemas]: {
    entity: TEntity;
    scope: Scope;
    id?: string;
    method?: "PUT" | "PATCH";
    fromRecord?: (record: Serialized<TRecord>) => TForm;
    onSeed?: (record: Serialized<TRecord>) => void;
    buildPayload?: (data: TForm) => EntityPayload<TEntity> | undefined;
    write?: undefined;
  };
}[EntityWithRequestSchemas];

type EntityFormWriteOptions<TForm extends object, TResult> = {
  write: (data: TForm) => Promise<WriteOutcome<TResult>>;
  entity?: never;
  scope?: never;
  id?: never;
  method?: never;
  fromRecord?: never;
  onSeed?: never;
  buildPayload?: never;
};

export type UseEntityFormOptions<
  TForm extends object,
  TResult = unknown,
  TRecord = unknown,
> = EntityFormCommonOptions<TForm, TResult> &
  (
    | EntityFormEntityOptions<TForm, TRecord>
    | EntityFormWriteOptions<TForm, TResult>
  );

export type EntityLoadState<TRecord> = {
  isLoading: boolean;
  error?: unknown;
  data?: TRecord;
};

export type UseEntityFormResult<
  TForm extends object,
  TResult,
  TRecord = unknown,
> = {
  record: Serialized<TRecord> | undefined;
  mutateRecord: KeyedMutator<Serialized<TRecord>>;
  loadState: EntityLoadState<Serialized<TRecord>>;
  formData: TForm;
  setFormData: React.Dispatch<React.SetStateAction<TForm>>;
  seedFormData: (update: React.SetStateAction<TForm>) => void;
  isDirty: boolean;
  validationErrors: FormErrors;
  setValidationErrors: React.Dispatch<React.SetStateAction<FormErrors>>;
  isSubmitting: boolean;
  canSubmit: boolean;
  setField: (id: string, value: unknown) => void;
  handleChange: (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
  toFieldChange: (id: string) => (value: string) => void;
  setNumberField: (id: string, value: string) => void;
  clearErrors: (...ids: string[]) => void;
  submit: (options?: {
    silent?: boolean;
  }) => Promise<Serialized<TResult> | undefined>;
};

function hasOwnWrite<TForm extends object, TResult, TRecord>(
  options: UseEntityFormOptions<TForm, TResult, TRecord>,
): options is EntityFormCommonOptions<TForm, TResult> &
  EntityFormWriteOptions<TForm, TResult> {
  return options.write !== undefined;
}

export function useEntityForm<
  TForm extends object,
  TResult = unknown,
  TRecord = unknown,
>(
  options: UseEntityFormOptions<TForm, TResult, TRecord>,
): UseEntityFormResult<TForm, TResult, TRecord> {
  const {
    initialData,
    entity,
    scope,
    id,
    fromRecord,
    onSeed,
    sideState,
    guardUnsavedChanges = true,
    retractableFields = NO_RETRACTABLE_FIELDS,
    transformField,
    conflictField,
    successMessage,
    failureMessage,
    onSuccess,
    onInvalid,
    invalidMessage,
    onConflict,
    onError,
  } = options;
  const backendUrl = useBackendUrl();
  const { mutate } = useSWRConfig();

  const [formData, setFormData] = useState<TForm>(initialData);
  const [baseline, setBaseline] = useState<TForm>(initialData);
  const [sideBaseline, setSideBaseline] = useState(sideState);
  const [sideSeedPending, setSideSeedPending] = useState(false);
  if (sideSeedPending) {
    setSideSeedPending(false);
    setSideBaseline(sideState);
  }

  const seedFormData = useCallback((update: React.SetStateAction<TForm>) => {
    setFormData(update);
    setBaseline(update);
  }, []);

  const isDirty =
    !deepEqual(formData, baseline) || !deepEqual(sideState, sideBaseline);
  useUnsavedChangesGuard(guardUnsavedChanges && isDirty);

  const reads = !!id && !!fromRecord;
  const {
    data: record,
    error,
    isLoading,
    mutate: mutateRecord,
  } = useScopedSWR<TRecord>(
    `${entity ?? ""}/${id}`,
    reads ? (scope ?? null) : null,
  );

  useResetOnChange(record ? id : undefined, () => {
    if (!record || !fromRecord) return;
    seedFormData(fromRecord(record));
    onSeed?.(record);
    setSideSeedPending(true);
  });
  const [validationErrors, setValidationErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const setField = useCallback((fieldId: string, value: unknown) => {
    setValidationErrors((prev) => retractFieldError(prev, fieldId));
    setFormData((prev) => ({ ...prev, [fieldId]: value }));
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const { id: fieldId, value } = e.target;
      setField(
        fieldId,
        transformField ? transformField(fieldId, value) : value,
      );
    },
    [setField, transformField],
  );

  const toFieldChange = useCallback(
    (fieldId: string) => (value: string) =>
      setField(
        fieldId,
        transformField ? transformField(fieldId, value) : value,
      ),
    [setField, transformField],
  );

  const setNumberField = useCallback(
    (fieldId: string, value: string) => {
      setField(fieldId, value === "" ? undefined : parseInt(value, 10));
    },
    [setField],
  );

  const clearErrors = useCallback((...ids: string[]) => {
    setValidationErrors((prev) =>
      ids.reduce((errors, fieldId) => retractFieldError(errors, fieldId), prev),
    );
  }, []);

  const submit = useCallback(
    async (submitOptions?: {
      silent?: boolean;
    }): Promise<Serialized<TResult> | undefined> => {
      setIsSubmitting(true);
      setValidationErrors({});
      try {
        const result = hasOwnWrite(options)
          ? await options.write(formData)
          : await writeEntity<EntityWithRequestSchemas, TResult>(
              backendUrl,
              options.entity,
              options.scope,
              {
                id: options.id,
                method: options.method ?? "PUT",
                data: options.buildPayload?.(formData),
              } as WriteOptions<EntityWithRequestSchemas>,
            );

        let saved: Serialized<TResult> | undefined;
        await applyWriteOutcome(result, {
          mutate,
          setValidationErrors,
          conflictField,
          onInvalid,
          invalidMessage:
            invalidMessage === null
              ? undefined
              : (invalidMessage ?? FIX_FORM_ERRORS_MESSAGE),
          onConflict,
          onError,
          onSuccess: async (savedData) => {
            saved = savedData;
            setBaseline(formData);
            setSideBaseline(sideState);
            if (!submitOptions?.silent) {
              const message = resolveMessage(successMessage);
              if (message) toast.success(message);
            }
            await onSuccess?.(savedData);
          },
        });
        return saved;
      } catch (error) {
        console.error(error);
        toast.error(failureMessage ?? "Couldn't save");
        return undefined;
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      options,
      backendUrl,
      formData,
      sideState,
      conflictField,
      successMessage,
      failureMessage,
      onSuccess,
      onInvalid,
      invalidMessage,
      onConflict,
      onError,
      mutate,
    ],
  );

  const canSubmit = useMemo(
    () => canSubmitForm(validationErrors, retractableFields),
    [validationErrors, retractableFields],
  );

  return {
    record,
    mutateRecord,
    loadState: { isLoading, error, data: record },
    formData,
    setFormData,
    seedFormData,
    isDirty,
    validationErrors,
    setValidationErrors,
    isSubmitting,
    canSubmit,
    setField,
    handleChange,
    toFieldChange,
    setNumberField,
    clearErrors,
    submit,
  };
}

export type UseEntityDeleteOptions<TResult> = {
  entity: string;
  scope: Scope;
  id?: string;
  successMessage?: Message;
  onSuccess?: (data: Serialized<TResult>) => void | Promise<void>;
  guidanceOnForbidden?: boolean;
  write?: () => Promise<WriteOutcome<TResult>>;
  onError?: (message: string, outcome: WriteOutcome<TResult>) => boolean;
};

export type UseEntityDeleteResult = {
  isDeleteDialogOpen: boolean;
  setIsDeleteDialogOpen: (open: boolean) => void;
  isDeleting: boolean;
  deleteError: string | null;
  dialogProps: DeleteDialogProps;
  openDeleteDialog: () => void;
  handleDelete: () => Promise<void>;
};

export function useEntityDelete<TResult = unknown>({
  entity,
  scope,
  id,
  successMessage,
  onSuccess,
  guidanceOnForbidden = false,
  write,
  onError,
}: UseEntityDeleteOptions<TResult>): UseEntityDeleteResult {
  const backendUrl = useBackendUrl();
  const { mutate } = useSWRConfig();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const openDeleteDialog = useCallback(() => {
    setIsDeleting(false);
    setDeleteError(null);
    setIsDeleteDialogOpen(true);
  }, []);

  const closeDeleteDialog = useCallback(() => {
    setIsDeleteDialogOpen(false);
    setDeleteError(null);
  }, []);

  const handleDelete = useCallback(async () => {
    if (!id) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const result = write
        ? await write()
        : await writeEntity<string, TResult>(backendUrl, entity, scope, {
            id,
          });

      await applyDeleteOutcome(result, {
        mutate,
        onSuccess: async (data) => {
          const message = resolveMessage(successMessage);
          if (message) toast.success(message);
          await onSuccess?.(data);
        },
        onError: (message, outcome) => {
          setIsDeleting(false);
          if (onError?.(message, outcome)) return;
          if (guidanceOnForbidden && outcome.outcome === "forbidden") {
            setIsDeleteDialogOpen(false);
            toastGuidanceOrError(message, outcome);
          } else {
            setDeleteError(message);
          }
        },
      });
    } catch (error) {
      console.error(error);
      setIsDeleting(false);
      setDeleteError("Couldn't delete");
    }
  }, [
    backendUrl,
    entity,
    scope,
    id,
    successMessage,
    onSuccess,
    guidanceOnForbidden,
    write,
    onError,
    mutate,
  ]);

  return {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    deleteError,
    dialogProps: {
      open: isDeleteDialogOpen,
      onOpenChange: (open) => {
        if (!open) closeDeleteDialog();
      },
      onConfirm: () => void handleDelete(),
      loading: isDeleting,
      error: deleteError,
    },
    openDeleteDialog,
    handleDelete,
  };
}
