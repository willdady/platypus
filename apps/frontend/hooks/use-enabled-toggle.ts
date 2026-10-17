import { useBackendUrl } from "@/components/auth-provider";
import { writeEntity, type Scope } from "@/lib/api-write";
import { useOptimisticRows } from "@/hooks/use-optimistic-rows";

/**
 * Flips a row's `enabled` from its card menu — the same field the edit form's
 * Enabled switch writes. The row flips at once; a refusal is toasted and the
 * row flips back. Render the list through `apply` so the flip shows.
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
  const rows = useOptimisticRows<T>();

  const toggle = async (item: T) => {
    if (!backendUrl) return;
    const enabled = !item.enabled;
    await rows.run(
      item.id,
      { enabled } as Partial<T>,
      () =>
        writeEntity(backendUrl, entity, scope, {
          id: item.id,
          data: { enabled },
        }),
      mutate,
    );
  };

  return { toggle, isToggling: rows.isPending, apply: rows.apply };
}
