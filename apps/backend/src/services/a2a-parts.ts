import type { Artifact, Part } from "@a2a-js/sdk";

export const a2aTextPart = (text: string): Part => ({
  content: { $case: "text", value: text },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain",
});

export const replyArtifact = (artifactId: string, text: string): Artifact => ({
  artifactId,
  name: "reply",
  description: "",
  parts: [a2aTextPart(text)],
  metadata: undefined,
  extensions: [],
});
