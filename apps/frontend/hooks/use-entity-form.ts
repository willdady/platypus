"use client";

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSWRConfig, type KeyedMutator } from "swr";
import {
  writeEntity,
  type Scope,
  type Serialized,
  type WriteOutcome,
} from "@/lib/api-write";
import {
  applyDeleteOutcome,
  applyWriteOutcome,
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
import { deepEqual } from "@/lib/deep-equal";

/** The success copy a write shows, or a thunk for a message that varies. */
type Message = string | (() => string);

function resolveMessage(message: Message | undefined): string | undefined {
  return typeof message === "function" ? message() : message;
}

const NO_RETRACTABLE_FIELDS: readonly string[] = [];

export type UseEntityFormOptions<
  TForm extends object,
  TResult,
  TRecord = unknown,
> = {
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
  fromRecord?: (record: Serialized<TRecord>) => TForm;
  /**
   * Seeds record-derived state the form keeps outside `formData`, on the same
   * once-per-id rule as `fromRecord` (so only when `fromRecord` is given).
   */
  onSeed?: (record: Serialized<TRecord>) => void;
  /**
   * The edits a form keeps outside `formData` (a selection, raw JSON text),
   * compared like `formData` for `isDirty`. Its clean value is the first
   * render's, then whatever it holds once `onSeed` has run or a save lands.
   */
  sideState?: unknown;
  /**
   * False opts out of `UnsavedChangesProvider`, for a small dialog or inline
   * action rather than an entity form; `isDirty` is still reported.
   */
  guardUnsavedChanges?: boolean;
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
   * never saw (a rejected `onSuccess`, a multipart upload). Defaults to
   * "Couldn't save".
   */
  failureMessage?: string;
  /** Called after a successful write, before `submit` resolves. */
  onSuccess?: (data: Serialized<TResult>) => void | Promise<void>;
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
};

/** The record read's state, shaped to spread into `DetailFormState`. */
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
  /** The loaded record; absent when creating or still loading. */
  record: Serialized<TRecord> | undefined;
  /** Revalidates the record. What arrives does not re-seed `formData`. */
  mutateRecord: KeyedMutator<Serialized<TRecord>>;
  /** Spread into `DetailFormState`. Never loading when creating. */
  loadState: EntityLoadState<Serialized<TRecord>>;
  formData: TForm;
  setFormData: React.Dispatch<React.SetStateAction<TForm>>;
  /**
   * Sets the values and makes them the clean baseline — for a change the form
   * makes itself (a default once options load, a reset after save), not one
   * the user typed.
   */
  seedFormData: (update: React.SetStateAction<TForm>) => void;
  /**
   * Whether `formData` differs from the values last seeded or saved. While
   * true, `UnsavedChangesProvider` guards link clicks and unload.
   */
  isDirty: boolean;
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
  submit: (options?: {
    silent?: boolean;
  }) => Promise<Serialized<TResult> | undefined>;
};

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
  sideState,
  guardUnsavedChanges = true,
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
  const [baseline, setBaseline] = useState<TForm>(initialData);
  const [sideBaseline, setSideBaseline] = useState(sideState);
  // Set by a seed; the render after it, which holds what `onSeed` set, takes
  // `sideState` as the new clean value.
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
  } = useScopedSWR<TRecord>(`${entity}/${id}`, reads ? scope : null);

  // Keyed on the id, not the record: SWR hands back a new object whenever a
  // revalidation changes the row, and keying on that would re-seed over the
  // edit in progress. Gated on the record being loaded so a cold read seeds
  // when it lands rather than into a blank form beforehand (#474).
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
    async (options?: {
      silent?: boolean;
    }): Promise<Serialized<TResult> | undefined> => {
      setIsSubmitting(true);
      setValidationErrors({});
      try {
        const result = write
          ? await write(formData)
          : await writeEntity<TResult>(backendUrl, entity, scope, {
              id,
              data: buildPayload?.(formData),
            });

        let saved: Serialized<TResult> | undefined;
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
            // Clean before any hand-off, so a post-save redirect isn't held.
            setBaseline(formData);
            setSideBaseline(sideState);
            if (!options?.silent) {
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
      backendUrl,
      entity,
      scope,
      id,
      formData,
      sideState,
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
    setFloatField,
    clearErrors,
    submit,
  };
}

export type UseEntityDeleteOptions<TResult> = {
  entity: string;
  scope: Scope;
  /** Absent on a create form; then the delete dialog never opens. */
  id?: string;
  /** Success toast copy, if the form shows one. */
  successMessage?: Message;
  onSuccess?: (data: Serialized<TResult>) => void | Promise<void>;
  /**
   * Treats a `forbidden` refusal as guidance rather than a failure — an info
   * toast, dialog closed. For Shared-resource deletes only (#570): the
   * backend's message says where the resource is managed, which is nothing
   * the user can act on in this dialog. Defaults to false, where a forbidden
   * delete stays inline like every other refusal. Same rule as
   * `useDeleteFlow`'s option of the same name.
   */
  guidanceOnForbidden?: boolean;
  /** Replaces `writeEntity`, for a delete that isn't a scoped collection member. */
  write?: () => Promise<WriteOutcome<TResult>>;
  /**
   * Sees a refused delete first, for a refusal the form answers itself (e.g.
   * a retry it offers in its own dialog). Return true when handled; otherwise
   * the default handling (inline, or `guidanceOnForbidden`) still applies.
   */
  onError?: (message: string, outcome: WriteOutcome<TResult>) => boolean;
};

export type UseEntityDeleteResult = {
  isDeleteDialogOpen: boolean;
  setIsDeleteDialogOpen: (open: boolean) => void;
  isDeleting: boolean;
  deleteError: string | null;
  /** Opens the shared delete dialog. */
  openDeleteDialog: () => void;
  handleDelete: () => Promise<void>;
};

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
  guidanceOnForbidden = false,
  write,
  onError,
}: UseEntityDeleteOptions<TResult>): UseEntityDeleteResult {
  const backendUrl = useBackendUrl();
  const { mutate } = useSWRConfig();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // A successful delete leaves `isDeleting` set, as most forms navigate away
  // on it; a form that stays mounted reopens the dialog idle.
  const openDeleteDialog = useCallback(() => {
    setIsDeleting(false);
    setDeleteError(null);
    setIsDeleteDialogOpen(true);
  }, []);

  const handleDelete = useCallback(async () => {
    if (!id) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
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
    openDeleteDialog,
    handleDelete,
  };
}
