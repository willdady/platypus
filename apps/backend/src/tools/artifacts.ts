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
import {
  ARTIFACT_EDIT_RECOVERY,
  createArtifact,
  editArtifact,
  getArtifactWithVersion,
  listArtifacts,
  rewriteArtifact,
} from "../services/artifact.ts";
import { asToolResult } from "./tool-result.ts";

/**
 * The Agent-facing Artifact surface: create one, rewrite it whole, change it
 * with targeted edits, read one version and list the Workspace's Artifacts.
 * Every tool is scoped to the invoking Workspace, and every write appends one
 * version — nothing overwrites what is already there.
 */

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
 * What a write returns: the id and version the Chat Card reads the Artifact
 * back by, and the title it shows. Content stays in storage rather than in the
 * transcript.
 */
export function createCreateArtifactTool(
  workspaceId: string,
  sourceChatId: string,
) {
  return tool({
    description:
      "Create a standalone Artifact in this workspace — a document, a script, " +
      "a Mermaid diagram, an HTML page or an SVG image — or rewrite an " +
      "existing one whole by passing its id. Use it for a piece worth keeping " +
      "apart from the conversation. The title is 1 to " +
      `${ARTIFACT_TITLE_MAX_LENGTH} characters; the content is at most ` +
      `${ARTIFACT_CONTENT_MAX_BYTES / 1024} KB. Set language only for code. ` +
      "An Artifact's type cannot change after it is created. " +
      `${approvedOriginsSentence(env().ARTIFACT_SCRIPT_ORIGINS)} ` +
      "Returns the Artifact's id, title and version number, never its content.",
    inputSchema: z.object({
      id: z
        .string()
        .optional()
        .describe(
          "An existing Artifact's id to rewrite with the whole content. Omit to create a new Artifact.",
        ),
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
    execute: async ({ id, title, type, language, content }) =>
      asToolResult(async () => {
        const { artifact, version } = id
          ? await rewriteArtifact(db, { workspaceId }, id, {
              title,
              type,
              language,
              content,
              author: "agent",
            })
          : await createArtifact(
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

        return {
          id: artifact.id,
          title: artifact.title,
          version: version.version,
        };
      }),
  });
}

export function createUpdateArtifactTool(workspaceId: string) {
  return tool({
    description:
      "Change an existing Artifact with small, targeted edits instead of " +
      "rewriting it. Each edit's `old` must occur exactly once in the " +
      "Artifact's current content; edits are applied in order and the whole " +
      "call produces one new version. If any edit matches zero times or more " +
      `than once, nothing is written and the result names that edit. ${ARTIFACT_EDIT_RECOVERY} ` +
      "Returns the Artifact's id, title and new version number, never its content.",
    inputSchema: z.object({
      id: z.string().describe("The Artifact id to change"),
      edits: z
        .array(
          z.object({
            old: z
              .string()
              .min(1)
              .describe(
                "The exact text to replace. Include surrounding context so it occurs exactly once.",
              ),
            new: z.string().describe("The exact text to put in its place"),
          }),
        )
        .min(1)
        .describe("One or more replacements, applied in order"),
    }),
    execute: async ({ id, edits }) =>
      asToolResult(async () => {
        const { artifact, version } = await editArtifact(
          db,
          { workspaceId },
          id,
          edits,
          "agent",
        );

        return {
          id: artifact.id,
          title: artifact.title,
          version: version.version,
        };
      }),
  });
}

export function createReadArtifactTool(workspaceId: string) {
  return tool({
    description:
      "Read an Artifact's title, type, version number and content — its latest " +
      "version, or a named older one. Use it when the copy you saw may be " +
      "stale, since a hand edit or a change from another Chat can replace it. " +
      "An Artifact from another workspace is not found.",
    inputSchema: z.object({
      id: z.string().describe("The Artifact id to read"),
      version: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("A version number to read; omit for the latest version"),
    }),
    execute: async ({ id, version }) =>
      asToolResult(async () => {
        const read = await getArtifactWithVersion(
          db,
          { workspaceId },
          id,
          version,
        );

        return {
          title: read.artifact.title,
          type: read.artifact.type,
          version: read.version.version,
          content: read.version.content,
        };
      }),
  });
}

export function createListArtifactsTool(workspaceId: string) {
  return tool({
    description:
      "List this workspace's Artifacts, most recently changed first, with id, " +
      "title, type and updated time. Search by title or filter by type. Never " +
      "returns content: use readArtifact to read an Artifact.",
    inputSchema: z.object({
      query: z
        .string()
        .optional()
        .describe("Only Artifacts whose title contains this text"),
      type: artifactTypeSchema
        .optional()
        .describe("Only Artifacts of this type"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of Artifacts to return (1-100, default 20)"),
    }),
    execute: async ({ query, type, limit }) =>
      asToolResult(async () => {
        // The first page of the same query the Artifacts page uses; the tool
        // trims each row to what a model needs to choose one, never content.
        const { results } = await listArtifacts(
          db,
          { workspaceId },
          { limit: limit ?? 20, offset: 0, search: query, type },
        );

        return {
          artifacts: results.map(({ id, title, type, updatedAt }) => ({
            id,
            title,
            type,
            updatedAt,
          })),
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
    updateArtifact: createUpdateArtifactTool(workspaceId),
    readArtifact: createReadArtifactTool(workspaceId),
    listArtifacts: createListArtifactsTool(workspaceId),
  };
}
