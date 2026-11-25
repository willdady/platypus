import { useState } from "react";
import type { Serialized, WriteOutcome } from "@/lib/api-write";
import {
  applyDeleteOutcome,
  toastGuidanceOrError,
} from "@/lib/apply-write-outcome";
import { useBackendUrl } from "@/components/auth-provider";
import { useMutation } from "@/hooks/use-mutation";

export type UseDeleteFlowOptions<T, TResult = unknown> = {
  readonly delete: (
    target: T,
    backendUrl: string,
  ) => Promise<WriteOutcome<TResult>>;
  readonly mutate: () => void | Promise<unknown>;
  readonly guidanceOnForbidden?: boolean;
  readonly onSuccess?: (
    target: T,
    data: Serialized<TResult>,
  ) => void | Promise<void>;
};

export type DeleteDialogProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
  readonly loading: boolean;
  readonly error: string | null;
};

export type DeleteFlow<T> = {
  readonly target: T | null;
  readonly open: boolean;
  readonly dialogProps: DeleteDialogProps;
  readonly error: string | null;
  readonly deleting: boolean;
  readonly request: (target: T) => void;
  readonly close: () => void;
  readonly confirm: () => Promise<void>;
};

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

  // why: two clicks in one tick would send the delete twice; `pending` drives the dialog
  const { run: deleteTarget, pending: deleting } = useMutation(
    async (item: T) => {
      if (!backendUrl) return;
      setError(null);
      const outcome = await perform(item, backendUrl);
      await applyDeleteOutcome(outcome, {
        // why: the hook revalidates the list, so a writeAt delete needs no key bookkeeping
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

export const useConfirmFlow = useDeleteFlow;
