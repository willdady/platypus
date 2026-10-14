import { useState } from "react";
import { toast } from "sonner";
import { useBackendUrl } from "@/components/auth-provider";
import { writeEntity, type Scope } from "@/lib/api-write";

/**
 * Flips a row's `enabled` from its card menu — the same field the edit form's
 * Enabled switch writes. A refusal is toasted and the list left as it was.
 */
export function useEnabledToggle<
  T extends { readonly id: string; readonly enabled: boolean },
>({
  entity,
  scope,
  mutate,
}: {
  /** Collection entity as the API spells it: "webhooks" / "a2a-endpoints". */
  readonly entity: string;
  readonly scope: Scope;
  readonly mutate: () => void | Promise<unknown>;
}) {
  const backendUrl = useBackendUrl();
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const toggle = async (item: T) => {
    if (!backendUrl) return;
    setTogglingId(item.id);
    try {
      const outcome = await writeEntity(backendUrl, entity, scope, {
        id: item.id,
        data: { enabled: !item.enabled },
      });
      if (outcome.outcome === "success") {
        await mutate();
      } else {
        toast.error(outcome.message);
      }
    } finally {
      setTogglingId(null);
    }
  };

  return { toggle, togglingId };
}
