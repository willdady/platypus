import { TriangleAlert } from "lucide-react";
import { FieldDescription } from "@/components/ui/field";

export function ModelCapabilityNotice({
  passthroughFileTypes,
}: {
  passthroughFileTypes: string[];
}) {
  if (passthroughFileTypes.length > 0) return null;

  return (
    <FieldDescription
      role="status"
      className="flex items-start gap-1.5 text-warning-foreground"
    >
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
      <span>
        This model doesn&apos;t natively accept file attachments. Non-text files
        sent to this Agent in Chat will be rejected — PDFs and DOCX are still
        readable, sent as extracted text.
      </span>
    </FieldDescription>
  );
}
