import { TriangleAlert } from "lucide-react";
import type { SelectionSubstitution } from "@/lib/restore-selection";

const sentence = ({ missing, source }: SelectionSubstitution) =>
  source === "chat"
    ? `This chat's ${missing} is no longer available, so it's using a different model.`
    : `The ${missing} you last used is no longer available, so this chat is using a different one.`;

/**
 * Says that the Chat opened against something other than what it asked for —
 * its Agent, Provider or model was deleted — so the user is not left talking
 * to a different model without knowing it. The picker beside it shows what
 * took its place, and picking anything there clears the notice.
 */
export const SelectionSubstitutedNotice = ({
  substitution,
}: {
  substitution: SelectionSubstitution | undefined;
}) => {
  if (!substitution) return null;

  return (
    <div
      role="status"
      className="mb-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{sentence(substitution)}</span>
    </div>
  );
};
