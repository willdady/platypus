import { useState } from "react";
import type { WriteOutcome } from "@/lib/api-write";
import {
  applyDeleteOutcome,
  toastGuidanceOrError,
} from "@/lib/apply-write-outcome";
import { useBackendUrl } from "@/components/auth-provider";

export interface UseDeleteFlowOptions<T> {
  /**
   * Runs the delete for one target and resolves to its outcome. The base URL is
   * passed in so the caller never has to non-null-assert the auth context.
   */
  readonly delete: (
    target: T,
    backendUrl: string,
  ) => Promise<WriteOutcome<unknown>>;
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
  /** Extra work after a successful delete — e.g. a per-list success toast. */
  readonly onSuccess?: (target: T) => void;
}

export interface DeleteFlow<T> {
  /** The item the confirm dialog is open for, or null when closed. */
  readonly target: T | null;
  readonly open: boolean;
  /** A refused delete's message, shown inline in the dialog. */
  readonly error: string | null;
  readonly deleting: boolean;
  /** Open the confirm dialog for a target, clearing any stale error. */
  readonly request: (target: T) => void;
  /** Dismiss the dialog without deleting. */
  readonly close: () => void;
  /** Run the open dialog's delete. */
  readonly confirm: () => Promise<void>;
}

/**
 * The delete sequence eight lists used to re-implement (#877): open a confirm
 * dialog for a row, run the write, revalidate on success, and map the outcome
 * through the ADR-0010 seam. Every refusal stays inline so the user can read it
 * and retry, except a Shared-resource `forbidden` on a list that opts into
 * guidance.
 */
export function useDeleteFlow<T>({
  delete: perform,
  mutate,
  guidanceOnForbidden = false,
  onSuccess,
}: UseDeleteFlowOptions<T>): DeleteFlow<T> {
  const backendUrl = useBackendUrl();
  const [target, setTarget] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const close = () => {
    setTarget(null);
    setError(null);
  };

  const request = (item: T) => {
    setError(null);
    setTarget(item);
  };

  const confirm = async () => {
    if (!target || !backendUrl) return;
    setDeleting(true);
    setError(null);
    try {
      const outcome = await perform(target, backendUrl);
      await applyDeleteOutcome(outcome, {
        // The hook owns list revalidation rather than relying on the write's
        // revalidateKeys, so a `writeAt` delete needs no key bookkeeping.
        mutate: () => {},
        onSuccess: async () => {
          await mutate();
          close();
          onSuccess?.(target);
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
    } finally {
      setDeleting(false);
    }
  };

  return {
    target,
    open: target !== null,
    error,
    deleting,
    request,
    close,
    confirm,
  };
}
