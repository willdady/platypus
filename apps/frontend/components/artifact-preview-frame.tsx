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
  // why: a report belongs to its document, so key it by srcDoc instead of resetting in an effect
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
