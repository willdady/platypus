import { TriangleAlert } from "lucide-react";
import { FieldDescription } from "@/components/ui/field";

/**
 * Proactive capability info for a picked model, shown where the picker has no
 * attachments to check against (the Agent form configures a model ahead of
 * any Chat that will use it). Mirrors `FileCompatibilityWarning`'s posture —
 * a heads-up about what this `(Provider, model)` pair can and can't ingest,
 * not a block — but at the general capability level rather than per-file,
 * since there is nothing attached yet to classify (issue #328).
 */
export const ModelCapabilityNotice = ({
  passthroughFileTypes,
}: {
  passthroughFileTypes: string[];
}) => {
  if (passthroughFileTypes.length > 0) return null;

  return (
    <FieldDescription
      role="status"
      className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400"
    >
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
      <span>
        This model doesn&apos;t natively accept file attachments. Non-text files
        sent to this Agent in Chat will be rejected — PDFs and DOCX are still
        readable, sent as extracted text.
      </span>
    </FieldDescription>
  );
};
