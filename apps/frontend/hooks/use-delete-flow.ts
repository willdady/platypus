import { useState } from "react";
import type { Serialized, WriteOutcome } from "@/lib/api-write";
import {
  applyDeleteOutcome,
  toastGuidanceOrError,
} from "@/lib/apply-write-outcome";
import { useBackendUrl } from "@/components/auth-provider";
import { useMutation } from "@/hooks/use-mutation";

export type UseDeleteFlowOptions<T, TResult = unknown> = {
  /**
   * Runs the delete for one target and resolves to its outcome. The base URL is
   * passed in so the caller never has to non-null-assert the auth context.
   */
  readonly delete: (
    target: T,
    backendUrl: string,
  ) => Promise<WriteOutcome<TResult>>;
  /** Revalidates the list after a successful delete. */
  readonly mutate: () => void | Promise<unknown>;
  /**
   * Treats a `forbidden` refusal as guidance rather than a failure — an info
   * toast, dialog closed. Only the Shared-resource lists set this (#570): the
   * backend's message already says where the resource is managed, so it isn't
   * an error the user can act on in this dialog. Defaults to false, where a
   * forbidden delete stays inline like every other refusal.
   */
  readonly guidanceOnForbidden?: boolean;
  /**
   * Extra work after a successful delete — e.g. a per-list success toast, or
   * showing a value only the write's response carries (a regenerated token).
   * `data` is that response, so a confirmation that isn't a delete can hand
   * back the secret it minted (#1945).
   */
  readonly onSuccess?: (
    target: T,
    data: Serialized<TResult>,
  ) => void | Promise<void>;
};

/**
 * The five props every delete confirm dialog took by hand (#1944), ready to
 * spread onto `DeleteConfirmDialog` or a plain `ConfirmDialog`. Only the
 * wording is left to the call site.
 *
 * Both hooks wire it the same way: opening is the hook's own affordance
 * (`request` / `openDeleteDialog`), and dismissing the dialog clears whatever
 * refusal it was showing.
 */
export type DeleteDialogProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Fires the delete; the dialog's own prop is void-returning. */
  readonly onConfirm: () => void;
  readonly loading: boolean;
  readonly error: string | null;
};

export type DeleteFlow<T> = {
  /** The item the confirm dialog is open for, or null when closed. */
  readonly target: T | null;
  readonly open: boolean;
  /** `open`, `onOpenChange`, `onConfirm`, `loading` and `error`, ready to spread. */
  readonly dialogProps: DeleteDialogProps;
  /** A refused delete's message, shown inline in the dialog. */
  readonly error: string | null;
  readonly deleting: boolean;
  /** Open the confirm dialog for a target, clearing any stale error. */
  readonly request: (target: T) => void;
  /** Dismiss the dialog without deleting. */
  readonly close: () => void;
  /** Run the open dialog's delete. */
  readonly confirm: () => Promise<void>;
};

/**
 * The delete sequence eight lists used to re-implement (#877): open a confirm
 * dialog for a row, run the write, revalidate on success, and map the outcome
 * through the ADR-0010 seam. Every refusal stays inline so the user can read it
 * and retry, except a Shared-resource `forbidden` on a list that opts into
 * guidance.
 *
 * The same sequence answers a confirmation that isn't a delete — revoking
 * Organization access, declining an invitation, regenerating a secret — where
 * the write's response is what the caller shows next. That name is
 * {@link useConfirmFlow}; this is the one implementation.
 */
export function useDeleteFlow<T, TResult = unknown>({
  delete: perform,
  mutate,
  guidanceOnForbidden = false,
  onSuccess,
}: UseDeleteFlowOptions<T, TResult>): DeleteFlow<T> {
  const backendUrl = useBackendUrl();
  const [target, setTarget] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setTarget(null);
    setError(null);
  };

  const request = (item: T) => {
    setError(null);
    setTarget(item);
  };

  // Ref-guarded so two clicks in the same tick can't send the write twice;
  // `pending` drives the dialog's loading state.
  const { run: deleteTarget, pending: deleting } = useMutation(
    async (item: T) => {
      if (!backendUrl) return;
      setError(null);
      const outcome = await perform(item, backendUrl);
      await applyDeleteOutcome(outcome, {
        // The hook owns list revalidation rather than relying on the write's
        // revalidateKeys, so a `writeAt` delete needs no key bookkeeping.
        mutate: () => {},
        onSuccess: async (data) => {
          await mutate();
          close();
          await onSuccess?.(item, data);
        },
        onError: (message, result) => {
          if (guidanceOnForbidden && result.outcome === "forbidden") {
            close();
            toastGuidanceOrError(message, result);
          } else {
            setError(message);
          }
        },
      });
    },
  );

  const confirm = async () => {
    if (!target) return;
    await deleteTarget(target);
  };

  const open = target !== null;

  return {
    target,
    open,
    dialogProps: {
      open,
      // Closing is the only transition the dialog drives; opening is `request`.
      onOpenChange: (next) => {
        if (!next) close();
      },
      onConfirm: () => void confirm(),
      loading: deleting,
      error,
    },
    error,
    deleting,
    request,
    close,
    confirm,
  };
}

/**
 * `useDeleteFlow` under a name that fits a confirmation whose write isn't a
 * delete: revoking Organization access, declining an invitation, regenerating
 * a secret (#1945). The same function, so the two names cannot drift.
 */
export const useConfirmFlow = useDeleteFlow;
