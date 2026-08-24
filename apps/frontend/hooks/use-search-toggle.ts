import { useState } from "react";
import { useResetOnChange } from "./use-reset-on-change";
import type { ResolvedModel } from "@/lib/resolve-model";

/**
 * The Chat search toggle, kept to one invariant (#624): search may not be on
 * when the resolved selection cannot search. Keyed on `canSearch` itself —
 * not on the Agent/Provider/model identity — so switching between two
 * selections that can both search leaves the toggle exactly as the User set
 * it. The invariant only ever forces the toggle off, never on, and does
 * nothing while resolution is unknown (`resolvedModel === null`), so a brief
 * loading/revalidation gap can't silently discard a chosen setting.
 */
export function useSearchToggle(resolvedModel: ResolvedModel | null) {
  const [search, setSearch] = useState(false);

  useResetOnChange(
    resolvedModel === null ? null : resolvedModel.canSearch,
    () => {
      if (resolvedModel && !resolvedModel.canSearch) setSearch(false);
    },
  );

  return [search, setSearch] as const;
}
