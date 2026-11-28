import type { ArtifactType } from "@platypus/schemas";

// why: the backend createArtifact tool description tells the model these limits; change both together

export const ARTIFACT_FRAME_SANDBOX = "allow-scripts";

export const ARTIFACT_FRAME_HOST_CSP = "frame-src 'none'";

export const ARTIFACT_FRAME_BLOCKED = "artifact-frame-blocked";

export function isFramedArtifactType(
  type: ArtifactType,
): type is Extract<ArtifactType, "html" | "svg"> {
  return type === "html" || type === "svg";
}

// why: containment rests on the policy; this script only reports what it blocked
const PRELUDE = `<script>
(function () {
  addEventListener("securitypolicyviolation", function (event) {
    var origin;
    try {
      origin = new URL(event.blockedURI).origin;
    } catch (error) {
      return;
    }
    if (origin.indexOf("https://") !== 0 && origin.indexOf("http://") !== 0) {
      return;
    }
    parent.postMessage({ type: "${ARTIFACT_FRAME_BLOCKED}", origin: origin }, "*");
  });
})();
</script>`;

export function buildArtifactFrameCsp(
  scriptOrigins: readonly string[],
): string {
  const origins = scriptOrigins.join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${origins}`,
    `style-src 'unsafe-inline' ${origins}`,
    `font-src data: ${origins}`,
    "img-src data: blob:",
    "media-src data: blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ]
    .map((directive) => directive.trim())
    .join("; ");
}

export function buildArtifactFrameDocument({
  type,
  content,
  scriptOrigins,
}: {
  type: Extract<ArtifactType, "html" | "svg">;
  content: string;
  scriptOrigins: readonly string[];
}): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${buildArtifactFrameCsp(
    scriptOrigins,
  ).replace(/"/g, "&quot;")}">`;
  const body =
    type === "svg"
      ? `<body style="margin:0;display:grid;place-items:center;min-height:100vh">${content}</body>`
      : content;
  return `<!doctype html><meta charset="utf-8">${policy}${PRELUDE}${body}`;
}

export function artifactFrameBlockedOrigin(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const message = data as { type?: unknown; origin?: unknown };
  if (message.type !== ARTIFACT_FRAME_BLOCKED) return undefined;
  if (typeof message.origin !== "string") return undefined;
  if (!/^https?:\/\//.test(message.origin)) return undefined;
  return message.origin;
}
