import type { ArtifactType } from "@platypus/schemas";

/**
 * The Artifact frame: the one place HTML and SVG Artifacts run. This module is
 * pure — no React, no DOM — so the document and its policy are built the same
 * way on the server and in a test, and the strings that contain a hostile
 * Artifact are pinned verbatim by the unit tests.
 *
 * Three layers of restriction, each doing something the others cannot:
 *
 * 1. The `sandbox` attribute gives the frame an opaque origin. No cookies, no
 *    storage, no reach into the Platypus page, no popups, forms or top-level
 *    navigation.
 * 2. The injected policy stops the frame reaching the network apart from the
 *    library origins the Operator approved.
 * 3. The embedding page's own `frame-src 'none'` stops the frame navigating
 *    itself to another URL with data in the query string. A policy inside the
 *    frame cannot do that.
 *
 * The values below are the ones the throwaway frame prototype validated in
 * Chrome, and ADR-0047 records why the design has this shape.
 */

/** No `allow-same-origin`: the frame gets an opaque origin. */
export const ARTIFACT_FRAME_SANDBOX = "allow-scripts";

/** The embedding page sends this; an in-frame policy cannot stop a redirect. */
export const ARTIFACT_FRAME_HOST_CSP = "frame-src 'none'";

/** The `type` on a message a frame posts when its policy blocked a request. */
export const ARTIFACT_FRAME_BLOCKED = "artifact-frame-blocked";

/**
 * Whether an Artifact's content runs in the frame. The viewer, the frame
 * component and the document builder all ask this one question, so a future
 * framed type is added in one place.
 */
export function isFramedArtifactType(
  type: ArtifactType,
): type is Extract<ArtifactType, "html" | "svg"> {
  return type === "html" || type === "svg";
}

/**
 * The prelude runs inside the frame, after the policy, and tells the viewer
 * which site was blocked so it can show a notice. The notice is informational:
 * containment rests on the policy, never on this script.
 */
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

/**
 * The Artifact's own Content-Security-Policy for the approved library origins.
 * `connect-src`, `form-action` and `base-uri` stay `'none'` whatever is
 * approved, so content can load a library but still cannot send data out.
 *
 * The directives are the spec's, and each is trimmed the way the validated
 * prototype trimmed it, so an empty list leaves no trailing space.
 */
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

/**
 * The document a frame's `srcDoc` carries. The policy is prepended, never
 * spliced into the content: nothing an Agent or the User wrote can come before
 * it, and a later `<meta>` in the content can only tighten the policy. SVG is
 * wrapped in a minimal document so script inside it is held to the same rules.
 */
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

/**
 * The origin a frame's blocked-request message names, or `undefined` when the
 * value is not one. The viewer still checks the message came from its own
 * frame; this only reads the payload.
 */
export function artifactFrameBlockedOrigin(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const message = data as { type?: unknown; origin?: unknown };
  if (message.type !== ARTIFACT_FRAME_BLOCKED) return undefined;
  if (typeof message.origin !== "string") return undefined;
  if (!/^https?:\/\//.test(message.origin)) return undefined;
  return message.origin;
}
