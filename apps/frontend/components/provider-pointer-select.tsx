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

const POINTER_FIELD = {
  task: "taskModelProviderId",
  memoryExtraction: "memoryExtractionProviderId",
  embedding: "memoryEmbeddingProviderId",
} as const satisfies Record<ProviderModelRole, string>;

function providersForPointerKind(
  providers: Serialized<Provider>[],
  kind: ProviderModelRole,
): Serialized<Provider>[] {
  return kind === "task"
    ? providers
    : providers.filter((provider) => providerHasModelFor(provider, kind));
}

export type ProviderPointerSelectProps = {
  kind: ProviderModelRole;
  label: string;
  description?: ReactNode;
  noneLabel: string;
  value: string | null;
  onChange: (value: string | null) => void;
  error?: string | null;
  disabled?: boolean;
  // why: Blueprint disables when empty; Workspace keeps None reachable
  disableWhenEmpty?: boolean;
  providers: Serialized<Provider>[];
};

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
