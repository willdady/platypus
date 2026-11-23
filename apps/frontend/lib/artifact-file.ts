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
 * Decoding is strict, so bytes outside UTF-8 fail rather than arriving as
 * U+FFFD, and a NUL byte — which no text file uses — is refused. U+FFFD itself
 * is ordinary text: a file that genuinely holds one is a valid upload. The
 * route refuses the NUL again, so a client that skipped this check cannot store
 * what Postgres cannot hold.
 */
export function decodeArtifactText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/** The path this deployment serves stored files under. */
const STORED_FILE_PATH = "/files";

/** A URL scheme at the start of an absolute URL, as opposed to a relative path. */
const ABSOLUTE_URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** One base an image may load from: a host, and the path on it that is ours. */
type ImageBase = { origin: string; path: string };

/**
 * The path a server would act on, after the percent-decoding every server does,
 * or `undefined` when it never settles. A path still changing after repeated
 * decoding is hiding what it will finally name, so it is refused rather than
 * matched on a prefix it may later shed.
 */
function settledPath(pathname: string): string | undefined {
  let path = pathname;
  for (let pass = 0; pass < 3; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return undefined;
    }
    if (decoded === path) return path;
    path = decoded;
  }
  return undefined;
}

/** The base a URL must be at or under: same origin, and a path below it. */
function baseOf(origin: string, pathname: string): ImageBase {
  return { origin, path: pathname.replace(/\/+$/, "") };
}

/** Whether `candidate` names something below `base.path` — not a sibling path. */
function isUnder(candidate: string, base: ImageBase): boolean {
  return base.path === ""
    ? candidate.startsWith("/")
    : candidate.startsWith(`${base.path}/`);
}

/**
 * The URL this base serves for `url`, or `undefined` when it does not. The
 * decision is taken on the path a server would see, not the string as written:
 * dot segments and encoded variants resolve before the prefix is checked, so
 * neither can climb out of the base into a sibling path or another route.
 */
function resolveUnderBase(url: URL, base: ImageBase): string | undefined {
  if (url.origin !== base.origin) return undefined;

  const path = settledPath(url.pathname);
  if (path === undefined) return undefined;
  if (path.split("/").includes("..")) return undefined;
  if (!isUnder(path, base)) return undefined;

  let normalized: URL;
  try {
    normalized = new URL(path, base.origin);
  } catch {
    return undefined;
  }
  const normalizedPath = settledPath(normalized.pathname);
  if (
    normalized.origin !== base.origin ||
    normalizedPath === undefined ||
    !isUnder(normalizedPath, base)
  ) {
    return undefined;
  }

  normalized.search = url.search;
  normalized.hash = url.hash;
  return normalized.href;
}

/**
 * The URL a markdown Artifact may load an image from, or `undefined` when it
 * must not be requested. Inline content, this deployment's `/files` route and
 * the public base it serves stored files from (a bucket or CDN, when
 * `STORAGE_PUBLIC_URL` is set) qualify; every other host is refused, and the
 * reader sees a blocked placeholder with the URL as a link instead.
 *
 * The decision is taken on the URL the browser will request, not the string as
 * written: the path is resolved and percent-decoded the way a server decodes
 * it, so `..` and encoded variants cannot climb out of the base into another
 * route. A path still changing after repeated decoding is refused.
 */
export function resolveArtifactImageSource(
  src: string,
  backendUrl?: string,
  storageBaseUrl?: string | null,
): string | undefined {
  if (src.startsWith("data:")) return src;
  // A scheme other than http(s) is never a stored-file URL, whatever its origin
  // looks like once parsed.
  if (ABSOLUTE_URL_SCHEME.test(src) && !/^https?:/i.test(src)) return undefined;

  const bases: ImageBase[] = [];
  if (storageBaseUrl) {
    try {
      const storage = new URL(storageBaseUrl);
      const path = settledPath(storage.pathname);
      if (path !== undefined) bases.push(baseOf(storage.origin, path));
    } catch {
      // A malformed base allows nothing, rather than everything.
    }
  }
  if (backendUrl) {
    try {
      const backend = new URL(backendUrl);
      bases.push({
        origin: backend.origin,
        path: STORED_FILE_PATH,
      });
    } catch {
      // Same as the storage base: a malformed base allows nothing.
    }
  }

  // A relative URL resolves against the backend when the viewer has one, as it
  // always has, and against the storage base otherwise; an absolute one needs
  // no resolver at all.
  const resolver = backendUrl ?? storageBaseUrl ?? undefined;
  if (bases.length === 0) return undefined;

  let url: URL;
  try {
    url = new URL(src, resolver);
  } catch {
    return undefined;
  }

  for (const base of bases) {
    const resolved = resolveUnderBase(url, base);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/** Whether a markdown Artifact may load an image from `src`. */
export function isAllowedArtifactImageSource(
  src: string,
  backendUrl?: string,
  storageBaseUrl?: string | null,
): boolean {
  return (
    resolveArtifactImageSource(src, backendUrl, storageBaseUrl) !== undefined
  );
}
