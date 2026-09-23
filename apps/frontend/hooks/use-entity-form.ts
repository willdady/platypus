"use client";

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSWRConfig, type KeyedMutator } from "swr";
import { writeEntity, type Scope, type WriteOutcome } from "@/lib/api-write";
import {
  applyDeleteOutcome,
  applyWriteOutcome,
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

/** The success copy a write shows, or a thunk for a message that varies. */
type Message = string | (() => string);

const resolveMessage = (message: Message | undefined): string | undefined =>
  typeof message === "function" ? message() : message;

const NO_RETRACTABLE_FIELDS: readonly string[] = [];

export interface UseEntityFormOptions<
  TForm extends object,
  TResult,
  TRecord = unknown,
> {
  /** The values the form starts with, before any record is loaded. */
  initialData: TForm;
  /**
   * The backend collection path under `scope`, e.g. `"skills"`, or
   * `"users/me/contexts"` with the root scope.
   */
  entity: string;
  /** The Organization/Workspace scope the write targets (ADR-0007). */
  scope: Scope;
  /** Absent when creating. */
  id?: string;
  /**
   * Maps the loaded record onto the form's values. Given with an `id`, the
   * hook reads `${entity}/${id}` under `scope` and seeds `formData` from it
   * once per record id — never again for the same id, so a revalidation that
   * changes the row (a scheduler bumping `nextRunAt`, an OAuth status flip)
   * can't wipe an edit in progress. Read what must track the server from
   * `record` instead.
   */
  fromRecord?: (record: TRecord) => TForm;
  /**
   * Seeds record-derived state the form keeps outside `formData`, on the same
   * once-per-id rule as `fromRecord` (so only when `fromRecord` is given).
   */
  onSeed?: (record: TRecord) => void;
  /**
   * Field ids whose server error an edit can retract — and therefore the only
   * ones that may gate Save. See `canSubmitForm`.
   */
  retractableFields?: readonly string[];
  /**
   * Transforms a string field's value before it lands in `formData` — for a
   * field that normalises as it is typed (e.g. a lowercased skill name).
   */
  transformField?: (id: string, value: string) => unknown;
  /** Maps the form's values onto the request body. Omit for a `write` override. */
  buildPayload?: (data: TForm) => unknown;
  /** Field a `conflict` outcome is keyed to (default `"name"`). */
  conflictField?: string | null;
  /** Success toast copy. Omit when the form shows none, or `onSuccess` owns it. */
  successMessage?: Message;
  /**
   * Toast shown when a write throws outright — a failure the outcome seam
   * never saw (a rejected `onSuccess`, a multipart upload). Without it the
   * rejection is logged rather than surfaced.
   */
  failureMessage?: string;
  /** Called after a successful write, before `submit` resolves. */
  onSuccess?: (data: TResult) => void | Promise<void>;
  /** Overrides the default inline handling of a rejected write. */
  onInvalid?: ApplyWriteOutcomeOptions<TResult>["onInvalid"];
  /**
   * Toast shown when a rejected write maps to a field (default handling only;
   * ignored when `onInvalid` is given). Single-sources the "please fix the
   * errors" copy through `applyWriteOutcome`.
   */
  invalidMessage?: string;
  /** Overrides the default `conflict` handling. */
  onConflict?: ApplyWriteOutcomeOptions<TResult>["onConflict"];
  /** Overrides the default toast for every other failure. */
  onError?: ApplyWriteOutcomeOptions<TResult>["onError"];
  /**
   * Replaces `writeEntity` entirely, for a write that isn't a scoped
   * collection member (e.g. a user-scoped `writeAt`).
   */
  write?: (data: TForm) => Promise<WriteOutcome<TResult>>;
}

/** The record read's state, shaped to spread into `DetailFormState`. */
export interface EntityLoadState<TRecord> {
  isLoading: boolean;
  error?: unknown;
  data?: TRecord;
}

export interface UseEntityFormResult<
  TForm extends object,
  TResult,
  TRecord = unknown,
> {
  /** The loaded record; absent when creating or still loading. */
  record: TRecord | undefined;
  /** Revalidates the record. What arrives does not re-seed `formData`. */
  mutateRecord: KeyedMutator<TRecord>;
  /** Spread into `DetailFormState`. Never loading when creating. */
  loadState: EntityLoadState<TRecord>;
  formData: TForm;
  setFormData: React.Dispatch<React.SetStateAction<TForm>>;
  validationErrors: FormErrors;
  setValidationErrors: React.Dispatch<React.SetStateAction<FormErrors>>;
  isSubmitting: boolean;
  /** Whether the outstanding errors leave the form submittable. */
  canSubmit: boolean;
  /** Sets one field and retracts any error keyed to it or a path under it. */
  setField: (id: string, value: unknown) => void;
  /** A field's `onChange(e)` handler. */
  handleChange: (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
  /** Adapts `FormTextField`'s `onChange(value)` to `handleChange`. */
  toFieldChange: (id: string) => (value: string) => void;
  /** Sets an integer field, `undefined` when cleared. */
  setNumberField: (id: string, value: string) => void;
  /** Sets a float field, `undefined` when cleared. */
  setFloatField: (id: string, value: string) => void;
  /** Retracts one or more fields' errors. */
  clearErrors: (...ids: string[]) => void;
  /**
   * Runs the write lifecycle: clear errors, POST/PUT, apply the outcome, toast
   * and hand off. Resolves with the saved record (or `undefined` on failure).
   * Pass `silent` to skip the success toast (e.g. a save that only yields an
   * id for a follow-up call).
   */
  submit: (options?: { silent?: boolean }) => Promise<TResult | undefined>;
}

/**
 * Owns the scaffold every write-backed form re-implemented by hand: the
 * `formData`/`validationErrors`/`isSubmitting` trio, the field-change
 * adapters that retract a field's server error on edit, and the submit
 * lifecycle (`writeEntity` → `applyWriteOutcome` → success toast → hand-off).
 *
 * The form keeps only what genuinely differs — its fields, its payload shape,
 * and what success and failure mean for it.
 */
export function useEntityForm<
  TForm extends object,
  TResult = unknown,
  TRecord = unknown,
>({
  initialData,
  entity,
  scope,
  id,
  fromRecord,
  onSeed,
  retractableFields = NO_RETRACTABLE_FIELDS,
  transformField,
  buildPayload,
  conflictField,
  successMessage,
  failureMessage,
  onSuccess,
  onInvalid,
  invalidMessage,
  onConflict,
  onError,
  write,
}: UseEntityFormOptions<TForm, TResult, TRecord>): UseEntityFormResult<
  TForm,
  TResult,
  TRecord
> {
  const backendUrl = useBackendUrl();
  const { mutate } = useSWRConfig();
  const [formData, setFormData] = useState<TForm>(initialData);

  const reads = !!id && !!fromRecord;
  const {
    data: record,
    error,
    isLoading,
    mutate: mutateRecord,
  } = useScopedSWR<TRecord>(`${entity}/${id}`, reads ? scope : null);

  // Keyed on the id, not the record: SWR hands back a new object whenever a
  // revalidation changes the row, and keying on that would re-seed over the
  // edit in progress. Gated on the record being loaded so a cold read seeds
  // when it lands rather than into a blank form beforehand (#474).
  useResetOnChange(record ? id : undefined, () => {
    if (!record || !fromRecord) return;
    setFormData(fromRecord(record));
    onSeed?.(record);
  });
  const [validationErrors, setValidationErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const setField = useCallback((fieldId: string, value: unknown) => {
    setValidationErrors((prev) => retractFieldError(prev, fieldId));
    setFormData((prev) => ({ ...prev, [fieldId]: value }) as TForm);
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

  const setFloatField = useCallback(
    (fieldId: string, value: string) => {
      setField(fieldId, value === "" ? undefined : parseFloat(value));
    },
    [setField],
  );

  const clearErrors = useCallback((...ids: string[]) => {
    setValidationErrors((prev) =>
      ids.reduce((errors, fieldId) => retractFieldError(errors, fieldId), prev),
    );
  }, []);

  const submit = useCallback(
    async (options?: { silent?: boolean }): Promise<TResult | undefined> => {
      setIsSubmitting(true);
      setValidationErrors({});
      try {
        const result = write
          ? await write(formData)
          : await writeEntity<TResult>(backendUrl, entity, scope, {
              id,
              data: buildPayload?.(formData),
            });

        let saved: TResult | undefined;
        await applyWriteOutcome(result, {
          mutate,
          setValidationErrors,
          conflictField,
          onInvalid,
          invalidMessage,
          onConflict,
          onError,
          onSuccess: async (savedData) => {
            saved = savedData;
            if (!options?.silent) {
              const message = resolveMessage(successMessage);
              if (message) toast.success(message);
            }
            await onSuccess?.(savedData);
          },
        });
        return saved;
      } catch (error) {
        if (failureMessage) toast.error(failureMessage);
        else console.error(error);
        return undefined;
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      backendUrl,
      entity,
      scope,
      id,
      formData,
      buildPayload,
      conflictField,
      successMessage,
      failureMessage,
      onSuccess,
      onInvalid,
      invalidMessage,
      onConflict,
      onError,
      write,
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
    validationErrors,
    setValidationErrors,
    isSubmitting,
    canSubmit,
    setField,
    handleChange,
    toFieldChange,
    setNumberField,
    setFloatField,
    clearErrors,
    submit,
  };
}

export interface DeleteControls {
  /** Closes the dialog and stops the spinner. */
  close: () => void;
  /** Shows `message` in the dialog, keeping it open. */
  setError: (message: string | null) => void;
  /** Stops the spinner, leaving the dialog open. */
  stopLoading: () => void;
}

export interface UseEntityDeleteOptions<TResult> {
  entity: string;
  scope: Scope;
  /** Absent on a create form; then the delete dialog never opens. */
  id?: string;
  /** Success toast copy, if the form shows one. */
  successMessage?: Message;
  onSuccess?: (data: TResult) => void | Promise<void>;
  /**
   * Overrides the default failure handling — the default shows the message in
   * the dialog and leaves it open. `controls` closes the dialog, sets the
   * dialog error, or stops the spinner without closing.
   */
  onError?: (
    message: string,
    outcome: WriteOutcome<TResult>,
    controls: DeleteControls,
  ) => void;
  /** Replaces `writeEntity`, for a delete that isn't a scoped collection member. */
  write?: () => Promise<WriteOutcome<TResult>>;
}

export interface UseEntityDeleteResult {
  isDeleteDialogOpen: boolean;
  setIsDeleteDialogOpen: (open: boolean) => void;
  isDeleting: boolean;
  deleteError: string | null;
  /** Opens the shared delete dialog. */
  openDeleteDialog: () => void;
  handleDelete: () => Promise<void>;
}

/**
 * Owns the delete half of the entity-form lifecycle: the dialog open/loading/
 * error trio, the DELETE write, and `applyDeleteOutcome`. The dialog itself is
 * `EntityDeleteDialog`, so the confirm copy and destructive styling are
 * single-sourced too.
 */
export function useEntityDelete<TResult = unknown>({
  entity,
  scope,
  id,
  successMessage,
  onSuccess,
  onError,
  write,
}: UseEntityDeleteOptions<TResult>): UseEntityDeleteResult {
  const backendUrl = useBackendUrl();
  const { mutate } = useSWRConfig();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const openDeleteDialog = useCallback(() => {
    setDeleteError(null);
    setIsDeleteDialogOpen(true);
  }, []);

  const handleDelete = useCallback(async () => {
    if (!id) return;
    setIsDeleting(true);
    setDeleteError(null);

    const result = write
      ? await write()
      : await writeEntity<TResult>(backendUrl, entity, scope, { id });

    await applyDeleteOutcome(result, {
      mutate,
      onSuccess: async (data) => {
        const message = resolveMessage(successMessage);
        if (message) toast.success(message);
        await onSuccess?.(data);
      },
      onError: (message, outcome) => {
        if (onError) {
          onError(message, outcome, {
            close: () => {
              setIsDeleteDialogOpen(false);
              setIsDeleting(false);
            },
            setError: setDeleteError,
            stopLoading: () => setIsDeleting(false),
          });
          return;
        }
        setDeleteError(message);
        setIsDeleting(false);
      },
    });
  }, [
    backendUrl,
    entity,
    scope,
    id,
    successMessage,
    onSuccess,
    onError,
    write,
    mutate,
  ]);

  return {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    deleteError,
    openDeleteDialog,
    handleDelete,
  };
}
