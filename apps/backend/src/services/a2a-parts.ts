import type { Artifact, Part } from "@a2a-js/sdk";

/**
 * The parts and artifacts an A2A Task sends (ADR-0032), in the SDK's
 * protobuf-style shapes, whose unused fields must still be present. A Task's
 * one artifact is its reply: whole when the Task is read, in pieces while a
 * stream follows it.
 */

/** A text part of an outbound A2A message or artifact. */
export const a2aTextPart = (text: string): Part => ({
  content: { $case: "text", value: text },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain",
});

/**
 * The reply's text — all of it, or a piece of it — as the artifact named
 * after the reply's message.
 */
export const replyArtifact = (artifactId: string, text: string): Artifact => ({
  artifactId,
  name: "reply",
  description: "",
  parts: [a2aTextPart(text)],
  metadata: undefined,
  extensions: [],
});
