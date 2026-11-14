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

/** The success copy a write shows, or a thunk for a message that varies. */
type Message = string | (() => string);

function resolveMessage(message: Message | undefined): string | undefined {
  return typeof message === "function" ? message() : message;
}

const NO_RETRACTABLE_FIELDS: readonly string[] = [];

/** The options every entity form takes, whatever its write target. */
type EntityFormCommonOptions<TForm extends object, TResult> = {
  /** The values the form starts with, before any record is loaded. */
  initialData: TForm;
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
   * ignored when `onInvalid` is given). Defaults to `FIX_FORM_ERRORS_MESSAGE`,
   * because a page-level form can have its invalid field scrolled off screen.
   * A dialog or inline action passes `null`: its field errors are already in
   * view, so a toast would only repeat them.
   */
  invalidMessage?: string | null;
  /** Overrides the default `conflict` handling. */
  onConflict?: ApplyWriteOutcomeOptions<TResult>["onConflict"];
  /** Overrides the default toast for every other failure. */
  onError?: ApplyWriteOutcomeOptions<TResult>["onError"];
};

/**
 * The options a form that names the entity it writes takes: the hook reads the
 * record being edited and sends the payload to that entity's collection. The
 * entity's literal name selects the shared request schema `buildPayload` is
 * checked against — a mapped union rather than a type parameter, because a
 * type parameter could not be inferred alongside the explicitly-given `TForm`.
 */
type EntityFormEntityOptions<TForm extends object, TRecord> = {
  [TEntity in EntityWithRequestSchemas]: {
    /**
     * The backend collection path under `scope`, e.g. `"skills"`, or
     * `"users/me/contexts"` with the root scope.
     */
    entity: TEntity;
    /** The Organization/Workspace scope the write targets (ADR-0007). */
    scope: Scope;
    /** Absent when creating. */
    id?: string;
    /** The update verb; `PUT` (the default) replaces, `PATCH` sends a partial. */
    method?: "PUT" | "PATCH";
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
     * Maps the form's values onto the request body. Its return type is checked
     * against the entity's shared request schema, so a body the backend would
     * refuse is a compile error here rather than a 400 at run time.
     * `undefined` sends no body — for a form whose fields have not reported
     * what to send yet, which cannot be submitted until they have.
     */
    buildPayload?: (data: TForm) => EntityPayload<TEntity> | undefined;
    /** A form that brings its own write names no entity. */
    write?: undefined;
  };
}[EntityWithRequestSchemas];

/**
 * The options a form that brings its own write takes: it reads no record and
 * targets no collection, so it supplies neither an entity nor a scope.
 */
type EntityFormWriteOptions<TForm extends object, TResult> = {
  /**
   * Replaces the entity write entirely, for a write that isn't a scoped
   * collection member (e.g. an auth-client call or a user-scoped `writeAt`).
   */
  write: (data: TForm) => Promise<WriteOutcome<TResult>>;
  entity?: never;
  scope?: never;
  id?: never;
  method?: never;
  fromRecord?: never;
  onSeed?: never;
  buildPayload?: never;
};

/**
 * The options `useEntityForm` takes: an entity to write through, or a write of
 * the form's own — never both, and never neither.
 */
export type UseEntityFormOptions<
  TForm extends object,
  TResult = unknown,
  TRecord = unknown,
> = EntityFormCommonOptions<TForm, TResult> &
  (
    | EntityFormEntityOptions<TForm, TRecord>
    | EntityFormWriteOptions<TForm, TResult>
  );

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
 * Whether a form brings its own write. Destructuring would widen the union
 * away, so the hook narrows its options through this predicate to reach the
 * entity target.
 */
function hasOwnWrite<TForm extends object, TResult, TRecord>(
  options: UseEntityFormOptions<TForm, TResult, TRecord>,
): options is EntityFormCommonOptions<TForm, TResult> &
  EntityFormWriteOptions<TForm, TResult> {
  return options.write !== undefined;
}

/**
 * Owns the scaffold every write-backed form re-implemented by hand: the
 * `formData`/`validationErrors`/`isSubmitting` trio, the field-change
 * adapters that retract a field's server error on edit, and the submit
 * lifecycle (`writeEntity` → `applyWriteOutcome` → success toast → hand-off).
 *
 * The form keeps only what genuinely differs — its fields, its payload shape,
 * and what success and failure mean for it. A form names the entity it writes
 * (so the payload is checked against that entity's request schema), or brings
 * its own `write` when the request isn't a scoped collection member — never
 * both.
 */
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
  } = useScopedSWR<TRecord>(
    `${entity ?? ""}/${id}`,
    reads ? (scope ?? null) : null,
  );

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
        // A form with its own write saves through it; one that names an entity
        // gets the default write, whose body its `buildPayload` already had
        // checked against that entity's request schema. `WriteOptions` splits
        // on `id` to select the create or update body but stays opaque for the
        // options union, so the option set is asserted into the branch `id`
        // selects.
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
            // Clean before any hand-off, so a post-save redirect isn't held.
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
  /** `open`, `onOpenChange`, `onConfirm`, `loading` and `error`, ready to spread. */
  dialogProps: DeleteDialogProps;
  /** Opens the shared delete dialog. */
  openDeleteDialog: () => void;
  handleDelete: () => Promise<void>;
};

/**
 * Owns the delete half of the entity-form lifecycle: the dialog open/loading/
 * error trio, the DELETE write, and `applyDeleteOutcome`. The dialog itself is
 * `DeleteConfirmDialog`, so the confirm copy and destructive styling are
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
      // Closing is the only transition the dialog drives; opening is
      // `openDeleteDialog`. A dismissed refusal goes with the dialog, as it
      // does in `useDeleteFlow`.
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
