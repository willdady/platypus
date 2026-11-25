import type { ArtifactType } from "@platypus/schemas";

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
  return name.toLowerCase().endsWith(`.${extension}`)
    ? name
    : `${name}.${extension}`;
}

export type ArtifactUpload = {
  title: string;
  type: ArtifactType;
  language?: string;
};

// why: inverted from the download extensions, so both name the same types
const UPLOAD_TYPES = Object.fromEntries(
  Object.entries(TYPE_EXTENSIONS).map(([type, extension]) => [extension, type]),
) as Record<string, ArtifactType>;

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

export function decodeArtifactText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

const STORED_FILE_PATH = "/files";

const ABSOLUTE_URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

type ImageBase = { origin: string; path: string };

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

function baseOf(origin: string, pathname: string): ImageBase {
  return { origin, path: pathname.replace(/\/+$/, "") };
}

function isUnder(candidate: string, base: ImageBase): boolean {
  return base.path === ""
    ? candidate.startsWith("/")
    : candidate.startsWith(`${base.path}/`);
}

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

export function resolveArtifactImageSource(
  src: string,
  backendUrl?: string,
  storageBaseUrl?: string | null,
): string | undefined {
  if (src.startsWith("data:")) return src;
  if (ABSOLUTE_URL_SCHEME.test(src) && !/^https?:/i.test(src)) return undefined;

  const bases: ImageBase[] = [];
  if (storageBaseUrl) {
    try {
      const storage = new URL(storageBaseUrl);
      const path = settledPath(storage.pathname);
      if (path !== undefined) bases.push(baseOf(storage.origin, path));
    } catch {}
  }
  if (backendUrl) {
    try {
      const backend = new URL(backendUrl);
      bases.push({
        origin: backend.origin,
        path: STORED_FILE_PATH,
      });
    } catch {}
  }

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

export function isAllowedArtifactImageSource(
  src: string,
  backendUrl?: string,
  storageBaseUrl?: string | null,
): boolean {
  return (
    resolveArtifactImageSource(src, backendUrl, storageBaseUrl) !== undefined
  );
}
