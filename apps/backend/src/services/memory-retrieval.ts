import { eq, and, or, isNull, desc } from "drizzle-orm";
import { db } from "../index.ts";
import { memory as memoryTable } from "../db/schema.ts";

/**
 * Retrieves user-level memories that apply across all workspaces.
 *
 * @param userId - The ID of the user whose memories to retrieve
 * @returns Array of user-level memories sorted by creation date (newest first)
 */
export async function retrieveUserLevelMemories(
  userId: string,
): Promise<(typeof memoryTable.$inferSelect)[]> {
  return db
    .select()
    .from(memoryTable)
    .where(and(eq(memoryTable.userId, userId), isNull(memoryTable.workspaceId)))
    .orderBy(desc(memoryTable.createdAt));
}

/**
 * Retrieves workspace-level memories for a specific workspace.
 *
 * @param userId - The ID of the user whose memories to retrieve
 * @param workspaceId - The ID of the current workspace
 * @returns Array of workspace-level memories sorted by creation date (newest first)
 */
export async function retrieveWorkspaceLevelMemories(
  userId: string,
  workspaceId: string,
): Promise<(typeof memoryTable.$inferSelect)[]> {
  return db
    .select()
    .from(memoryTable)
    .where(
      and(
        eq(memoryTable.userId, userId),
        eq(memoryTable.workspaceId, workspaceId),
      ),
    )
    .orderBy(desc(memoryTable.createdAt));
}

/**
 * Retrieves all memories for a user within the relevant scopes.
 *
 * This loads:
 * - User-level memories (where workspaceId IS NULL) - apply across all workspaces
 * - Workspace-level memories for the current workspace - apply only in this workspace
 *
 * @param userId - The ID of the user whose memories to retrieve
 * @param workspaceId - The ID of the current workspace
 * @returns Array of memories sorted by creation date (oldest first)
 */
export async function retrieveMemories(
  userId: string,
  workspaceId: string,
): Promise<(typeof memoryTable.$inferSelect)[]> {
  return db
    .select()
    .from(memoryTable)
    .where(
      and(
        eq(memoryTable.userId, userId),
        or(
          isNull(memoryTable.workspaceId), // User-level memories
          eq(memoryTable.workspaceId, workspaceId), // Workspace-level memories
        ),
      ),
    )
    .orderBy(desc(memoryTable.createdAt));
}

const TSV_HEADER = "id\ttype\tentity\tobservation\tscope";
const TSV_HEADER_NO_SCOPE = "id\ttype\tentity\tobservation";

function sanitizeTSVField(value: string): string {
  return value.replace(/[\t\n\r]/g, " ");
}

/**
 * Formats a single memory as a TSV row including scope column.
 */
function formatMemoryAsTSVRow(memory: typeof memoryTable.$inferSelect): string {
  const scope = memory.workspaceId ? "workspace" : "user";
  return [
    memory.id,
    memory.entityType,
    memory.entityName,
    memory.observation,
    scope,
  ]
    .map(sanitizeTSVField)
    .join("\t");
}

/**
 * Formats a single memory as a TSV row excluding scope column.
 */
function formatMemoryAsTSVRowNoScope(
  memory: typeof memoryTable.$inferSelect,
): string {
  return [memory.id, memory.entityType, memory.entityName, memory.observation]
    .map(sanitizeTSVField)
    .join("\t");
}

/**
 * Formats memories for injection into the system prompt.
 *
 * Uses TSV format (tab-separated values with a single header row) for token efficiency.
 * Excludes the scope column as it is not useful to the LLM during regular chat.
 *
 * @param memories - Array of memories to format
 * @returns Formatted string for system prompt, or empty string if no memories
 */
export function formatMemoriesForSystemPrompt(
  memories: (typeof memoryTable.$inferSelect)[],
): string {
  if (memories.length === 0) {
    return "";
  }

  const lines = [
    "The following memories about the user have been extracted from previous conversations. Use these to personalize your responses:",
    "",
    TSV_HEADER_NO_SCOPE,
    ...memories.map(formatMemoryAsTSVRowNoScope),
  ];

  return lines.join("\n");
}

/**
 * Formats existing memories for inclusion in prompts (e.g., extraction).
 *
 * Uses TSV format (tab-separated values with a single header row) for token efficiency.
 *
 * @param memories - Array of memories to format
 * @returns Formatted string, or "No existing memories." if empty
 */
export function formatMemoriesForExtractionPrompt(
  memories: (typeof memoryTable.$inferSelect)[],
): string {
  if (memories.length === 0) {
    return "No existing memories.";
  }

  return [TSV_HEADER, ...memories.map(formatMemoryAsTSVRow)].join("\n");
}
