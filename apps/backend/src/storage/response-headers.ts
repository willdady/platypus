/**
 * The protective headers a stored file is served with, decided from its stored
 * media type at serve time so files stored before a rule existed get it too.
 *
 * The media type is the client's (see `STORABLE_MEDIA_TYPE_EXTENSIONS`), and a
 * few of the allowed types are documents a browser will execute when opened
 * in a tab on this origin. `nosniff` only stops the browser choosing a
 * different type; it does nothing about a type that is itself active.
 *
 * - `image/svg+xml` is a document that may carry script. It is served as a
 *   download, and sandboxed with no sources, so nothing inside it runs with
 *   the viewer's session even when a browser renders it anyway. `<img>` is
 *   unaffected: an image never runs script and ignores the disposition.
 * - `application/pdf` is left alone: Chrome's built-in viewer refuses a PDF
 *   under `sandbox`.
 * - Everything else gets a bare `sandbox`, which is enough to isolate it from
 *   this origin while still letting an image or video show when opened
 *   directly.
 */
export function servedFileHeaders(contentType: string): Record<string, string> {
  const type = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (type === "image/svg+xml") {
    return {
      "Content-Disposition": "attachment",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    };
  }
  if (type === "application/pdf") {
    return {};
  }
  return { "Content-Security-Policy": "sandbox" };
}
