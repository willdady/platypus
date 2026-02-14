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

/**
 * Formats a single memory as a compact NDJSON line.
 */
function formatMemoryAsNDJSON(memory: typeof memoryTable.$inferSelect): string {
  return JSON.stringify({
    id: memory.id,
    type: memory.entityType,
    entity: memory.entityName,
    observation: memory.observation,
    scope: memory.workspaceId ? "workspace" : "user",
  });
}

/**
 * Formats memories for injection into the system prompt.
 *
 * Uses newline-delimited JSON (NDJSON) format for token efficiency.
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
    ...memories.map(formatMemoryAsNDJSON),
  ];

  return lines.join("\n");
}

/**
 * Formats existing memories for inclusion in prompts (e.g., extraction).
 *
 * Uses newline-delimited JSON (NDJSON) format for token efficiency.
 *
 * @param memories - Array of memories to format
 * @returns Formatted string, or "No existing memories." if empty
 */
export function formatMemoriesForPrompt(
  memories: (typeof memoryTable.$inferSelect)[],
): string {
  if (memories.length === 0) {
    return "No existing memories.";
  }

  return memories.map(formatMemoryAsNDJSON).join("\n");
}
