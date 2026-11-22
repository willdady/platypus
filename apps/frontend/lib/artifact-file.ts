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

/** The path this deployment serves stored files on. */
const STORED_FILE_PATH = "/files/";

/**
 * The URL a markdown Artifact may load an image from, or `undefined` when it
 * must not be requested. Inline content and this deployment's own stored files
 * qualify; every other host is refused, and the reader sees a blocked
 * placeholder with the URL as a link instead.
 *
 * The decision is taken on the URL the browser will request, not the string as
 * written: the path is resolved against the backend and percent-decoded the way
 * a server decodes it, so `..` and encoded variants cannot climb out of
 * `/files/` into another backend route. A path still changing after repeated
 * decoding is refused.
 */
export function resolveArtifactImageSource(
  src: string,
  backendUrl?: string,
): string | undefined {
  if (src.startsWith("data:")) return src;
  if (!backendUrl) return undefined;

  let base: URL;
  let url: URL;
  try {
    base = new URL(backendUrl);
    url = new URL(src, base);
  } catch {
    return undefined;
  }
  if (url.origin !== base.origin) return undefined;

  let path = url.pathname;
  for (let pass = 0; pass < 3; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return undefined;
    }
    if (decoded === path) break;
    path = decoded;
  }
  if (path.split("/").includes("..")) return undefined;

  let normalized: URL;
  try {
    normalized = new URL(path, base);
  } catch {
    return undefined;
  }
  if (
    normalized.origin !== base.origin ||
    !normalized.pathname.startsWith(STORED_FILE_PATH)
  ) {
    return undefined;
  }

  normalized.search = url.search;
  normalized.hash = url.hash;
  return normalized.href;
}

/** Whether a markdown Artifact may load an image from `src`. */
export function isAllowedArtifactImageSource(
  src: string,
  backendUrl?: string,
): boolean {
  return resolveArtifactImageSource(src, backendUrl) !== undefined;
}
