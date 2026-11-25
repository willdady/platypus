import { useBackendUrl } from "@/components/auth-provider";
import { writeEntity, type Scope } from "@/lib/api-write";
import { useOptimisticRows } from "@/hooks/use-optimistic-rows";

export function useEnabledToggle<
  T extends { readonly id: string; readonly enabled: boolean },
>({
  entity,
  scope,
  mutate,
}: {
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
          // why: every entity this hook serves updates partially
          method: "PATCH",
          data: { enabled },
        }),
      mutate,
    );
  };

  return { toggle, isToggling: rows.isPending, apply: rows.apply };
}
