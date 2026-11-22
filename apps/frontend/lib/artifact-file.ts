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
  const name = /[a-zA-Z0-9]/.test(base) ? base : "artifact";
  const extension = artifactFileExtension(type, language);
  // A title that already ends in the suffix keeps the one it has: an uploaded
  // file's title is its own file name, extension included.
  return name.toLowerCase().endsWith(`.${extension}`)
    ? name
    : `${name}.${extension}`;
}

/** The path this deployment serves stored files on. */
const STORED_FILE_PATH = "/files/";

/** The Artifact an uploaded file becomes: its title, type and code language. */
export type ArtifactUpload = {
  title: string;
  type: ArtifactType;
  language?: string;
};

/**
 * The types an upload's extension selects outright, inverted from the
 * download extensions so the two cannot name different types.
 */
const UPLOAD_TYPES = Object.fromEntries(
  Object.entries(TYPE_EXTENSIONS).map(([type, extension]) => [extension, type]),
) as Record<string, ArtifactType>;

/**
 * What an uploaded file becomes: the title is the file's own name, the type is
 * read from its extension, and a file of any other type is Code in that
 * extension's language. A file with no extension is Code with no language.
 */
export function artifactUploadFromFileName(fileName: string): ArtifactUpload {
  const dot = fileName.lastIndexOf(".");
  const extension =
    dot > 0 && dot < fileName.length - 1
      ? fileName.slice(dot + 1).toLowerCase()
      : undefined;

  if (extension === undefined) return { title: fileName, type: "code" };
  const type = UPLOAD_TYPES[extension];
  if (type !== undefined) return { title: fileName, type };
  return { title: fileName, type: "code", language: extension };
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The text an uploaded file holds, or `undefined` when its bytes are not text.
 * Decoding is strict, so invalid UTF-8 fails rather than arriving as U+FFFD.
 * A NUL byte, or a replacement character, is refused too: neither belongs in a
 * text file, and the second is what a lossy decode leaves behind. The route
 * refuses the same two shapes again, so a client that skipped this check cannot
 * store a mangled document.
 */
export function decodeArtifactText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    const text = utf8.decode(bytes);
    return text.includes("\uFFFD") ? undefined : text;
  } catch {
    return undefined;
  }
}

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
