import type { ReactNode } from "react";
import type { Provider } from "@platypus/schemas";
import { FormSelectField } from "@/components/form-select-field";
import { SelectItem } from "@/components/ui/select";
import type { Serialized } from "@/lib/api-write";
import {
  providerHasModelFor,
  providerModelLabel,
  type ProviderModelRole,
} from "@/lib/provider-model-label";

/** The field each provider pointer is stored in. */
const POINTER_FIELD = {
  task: "taskModelProviderId",
  memoryExtraction: "memoryExtractionProviderId",
  embedding: "memoryEmbeddingProviderId",
} as const satisfies Record<ProviderModelRole, string>;

/**
 * The providers a pointer of `kind` may offer: every provider for the task
 * model, and only those declaring the role's model otherwise.
 */
function providersForPointerKind(
  providers: Serialized<Provider>[],
  kind: ProviderModelRole,
): Serialized<Provider>[] {
  return kind === "task"
    ? providers
    : providers.filter((provider) => providerHasModelFor(provider, kind));
}

export type ProviderPointerSelectProps = {
  /** What the pointer is for; picks the eligible providers and the field. */
  kind: ProviderModelRole;
  label: string;
  description?: ReactNode;
  /** The option that clears the pointer. */
  noneLabel: string;
  value: string | null;
  onChange: (value: string | null) => void;
  error?: string | null;
  disabled?: boolean;
  /**
   * Disable the control when no provider qualifies, rather than offering the
   * none option alone. The Blueprint form uses this; the Workspace form keeps
   * its selects usable so the none option stays reachable.
   */
  disableWhenEmpty?: boolean;
  providers: Serialized<Provider>[];
};

/**
 * A Workspace/Blueprint provider pointer: one provider, or none. Owns the
 * kind's eligible set, its `name (model id)` labels, and the `"none"` ↔ `null`
 * mapping, so neither form spells any of them out per field.
 */
export function ProviderPointerSelect({
  kind,
  label,
  description,
  noneLabel,
  value,
  onChange,
  error,
  disabled,
  disableWhenEmpty,
  providers,
}: ProviderPointerSelectProps) {
  const eligible = providersForPointerKind(providers, kind);
  return (
    <FormSelectField
      label={label}
      name={POINTER_FIELD[kind]}
      value={value || "none"}
      onValueChange={(next) => onChange(next === "none" ? null : next)}
      error={error}
      description={description}
      placeholder="Select a provider"
      disabled={disabled || (disableWhenEmpty && eligible.length === 0)}
    >
      <SelectItem value="none">{noneLabel}</SelectItem>
      {eligible.map((provider) => (
        <SelectItem key={provider.id} value={provider.id}>
          {providerModelLabel(provider, kind)}
        </SelectItem>
      ))}
    </FormSelectField>
  );
}
