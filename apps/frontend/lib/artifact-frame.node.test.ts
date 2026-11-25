import { describe, it, expect } from "vitest";
import {
  ARTIFACT_FRAME_BLOCKED,
  ARTIFACT_FRAME_HOST_CSP,
  ARTIFACT_FRAME_SANDBOX,
  artifactFrameBlockedOrigin,
  buildArtifactFrameCsp,
  buildArtifactFrameDocument,
} from "./artifact-frame";

describe("ARTIFACT_FRAME_SANDBOX", () => {
  it("is the one sandbox value, with no allow-same-origin", () => {
    expect(ARTIFACT_FRAME_SANDBOX).toBe("allow-scripts");
  });
});

describe("ARTIFACT_FRAME_HOST_CSP", () => {
  it("forbids the embedding page from loading a frame", () => {
    expect(ARTIFACT_FRAME_HOST_CSP).toBe("frame-src 'none'");
  });
});

describe("buildArtifactFrameCsp", () => {
  it("builds the policy for the approved origins", () => {
    expect(
      buildArtifactFrameCsp([
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net",
      ]),
    ).toBe(
      "default-src 'none'; " +
        "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; " +
        "style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; " +
        "font-src data: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; " +
        "img-src data: blob:; media-src data: blob:; " +
        "connect-src 'none'; form-action 'none'; base-uri 'none'",
    );
  });

  it("keeps every restriction when the Operator approves nothing", () => {
    expect(buildArtifactFrameCsp([])).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; " +
        "style-src 'unsafe-inline'; font-src data:; " +
        "img-src data: blob:; media-src data: blob:; " +
        "connect-src 'none'; form-action 'none'; base-uri 'none'",
    );
  });
});

describe("buildArtifactFrameDocument", () => {
  const policyOf = (doc: string) => doc.slice(0, doc.indexOf("</head>"));

  it("prepends the policy ahead of every piece of HTML content", () => {
    const doc = buildArtifactFrameDocument({
      type: "html",
      content: "<!doctype html><html><body><h1>Report</h1></body></html>",
      scriptOrigins: ["https://cdnjs.cloudflare.com"],
    });

    expect(doc).toContain("<h1>Report</h1>");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(
      doc.indexOf("<h1>"),
    );
    expect(doc).toContain(
      "connect-src 'none'; form-action 'none'; base-uri 'none'",
    );
  });

  it("prepends the policy ahead of content carrying its own policy element", () => {
    const doc = buildArtifactFrameDocument({
      type: "html",
      content:
        '<meta http-equiv="Content-Security-Policy" content="default-src *">',
      scriptOrigins: [],
    });

    expect(doc.indexOf("default-src 'none'")).toBeLessThan(
      doc.indexOf("default-src *"),
    );
  });

  it("keeps the policy ahead of content that closes the head early", () => {
    const doc = buildArtifactFrameDocument({
      type: "html",
      content: "</head><body><p>Hi</p>",
      scriptOrigins: [],
    });

    expect(policyOf(doc)).toContain("default-src 'none'");
    expect(doc.indexOf("default-src 'none'")).toBeLessThan(
      doc.indexOf("<p>Hi</p>"),
    );
  });

  it("wraps an SVG in a minimal document", () => {
    const doc = buildArtifactFrameDocument({
      type: "svg",
      content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>',
      scriptOrigins: [],
    });

    expect(doc).toContain("<body");
    expect(doc).toContain('<svg xmlns="http://www.w3.org/2000/svg">');
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(
      doc.indexOf("<svg"),
    );
  });

  it("installs a prelude that reports a blocked origin", () => {
    const doc = buildArtifactFrameDocument({
      type: "html",
      content: "",
      scriptOrigins: [],
    });

    expect(doc).toContain("securitypolicyviolation");
    expect(doc).toContain("postMessage");
  });
});

describe("artifactFrameBlockedOrigin", () => {
  it("reads the origin out of the frame's message", () => {
    expect(
      artifactFrameBlockedOrigin({
        type: ARTIFACT_FRAME_BLOCKED,
        origin: "https://cdnjs.cloudflare.com",
      }),
    ).toBe("https://cdnjs.cloudflare.com");
  });

  it.each([
    undefined,
    null,
    "https://cdnjs.cloudflare.com",
    { type: "something-else", origin: "https://cdnjs.cloudflare.com" },
    { type: ARTIFACT_FRAME_BLOCKED },
    { type: ARTIFACT_FRAME_BLOCKED, origin: null },
    { type: ARTIFACT_FRAME_BLOCKED, origin: "inline" },
  ])("ignores %j", (data) => {
    expect(artifactFrameBlockedOrigin(data)).toBeUndefined();
  });
});
