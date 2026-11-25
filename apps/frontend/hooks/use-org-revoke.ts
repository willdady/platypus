"use client";

import { toast } from "sonner";
import { useDeleteFlow, type DeleteFlow } from "@/hooks/use-delete-flow";
import { scopedUrl, writeAt, type Scope } from "@/lib/api-write";
import { joinUrl } from "@/lib/utils";

export type OrgRevokeTarget = {
  path: string;
  tokenCreatedAt?: string | null;
  message: string;
};

export function useOrgRevoke<T>({
  entity,
  scope,
  mutate,
  revokeFor,
}: {
  entity: string;
  scope: Scope;
  mutate: () => void | Promise<unknown>;
  revokeFor: (row: T) => OrgRevokeTarget;
}): DeleteFlow<T> {
  return useDeleteFlow<T>({
    delete: async (row, backendUrl) => {
      const { path, tokenCreatedAt } = revokeFor(row);
      const seen = tokenCreatedAt
        ? `?${new URLSearchParams({
            tokenCreatedAt: new Date(tokenCreatedAt).toISOString(),
          })}`
        : "";
      const outcome = await writeAt(
        joinUrl(scopedUrl(backendUrl, entity, scope), `${path}${seen}`),
        { method: "DELETE" },
      );
      // why: a refused revoke still revalidates, so the list shows the current token
      if (outcome.outcome !== "success") await mutate();
      return outcome;
    },
    mutate,
    onSuccess: (row) => {
      toast.success(revokeFor(row).message);
    },
  });
}
