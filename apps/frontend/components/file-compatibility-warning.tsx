"use client";

import { TriangleAlert } from "lucide-react";
import { usePromptInputAttachments } from "./ai-elements/prompt-input";
import { classifyAttachment } from "@/lib/model-config";

/**
 * Proactive, client-side warning (issue #328) shown when an attached file can't
 * be read by the currently-selected model — it is neither ingested natively nor
 * inlinable as text, so the backend gate would reject the turn. Rendered inside
 * `<PromptInput>` so it can read the live attachment list from context. The
 * backend remains the source of truth; this is only a heads-up.
 */
export const FileCompatibilityWarning = ({
  passthroughFileTypes,
}: {
  passthroughFileTypes: string[];
}) => {
  const attachments = usePromptInputAttachments();

  const blocked = attachments.files.filter(
    (file) =>
      classifyAttachment(
        { mediaType: file.mediaType, filename: file.filename },
        passthroughFileTypes,
      ) === "reject",
  );

  if (blocked.length === 0) return null;

  const names = blocked.map((f) => f.filename || "attachment").join(", ");

  return (
    <div
      role="status"
      className="mb-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>
        The selected model can&apos;t read{" "}
        <span className="font-medium">{names}</span>. Remove{" "}
        {blocked.length === 1 ? "it" : "them"} or switch to a model that accepts{" "}
        {blocked.length === 1 ? "it" : "them"}. This is a capability limit, not
        a security filter.
      </span>
    </div>
  );
};
