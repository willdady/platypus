"use client";

import { useEffect, useRef, useState } from "react";
import type { ArtifactType } from "@platypus/schemas";
import { ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  ARTIFACT_FRAME_SANDBOX,
  artifactFrameBlockedOrigin,
  buildArtifactFrameDocument,
} from "@/lib/artifact-frame";
import { cn } from "@/lib/utils";

/**
 * The only surface HTML and SVG Artifacts run on. The `iframe` is fed by
 * `srcDoc` — the content is never given a URL on the app or API origin — under
 * exactly `sandbox="allow-scripts"` and the policy `buildArtifactFrameDocument`
 * prepends.
 *
 * The frame reports each request its policy blocked; the notice names the site
 * so a reader knows why a page looks broken. Containment does not depend on the
 * notice, so the report is accepted only when it comes from this frame's own
 * `contentWindow` and only its payload is read.
 */
export function ArtifactPreviewFrame({
  type,
  content,
  scriptOrigins,
  className,
}: {
  type: Extract<ArtifactType, "html" | "svg">;
  content: string;
  scriptOrigins: readonly string[];
  className?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const srcDoc = buildArtifactFrameDocument({ type, content, scriptOrigins });
  // A report belongs to the document it came from. A new document starts with
  // no notice, without an effect resetting state on every streamed delta.
  const [report, setReport] = useState<{ doc: string; origins: string[] }>({
    doc: srcDoc,
    origins: [],
  });
  const blocked = report.doc === srcDoc ? report.origins : [];

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow) return;
      const origin = artifactFrameBlockedOrigin(event.data);
      if (!origin) return;
      setReport((current) => {
        const origins = current.doc === srcDoc ? current.origins : [];
        return origins.includes(origin)
          ? { doc: srcDoc, origins }
          : { doc: srcDoc, origins: [...origins, origin] };
      });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [srcDoc]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col gap-3", className)}>
      {blocked.length > 0 && (
        <Alert variant="warning">
          <ShieldAlert />
          <AlertTitle>Blocked content</AlertTitle>
          <AlertDescription>
            This Artifact tried to load something from {blocked.join(", ")},
            which the Artifact frame blocks.
          </AlertDescription>
        </Alert>
      )}
      <iframe
        ref={frame}
        title="Artifact preview"
        sandbox={ARTIFACT_FRAME_SANDBOX}
        srcDoc={srcDoc}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}
