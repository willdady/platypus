import { TriangleAlert } from "lucide-react";
import type { SelectionSubstitution } from "@/lib/restore-selection";

const MISSING_LABEL: Record<SelectionSubstitution["missing"], string> = {
  agent: "Agent",
  provider: "Provider",
  model: "model",
};

function sentence({ missing, source }: SelectionSubstitution) {
  return source === "chat"
    ? `This chat's ${MISSING_LABEL[missing]} is no longer available, so it's using a different model.`
    : `The ${MISSING_LABEL[missing]} you last used is no longer available, so this chat is using a different one.`;
}

export function SelectionSubstitutedNotice({
  substitution,
}: {
  substitution: SelectionSubstitution | undefined;
}) {
  if (!substitution) return null;

  return (
    <div
      role="status"
      className="mb-2 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning-foreground"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{sentence(substitution)}</span>
    </div>
  );
}
