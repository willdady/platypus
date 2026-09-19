import { toast } from "sonner";
import type { WriteOutcome } from "./api-write";

/**
 * The default copy for a rejected write that mapped to fields the form can
 * show, so the "please fix the errors" toast is written once rather than
 * reworded per form.
 */
export const FIX_FORM_ERRORS_MESSAGE = "Please fix the errors in the form";

export interface ApplyWriteOutcomeOptions<TResult> {
  /** Revalidates one SWR key — usually `useSWRConfig()`'s `mutate`. */
  readonly mutate: (key: string) => void;
  readonly setValidationErrors: (errors: Record<string, string>) => void;
  /**
   * Field a `conflict` outcome's message is keyed to (default `"name"`).
   * Pass `null` when there's no field to key it to (e.g. a delete dialog) —
   * `conflict` then routes through `onError` like every other failure.
   * Ignored if `onConflict` is given.
   */
  readonly conflictField?: string | null;
  /** Whatever genuinely differs per caller: navigation, dialog close, side-effects. */
  readonly onSuccess?: (data: TResult) => void | Promise<void>;
  /** Overrides the default `setValidationErrors` + toast-if-no-field-errors handling. */
  readonly onInvalid?: (
    fieldErrors: Record<string, string>,
    message: string,
  ) => void;
  /** Overrides the default `setValidationErrors({ [conflictField]: message })`. */
  readonly onConflict?: (message: string) => void;
  /**
   * Toast shown by the default `invalid` handling when the rejection mapped to
   * at least one field (so the copy is single-sourced). Ignored if `onInvalid`
   * is given; when omitted, a mapped rejection stays inline-only.
   */
  readonly invalidMessage?: string;
  /**
   * Covers `forbidden`, `notFound`, and `error`, plus an `invalid` outcome
   * with no field errors to show. Defaults to `toast.error`. Receives the
   * outcome so a caller can special-case `forbidden` (e.g. a Shared
   * resource's lock refusal reads as guidance, not a failure — #570).
   */
  readonly onError?: (message: string, outcome: WriteOutcome<TResult>) => void;
}

/**
 * The near-byte-identical `switch (result.outcome)` handler duplicated
 * across the write-backed forms (#598): success revalidates and hands off to
 * the caller, invalid/conflict route to field errors, and every other
 * failure surfaces a message. Callers keep only what genuinely differs.
 */
export async function applyWriteOutcome<TResult>(
  result: WriteOutcome<TResult>,
  options: ApplyWriteOutcomeOptions<TResult>,
): Promise<void> {
  const {
    mutate,
    setValidationErrors,
    conflictField = "name",
    onSuccess,
    onInvalid,
    onConflict,
    invalidMessage,
    onError = (message) => toast.error(message),
  } = options;

  switch (result.outcome) {
    case "success":
      result.revalidateKeys.forEach((key) => mutate(key));
      await onSuccess?.(result.data);
      return;
    case "invalid":
      if (onInvalid) {
        onInvalid(result.fieldErrors, result.message);
        return;
      }
      setValidationErrors(result.fieldErrors);
      if (Object.keys(result.fieldErrors).length === 0) {
        onError(result.message, result);
      } else if (invalidMessage) {
        toast.error(invalidMessage);
      }
      return;
    case "conflict":
      if (onConflict) {
        onConflict(result.message);
        return;
      }
      if (conflictField === null) {
        onError(result.message, result);
        return;
      }
      setValidationErrors({ [conflictField]: result.message });
      return;
    case "forbidden":
    case "notFound":
    case "error":
      onError(result.message, result);
      return;
  }
}

export interface ApplyDeleteOutcomeOptions<TResult> {
  /** Revalidates one SWR key — usually `useSWRConfig()`'s `mutate`. */
  readonly mutate: (key: string) => void;
  readonly onSuccess?: (data: TResult) => void | Promise<void>;
  /** See `ApplyWriteOutcomeOptions.onError` — covers every delete failure. */
  readonly onError?: (message: string, outcome: WriteOutcome<TResult>) => void;
}

/**
 * `applyWriteOutcome` for a delete: there's no field to validate or key a
 * conflict to (e.g. a 409 "still referenced" delete refusal), so every
 * failure — `conflict` included — surfaces through `onError` alongside
 * `forbidden`/`notFound`/`error`.
 */
export async function applyDeleteOutcome<TResult>(
  result: WriteOutcome<TResult>,
  options: ApplyDeleteOutcomeOptions<TResult>,
): Promise<void> {
  return applyWriteOutcome(result, {
    ...options,
    setValidationErrors: () => {},
    conflictField: null,
  });
}

/**
 * The toast.info-for-forbidden, toast.error-otherwise split repeated across
 * every form whose Shared-resource lock refusal reads as guidance, not a
 * failure — the backend's message already says where the resource is
 * actually managed (#570).
 */
export function toastGuidanceOrError(
  message: string,
  outcome: WriteOutcome<unknown>,
): void {
  if (outcome.outcome === "forbidden") {
    toast.info(message);
  } else {
    toast.error(message);
  }
}
