"use client";

import { toast } from "sonner";
import { useDeleteFlow, type DeleteFlow } from "@/hooks/use-delete-flow";
import { scopedUrl, writeAt } from "@/lib/api-write";
import { joinUrl } from "@/lib/utils";

/** What revoking a row deletes, and what to say once it has. */
export type OrgRevokeTarget = {
  /** The path under the Organization's route, before any query. */
  path: string;
  /** The token's creation time as the row showed it, when revoking a token. */
  tokenCreatedAt?: string | null;
  /** The success toast: "Token revoked", "Endpoint revoked". */
  message: string;
};

/**
 * The confirmed revoke the two Org token-oversight tables run (#1851): the
 * `DELETE` through the Organization route, the `tokenCreatedAt` guard
 * serialised one way, the revalidation, and the dialog's pending and
 * inline-error state. The guard names the token the row showed, so one the
 * Owner regenerated since the list loaded is refused rather than revoked
 * unseen.
 */
export function useOrgRevoke<T>({
  entity,
  orgId,
  mutate,
  target,
}: {
  /** The scoped route the rows come from: "a2a/endpoints", "inbound-triggers". */
  entity: string;
  orgId: string;
  mutate: () => void | Promise<unknown>;
  /** Reads the path, guard and success message out of the requested row. */
  target: (row: T) => OrgRevokeTarget;
}): DeleteFlow<T> {
  return useDeleteFlow<T>({
    delete: async (row, backendUrl) => {
      const { path, tokenCreatedAt } = target(row);
      const seen = tokenCreatedAt
        ? `?${new URLSearchParams({
            tokenCreatedAt: new Date(tokenCreatedAt).toISOString(),
          })}`
        : "";
      const outcome = await writeAt(
        joinUrl(scopedUrl(backendUrl, entity, { orgId }), `${path}${seen}`),
        { method: "DELETE" },
      );
      // After a failure too: a token replaced since the list loaded is
      // refused, and the list should show the one that is current now.
      if (outcome.outcome !== "success") await mutate();
      return outcome;
    },
    mutate,
    onSuccess: (row) => toast.success(target(row).message),
  });
}
