# Memory Feature Implementation Plan

## Context

This plan implements an automatic memory extraction system for Platypus that builds persistent knowledge from user conversations. The problem we're solving: agents currently have no memory across chat sessions, leading to repetitive questions and loss of context. Users must repeatedly provide the same information about their preferences, projects, and work style.

The memory system will:

- **Automatically extract** important facts from conversations using AI
- **Store memories** at two scopes: user-level (global preferences, identity) and workspace-level (project context)
- **Inject relevant memories** into future chats to provide personalization and continuity
- **Give users full control** to view, edit, and delete their memories
- **Handle deduplication** intelligently to avoid redundant information

This will significantly improve the user experience by making agents feel more context-aware and personalized over time.

## Architecture Overview

**Memory Model**: Entity-based with observations (structured, categorized facts)

**Processing Flow**:

1. Cron job polls for chats updated since last memory extraction (every 5 minutes)
2. Loads the user's existing memories (both user-level and workspace-level)
3. Sends conversation + existing memories to the extraction LLM
4. LLM returns only _new or updated_ memories (deduplication happens at extraction time)
5. Stores new memories and updates changed ones in database
6. On future chats, loads all user memories for the relevant scopes and injects into system prompt

**Key Design Decisions**:

- **User-owned memories** - ALL memories belong to a specific user (never shared between users)
- **Two scopes** - User-level (relevant across all workspaces) and workspace-level (relevant only in specific workspace)
- **Individual memory records** (not combined documents) for granular control and efficient indexing
- **LLM-based deduplication** - The extraction LLM is given existing memories and told to only return new/updated information. No embeddings needed.
- **All memories injected** - All of a user's memories (user-level + current workspace) are included in the system prompt. No semantic retrieval needed.
- **Cron-based processing** (5 min interval) - reliable, doesn't block chat responses, handles retries
- **Horizontal scaling safe** - PostgreSQL advisory locks prevent race conditions when backend scales to multiple containers

## Horizontal Scaling Architecture

**Problem**: When the backend scales horizontally (multiple Docker containers/Kubernetes pods), each instance runs its own `setInterval` cron job. This causes:

- Race conditions: Multiple instances processing the same chats simultaneously
- Duplicate API calls: Wasted cost and rate limit issues
- Data corruption: Concurrent writes to the same memory records

**Solution**: PostgreSQL Advisory Locks

Advisory locks are Postgres-native distributed locks that allow only one process to acquire a lock at a time:

```typescript
// Try to acquire lock (non-blocking)
const lockAcquired = await db.execute(
  sql`SELECT pg_try_advisory_lock(123456789) as acquired`,
);

if (!lockAcquired) {
  // Another instance is processing, skip this run
  return;
}

try {
  // Only one instance executes this code
  await processMemoryExtractionBatch();
} finally {
  // Always release lock
  await db.execute(sql`SELECT pg_advisory_unlock(123456789)`);
}
```

**Benefits**:

- ✅ No additional infrastructure (Redis, etc.)
- ✅ Automatic lock release on process crash/restart
- ✅ Non-blocking: instances skip if lock is held
- ✅ Database-native solution
- ✅ Works with any number of backend instances

**Two-Part Solution**:

1. **Wall-clock-aligned scheduling**: Instead of `setInterval` (which drifts per instance), the scheduler calculates the delay to the next clean interval boundary (e.g., :00, :05, :10...). All instances converge on the same schedule regardless of when they started.

2. **Advisory lock contention**: When all instances fire at the same wall-clock moment, only one acquires the lock. The rest skip and try again at the next aligned tick.

**Lock Behavior**:

- All instances attempt at the same wall-clock times (e.g., :00, :05, :10, :15...)
- If acquired: Process memory extraction, then release lock
- If not acquired: Skip this run, try again at next aligned tick
- Automatic release on connection close (handles process crashes)
- New instances immediately align to the same schedule on startup

This ensures exactly-one-instance processing at predictable intervals while maintaining high availability.

## Database Schema

Add to `apps/backend/src/db/schema.ts`:

### Memory Table

```typescript
export const memory = pgTable(
  "memory",
  (t) => ({
    id: t.text("id").primaryKey(),

    // IMPORTANT: All memories are user-owned (userId always set)
    // Scope determines where memory is relevant:
    //   - User-level: workspaceId = NULL (applies across all workspaces for this user)
    //   - Workspace-level: workspaceId set (applies only in this workspace for this user)
    // Memories are NEVER shared between users, even in same workspace
    userId: t
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: t
      .text("workspace_id")
      .references(() => workspace.id, { onDelete: "cascade" }),

    // Source tracking
    chatId: t
      .text("chat_id")
      .references(() => chat.id, { onDelete: "set null" }),

    // Entity-based memory structure
    entityType: t.text("entity_type").notNull(), // "preference" | "fact" | "goal" | "constraint" | "style" | "person"
    entityName: t.text("entity_name").notNull(), // e.g., "communication style", "project framework"
    observation: t.text("observation").notNull(), // The actual memory content

    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    // Primary index for scope-based retrieval (most common query pattern)
    index("idx_memory_user_workspace").on(t.userId, t.workspaceId),

    // Source tracking
    index("idx_memory_chat_id").on(t.chatId),
  ],
);
```

### Chat Table Updates

Add tracking columns to `chat` table:

```typescript
export const chat = pgTable("chat", (t) => ({
  // ... existing fields ...

  // Memory processing tracking
  lastMemoryProcessedAt: t.timestamp("last_memory_processed_at"),
  memoryExtractionStatus: t.text("memory_extraction_status").default("pending"), // "pending" | "processing" | "completed" | "failed"
}));
```

Add index for efficient processing queries:

```typescript
index("idx_chat_memory_processing").on(
  t.memoryExtractionStatus,
  t.lastMemoryProcessedAt,
  t.updatedAt,
);
```

### Provider Table Update

Add `memoryExtractionModelId` to the `provider` table, following the same pattern as `taskModelId`:

```typescript
export const provider = pgTable("provider", (t) => ({
  // ... existing fields ...
  taskModelId: t.text("task_model_id").notNull(),
  memoryExtractionModelId: t.text("memory_extraction_model_id").notNull(),
}));
```

This ensures the model ID is always a valid model within that provider's configuration. If a user updates a provider's available models, the memory extraction model is managed alongside them — avoiding orphaned references.

### Workspace Configuration

Add memory extraction configuration to `workspace` table:

```typescript
export const workspace = pgTable("workspace", (t) => ({
  // ... existing fields ...

  // Memory extraction configuration
  memoryExtractionEnabled: t.boolean("memory_extraction_enabled").default(true),
  memoryExtractionProviderId: t
    .text("memory_extraction_provider_id")
    .references(() => provider.id, { onDelete: "set null" }),
}));
```

This is separate from `taskModelProviderId` (used for title/tag generation) because memory extraction benefits from a more capable model that can reason about what's worth remembering and avoid duplicates, whereas title/tag generation is a simpler task suited to cheap models.

**Validation**: When `memoryExtractionEnabled` is set to `true`, the backend must validate that `memoryExtractionProviderId` is also set and that the referenced provider has a `memoryExtractionModelId` configured. If not, return a validation error rather than silently failing during extraction.

## Core Implementation

### 1. Memory Extraction Service

Create `apps/backend/src/services/memory-extraction.ts`:

The extraction LLM handles deduplication by receiving existing memories alongside the conversation. It returns only new memories to add and IDs of existing memories to update.

**Structured Output**: Use `generateText` with the `output` argument set to a Zod schema. This enforces the response shape at the SDK level — no need for JSON formatting instructions in the prompt or manual parsing.

```typescript
import { generateText } from "ai";
import { z } from "zod";

const memoryExtractionSchema = z.object({
  new: z.array(
    z.object({
      entityType: z.enum([
        "preference",
        "fact",
        "goal",
        "constraint",
        "style",
        "person",
      ]),
      entityName: z.string(),
      observation: z.string(),
      scope: z.enum(["user", "workspace"]),
    }),
  ),
  updates: z.array(
    z.object({
      id: z.string(),
      observation: z.string(),
    }),
  ),
});

const result = await generateText({
  model: extractionModel,
  prompt: extractionPrompt,
  output: { schema: memoryExtractionSchema },
  temperature: 0.3,
});

// result.object is typed and validated against the schema
const { new: newMemories, updates } = result.object;
```

**Extraction Prompt** (given to the task model):

```
You are a memory extraction assistant. Analyze the conversation and extract persistent facts about the user that should be remembered for future conversations.

The user's existing memories are provided below. You MUST:
- NOT re-extract information that already exists in the current memories
- If a conversation reveals updated information that contradicts an existing memory, include the existing memory's ID in the "updates" array with the corrected observation
- Only return genuinely NEW information not covered by existing memories

<existing_memories>
{existingMemoriesFormatted}
</existing_memories>

Entity types: "preference", "fact", "goal", "constraint", "style", "person"

Scope determination:
- "user": Personal facts, general preferences, identity (applies across all workspaces)
- "workspace": Project-specific context, workspace preferences, user's role in this workspace

Conversation:
{conversationText}
```

**Processing Logic**:

1. Load user's existing memories (user-level where `workspaceId IS NULL` + workspace-level for the current workspace)
2. Format existing memories with their IDs so the LLM can reference them
3. Send conversation window + existing memories to task model
4. Parse response: insert new memories, update changed ones

**Note**: Need to add `userId` column to chat table to associate chats with users for extraction.

### 2. Memory Retrieval

Create `apps/backend/src/services/memory-retrieval.ts`:

Retrieval is a simple database query — load all of the user's memories for the relevant scopes:

```typescript
async function retrieveMemories(
  userId: string,
  workspaceId: string,
): Promise<Array<typeof memoryTable.$inferSelect>> {
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
    .orderBy(memoryTable.createdAt);
}
```

All memories are injected into the system prompt. At typical scales (tens to low hundreds of memories per user), this is a small amount of text. If memory counts grow very large in the future, we can add semantic retrieval with embeddings as a Phase 2 enhancement.

### 4. Scheduler Setup

**Important**: The scheduler must handle horizontal scaling correctly. When multiple backend instances run (e.g., in Docker/Kubernetes), only ONE instance should process the memory extraction at a time to avoid race conditions and duplicate processing.

**Solution**: Use PostgreSQL advisory locks to implement distributed locking.

Create `apps/backend/src/jobs/scheduler.ts`:

```typescript
import { db } from "../db/index.ts";
import { sql } from "drizzle-orm";
import { processMemoryExtractionBatch } from "../services/memory-extraction.ts";

const MEMORY_EXTRACTION_INTERVAL_MS = parseInt(
  process.env.MEMORY_EXTRACTION_INTERVAL_MS || "300000", // 5 minutes
);

// Advisory lock ID for memory extraction (arbitrary unique number)
const MEMORY_EXTRACTION_LOCK_ID = 123456789;

async function runWithLock(fn: () => Promise<void>): Promise<void> {
  // Try to acquire advisory lock (non-blocking)
  const lockResult = await db.execute(
    sql`SELECT pg_try_advisory_lock(${MEMORY_EXTRACTION_LOCK_ID}) as acquired`,
  );

  const acquired = lockResult.rows[0]?.acquired;

  if (!acquired) {
    console.log(
      "Another backend instance is processing memories, skipping this run",
    );
    return;
  }

  try {
    await fn();
  } finally {
    // Always release lock, even if processing fails
    await db.execute(
      sql`SELECT pg_advisory_unlock(${MEMORY_EXTRACTION_LOCK_ID})`,
    );
  }
}

/**
 * Schedules a function to run at wall-clock-aligned intervals.
 *
 * Unlike setInterval (which starts from the moment the process boots),
 * this aligns execution to absolute clock boundaries. For example, with
 * a 5-minute interval, all instances will attempt to run at :00, :05,
 * :10, :15, etc. regardless of when they started.
 *
 * This is critical for horizontal scaling: all backend instances align
 * to the same schedule, so the advisory lock contention is predictable
 * and only one instance wins each cycle.
 */
function scheduleAligned(intervalMs: number, fn: () => Promise<void>): void {
  function scheduleNext() {
    const now = Date.now();
    const nextTick = Math.ceil(now / intervalMs) * intervalMs;
    const delay = nextTick - now;

    setTimeout(async () => {
      try {
        await fn();
      } catch (error) {
        console.error("Scheduled job failed:", error);
      }
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}

export function startScheduler() {
  console.log(
    `Starting memory extraction scheduler (interval: ${MEMORY_EXTRACTION_INTERVAL_MS}ms, wall-clock aligned)`,
  );

  // Schedule at wall-clock-aligned intervals with advisory lock
  scheduleAligned(MEMORY_EXTRACTION_INTERVAL_MS, async () => {
    await runWithLock(async () => {
      await processMemoryExtractionBatch();
    });
  });
}
```

Integrate into `apps/backend/index.ts` inside `main()`, after the `serve()` call (which returns immediately and doesn't block):

```typescript
import { startScheduler } from "./src/jobs/scheduler.ts";

// Inside main(), after serve():
serve({
  fetch: app.fetch,
  port: parseInt(PORT),
});

// Start background jobs (safe for horizontal scaling)
startScheduler();
```

**How It Works**:

1. **Wall-clock alignment**: `scheduleAligned` calculates the delay until the next clean interval boundary (e.g., with 5 min interval: :00, :05, :10, :15...). All instances converge on the same schedule regardless of boot time.

2. **Advisory lock**: When all instances fire at the same wall-clock moment, `pg_try_advisory_lock` ensures only one acquires the lock. The rest skip and wait for the next cycle.

3. **Crash recovery**: If the winning instance crashes mid-processing, the advisory lock is automatically released (Postgres releases it when the connection closes). On the next aligned tick, another instance picks up the work.

4. **Scale-up**: New instances immediately align to the same schedule. No coordination or leader election required beyond the database lock.

### 5. Memory Injection into Chats

Modify `apps/backend/src/routes/chat.ts` to retrieve relevant memories and `apps/backend/src/system-prompt.ts` to format and inject memories into the system prompt.

## Environment Variables

Add to `apps/backend/.env`:

```bash
# Memory extraction configuration
MEMORY_EXTRACTION_INTERVAL_MS=300000  # 5 minutes
```

## Zod Schemas

Add memory schemas to `packages/schemas/index.ts` and extend workspace update schema with memory configuration fields.

## Known Limitations & Future Work

### Limitations

1. **No userId on Chat**: Current chat schema doesn't store userId. Need to add this column for the extraction job to know which user's memories to load.

2. **All memories injected**: Every memory for a user (user-level + workspace-level) is included in the system prompt. This works well for typical volumes (tens to low hundreds) but may need semantic retrieval with embeddings if memory counts grow very large.

3. **No User UI**: User management UI (view/edit/delete memories) deferred to a future phase.

4. **No Expiration**: Memory lifecycle management (confidence decay, archival) deferred to a future phase.

5. **Error Handling**: Basic error handling in place. Need more robust retry logic and alerting for production.

6. **Horizontal Scaling**: Handled via PostgreSQL advisory locks. For very high scale (100+ instances), consider dedicated job queue system (Bull/BullMQ with Redis).

### Phase 2 Enhancements

- User management UI for viewing/editing/deleting memories
- Memory expiration and archival system
- Semantic retrieval with embeddings (for users with very large memory counts)
- Memory insights and analytics dashboard
- Agent-level memory configuration (enable/disable per agent)

## Verification

### Testing Steps

1. Apply database schema changes with `pnpm drizzle-kit-push`
2. Ensure workspace has a task model configured (`taskModelProviderId` / `taskModelId`)
3. Have conversation with preferences, facts, and goals (4+ messages)
4. Wait 5 minutes for cron extraction
5. Verify memories in database
6. Start new chat and verify memories are injected into responses
7. Test deduplication by repeating preferences
8. Test scope isolation across workspaces and users

### Monitoring

- Check logs for extraction batch runs every 5 minutes
- Query database for memory statistics (count by user, entity type, confidence)
- Verify no duplicate memories created

## Critical Files

### New Files

- `apps/backend/src/services/memory-extraction.ts`
- `apps/backend/src/services/memory-retrieval.ts`
- `apps/backend/src/jobs/scheduler.ts`

### Modified Files

- `apps/backend/src/db/schema.ts`
- `apps/backend/index.ts`
- `apps/backend/src/routes/chat.ts`
- `apps/backend/src/system-prompt.ts`
- `packages/schemas/index.ts`
- `apps/backend/.env`

## Cost Estimates

### Extraction Costs (using workspace task model, e.g. GPT-4o-mini)

- **Average extraction**: ~3000 input tokens (conversation + existing memories) + ~500 output tokens
- **High-volume workspace** (2,880 extractions/day): ~$1.50/day
- **Typical workspace** (100-500 extractions/day): ~$0.05-0.25/day
- **Mitigation**: Configurable per workspace via `memoryExtractionEnabled`, adjust cron interval

No embedding costs since we rely on the extraction LLM for deduplication.
