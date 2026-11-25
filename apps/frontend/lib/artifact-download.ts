import { toast } from "sonner";
import type { Artifact } from "@platypus/schemas";
import { artifactFileExtension, artifactFileName } from "@/lib/artifact-file";

const TYPE_MEDIA: Record<Artifact["type"], string> = {
  markdown: "text/markdown",
  code: "text/plain",
  mermaid: "text/plain",
  html: "text/html",
  svg: "image/svg+xml",
};

// why: no download route; the browser builds the file from content it has
export function downloadArtifactContent(
  artifact: Pick<Artifact, "title" | "type" | "language">,
  content: string,
): void {
  const blob = new Blob([content], { type: TYPE_MEDIA[artifact.type] });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = artifactFileName(
      artifact.title,
      artifact.type,
      artifact.language,
    );
    link.rel = "noreferrer";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch {
    toast.error(
      `Could not download this .${artifactFileExtension(
        artifact.type,
        artifact.language,
      )} file`,
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
