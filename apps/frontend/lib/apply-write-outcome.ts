import { toast } from "sonner";
import type { Serialized, WriteOutcome } from "./api-write";

export const FIX_FORM_ERRORS_MESSAGE = "Please fix the errors in the form";

export type ApplyWriteOutcomeOptions<TResult> = {
  readonly mutate: (key: string) => unknown;
  readonly setValidationErrors: (errors: Record<string, string>) => void;
  readonly conflictField?: string | null;
  readonly onSuccess?: (data: Serialized<TResult>) => void | Promise<void>;
  readonly onInvalid?: (
    fieldErrors: Record<string, string>,
    message: string,
  ) => void;
  readonly onConflict?: (message: string) => void;
  readonly invalidMessage?: string;
  readonly onError?: (message: string, outcome: WriteOutcome<TResult>) => void;
};

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

export type ApplyDeleteOutcomeOptions<TResult> = {
  readonly mutate: (key: string) => unknown;
  readonly onSuccess?: (data: Serialized<TResult>) => void | Promise<void>;
  readonly onError?: (message: string, outcome: WriteOutcome<TResult>) => void;
};

export async function applyDeleteOutcome<TResult>(
  result: WriteOutcome<TResult>,
  options: ApplyDeleteOutcomeOptions<TResult>,
): Promise<void> {
  return applyWriteOutcome(result, {
    ...options,
    setValidationErrors: () => {},
    conflictField: null,
    onInvalid: (_fieldErrors, message) => {
      if (options.onError) options.onError(message, result);
      else toast.error(message);
    },
  });
}

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

export function toOutcome(
  error: { message?: string } | null,
  fallback: string,
): WriteOutcome<unknown> {
  return error
    ? { outcome: "error", message: error.message || fallback }
    : { outcome: "success", data: {}, revalidateKeys: [] };
}
