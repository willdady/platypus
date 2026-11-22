import { tool, type Tool } from "ai";
import {
  ARTIFACT_CONTENT_MAX_BYTES,
  ARTIFACT_TITLE_MAX_LENGTH,
  ARTIFACT_TITLE_MIN_LENGTH,
  artifactContentSchema,
  artifactTypeSchema,
} from "@platypus/schemas";
import { z } from "zod";
import { db } from "../index.ts";
import { env } from "../env.ts";
import { createArtifact } from "../services/artifact.ts";
import { asToolResult } from "./tool-result.ts";

/**
 * What the model is told about external content: the deployment's approved
 * library origins, or that an HTML or SVG Artifact must be self-contained.
 * Stated in the description so a page works the first time instead of having
 * its libraries blocked at view time.
 */
function approvedOriginsSentence(scriptOrigins: readonly string[]): string {
  if (scriptOrigins.length === 0) {
    return "No external origins are approved here: an HTML or SVG Artifact's scripts, styles and fonts must be inline.";
  }
  return (
    "An HTML or SVG Artifact may load scripts, styles and fonts only from " +
    `these approved origins: ${scriptOrigins.join(", ")}. Nothing else loads.`
  );
}

/**
 * The Agent-facing Artifact surface. This slice implements creation only:
 * an Agent produces a standalone piece once, and the Chat shows a Card that
 * opens it. Editing, rewriting, reading and listing arrive with later slices,
 * so they are deliberately absent here rather than stubbed.
 */
export function createCreateArtifactTool(
  workspaceId: string,
  sourceChatId: string,
) {
  return tool({
    description:
      "Create a standalone Artifact in this workspace: a document, a script, " +
      "a Mermaid diagram, an HTML page or an SVG image. Use it for a piece " +
      "worth keeping apart from the conversation. The title is 1 to " +
      `${ARTIFACT_TITLE_MAX_LENGTH} characters; the content is at most ` +
      `${ARTIFACT_CONTENT_MAX_BYTES / 1024} KB. Set language only for code. ` +
      `${approvedOriginsSentence(env().ARTIFACT_SCRIPT_ORIGINS)} ` +
      "Returns the Artifact's id, title and version number, never its content.",
    inputSchema: z.object({
      title: z
        .string()
        .min(ARTIFACT_TITLE_MIN_LENGTH)
        .max(ARTIFACT_TITLE_MAX_LENGTH)
        .describe("A short name for the Artifact, 1 to 200 characters"),
      type: artifactTypeSchema.describe(
        "The content type. Use code for a script, mermaid for a diagram, html for a page, svg for an image.",
      ),
      language: z
        .string()
        .optional()
        .describe(
          "The programming language for a code Artifact; omit for every other type",
        ),
      content: artifactContentSchema.describe(
        "The full content, at most 512 KB",
      ),
    }),
    execute: async ({ title, type, language, content }) =>
      asToolResult(async () => {
        const { artifact, version } = await createArtifact(
          db,
          { workspaceId },
          {
            title,
            type,
            language,
            content,
            sourceChatId,
            author: "agent",
          },
        );

        // The id and version are what the Chat Card reads the Artifact back
        // by; the content stays in storage rather than in the transcript.
        return {
          id: artifact.id,
          title: artifact.title,
          version: version.version,
        };
      }),
  });
}

export function createArtifactTools(
  workspaceId: string,
  sourceChatId: string,
): Record<string, Tool> {
  return {
    createArtifact: createCreateArtifactTool(workspaceId, sourceChatId),
  };
}
