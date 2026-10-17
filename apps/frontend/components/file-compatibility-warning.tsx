"use client";

import { FileText, TriangleAlert } from "lucide-react";
import { usePromptInputAttachments } from "./ai-elements/prompt-input";
import { classifyAttachment } from "@/lib/model-config";

/**
 * Proactive, client-side notices (issues #328, #342) about how the currently
 * selected model will handle each attachment:
 *
 * - `reject` → an amber warning: the backend gate would block the turn, because
 *   the file is neither ingested natively nor convertible to text.
 * - `extract` → a neutral heads-up: a PDF/DOCX the model can't read natively is
 *   sent as extracted text, so tables, layout and images are lost.
 *
 * Rendered inside `<PromptInput>` so it can read the live attachment list from
 * context. The backend remains the source of truth; these are only heads-ups.
 */
export const FileCompatibilityWarning = ({
  passthroughFileTypes,
}: {
  passthroughFileTypes: string[];
}) => {
  const attachments = usePromptInputAttachments();

  const classify = (file: { mediaType?: string; filename?: string }) =>
    classifyAttachment(
      { mediaType: file.mediaType, filename: file.filename },
      passthroughFileTypes,
    );

  const names = (files: typeof attachments.files) =>
    files.map((f) => f.filename || "attachment").join(", ");

  const blocked = attachments.files.filter((f) => classify(f) === "reject");
  const extracted = attachments.files.filter((f) => classify(f) === "extract");

  if (blocked.length === 0 && extracted.length === 0) return null;

  return (
    <div className="mb-2 flex flex-col gap-2">
      {blocked.length > 0 && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning-foreground"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            The selected model can&apos;t read{" "}
            <span className="font-medium">{names(blocked)}</span>. Remove{" "}
            {blocked.length === 1 ? "it" : "them"} or switch to a model that
            accepts {blocked.length === 1 ? "it" : "them"}. This is a capability
            limit, not a security filter.
          </span>
        </div>
      )}
      {extracted.length > 0 && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground"
        >
          <FileText className="mt-0.5 size-4 shrink-0" />
          <span>
            The selected model can&apos;t read{" "}
            <span className="font-medium">{names(extracted)}</span> natively, so{" "}
            {extracted.length === 1 ? "it" : "they"} will be sent as extracted
            text — tables, layout and images are lost.
          </span>
        </div>
      )}
    </div>
  );
};
