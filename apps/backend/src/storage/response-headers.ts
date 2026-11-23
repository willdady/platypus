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
