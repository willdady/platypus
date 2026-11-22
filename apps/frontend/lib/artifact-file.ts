import type { ArtifactType } from "@platypus/schemas";

/**
 * The file extension an Artifact downloads as. The type decides it, except for
 * `code`, whose language does; an unknown language falls back to `.txt` rather
 * than guessing a wrong one.
 */
const LANGUAGE_EXTENSIONS: Record<string, string> = {
  bash: "sh",
  c: "c",
  cpp: "cpp",
  cs: "cs",
  csharp: "cs",
  css: "css",
  go: "go",
  html: "html",
  java: "java",
  javascript: "js",
  js: "js",
  json: "json",
  jsx: "jsx",
  md: "md",
  markdown: "md",
  mermaid: "mmd",
  php: "php",
  py: "py",
  python: "py",
  rb: "rb",
  ruby: "rb",
  rs: "rs",
  rust: "rs",
  sh: "sh",
  shell: "sh",
  sql: "sql",
  swift: "swift",
  text: "txt",
  ts: "ts",
  tsx: "tsx",
  txt: "txt",
  typescript: "ts",
  xml: "xml",
  yaml: "yml",
  yml: "yml",
};

const TYPE_LABELS: Record<ArtifactType, string> = {
  markdown: "Markdown",
  code: "Code",
  mermaid: "Mermaid",
  html: "HTML",
  svg: "SVG",
};

/** The human name of an Artifact's type, as the Card and viewer show it. */
export function artifactTypeLabel(type: ArtifactType): string {
  return TYPE_LABELS[type];
}

const TYPE_EXTENSIONS: Record<Exclude<ArtifactType, "code">, string> = {
  markdown: "md",
  mermaid: "mmd",
  html: "html",
  svg: "svg",
};

export function artifactFileExtension(
  type: ArtifactType,
  language?: string | null,
): string {
  if (type !== "code") return TYPE_EXTENSIONS[type];
  const key = language?.trim().toLowerCase();
  return (key && LANGUAGE_EXTENSIONS[key]) || "txt";
}

/** A title safe to hand a browser as a download name, with the type's suffix. */
export function artifactFileName(
  title: string,
  type: ArtifactType,
  language?: string | null,
): string {
  const base = title
    .replace(/[^a-zA-Z0-9._ -]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return `${/[a-zA-Z0-9]/.test(base) ? base : "artifact"}.${artifactFileExtension(type, language)}`;
}

/**
 * Whether a markdown Artifact may load an image from `src`. Only inline
 * content and this deployment's own stored files qualify: any other host is
 * not contacted at all, and the reader sees a blocked placeholder with the URL
 * as a link instead.
 */
export function isAllowedArtifactImageSource(
  src: string,
  backendUrl?: string,
): boolean {
  if (src.startsWith("data:")) return true;
  if (src.startsWith("/files/")) return true;
  if (!backendUrl) return false;

  try {
    const base = new URL(backendUrl);
    const url = new URL(src, base);
    return url.origin === base.origin && url.pathname.startsWith("/files/");
  } catch {
    return false;
  }
}
