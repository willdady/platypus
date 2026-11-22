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

/**
 * Downloads one version's content as a file, built in the browser from text
 * the caller already holds. There is no download route: the extension comes
 * from the type (or the language, for code), and a browser that refuses the
 * blob says so rather than failing silently.
 */
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
