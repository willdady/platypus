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
2. AI analyzes recent conversation messages using workspace-configured embedding model
3. Extracts structured memories with entity types, confidence, and importance scores
4. Deduplicates using semantic similarity search (pgvector embeddings)
5. Stores memories in database with metadata
6. On future chats, retrieves relevant memories using vector similarity
7. Injects top-K memories into system prompt for context

**Key Design Decisions**:
- **User-owned memories** - ALL memories belong to a specific user (never shared between users)
- **Two scopes** - User-level (relevant across all workspaces) and workspace-level (relevant only in specific workspace)
- **Individual memory records** (not combined documents) for granular control and efficient indexing
- **Configurable embeddings per workspace** - users can choose their embedding provider/model like task models
- **Cron-based processing** (5 min interval) - reliable, doesn't block chat responses, handles retries
- **Horizontal scaling safe** - PostgreSQL advisory locks prevent race conditions when backend scales to multiple containers
- **MVP scope** - focus on core extraction, storage, and injection; defer advanced features (UI, expiration) to phase 2

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
  sql`SELECT pg_try_advisory_lock(123456789) as acquired`
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

**Lock Behavior**:
- Each backend instance tries to acquire the lock every 5 minutes
- If acquired: Process memory extraction, then release lock
- If not acquired: Skip this run, try again in 5 minutes
- Automatic release on connection close (process crash)
- Next interval cycle will succeed, ensuring eventual processing

This ensures exactly-one-instance processing while maintaining high availability (if the processing instance crashes, another instance acquires the lock on the next interval).

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

    // Quality metrics
    confidence: t.real("confidence").notNull().default(1.0), // 0.0-1.0, how certain the fact is
    importance: t.real("importance").notNull().default(0.5), // 0.0-1.0, relevance weight

    // Vector embedding for semantic search (1536 dimensions for text-embedding-3-small)
    embedding: t.text("embedding"), // Store as JSON string: "[0.1, 0.2, ...]"

    // Lifecycle tracking (for future expiration features)
    accessCount: t.integer("access_count").notNull().default(0),
    lastAccessedAt: t.timestamp("last_accessed_at"),

    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    // Primary indexes for scope-based retrieval
    index("idx_memory_user_id").on(t.userId),
    index("idx_memory_workspace_id").on(t.workspaceId),
    index("idx_memory_user_workspace").on(t.userId, t.workspaceId),

    // Entity indexes for categorization
    index("idx_memory_entity_type").on(t.entityType),

    // Source tracking
    index("idx_memory_chat_id").on(t.chatId),

    // Full-text search on content (for keyword fallback)
    index("idx_memory_content_search").using(
      "gin",
      sql`to_tsvector('english', ${t.observation})`
    ),
  ]
);
```

**Note**: Embeddings stored as JSON text strings initially. If using pgvector extension, can migrate to native `vector` type later for better performance.

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
  t.updatedAt
)
```

### Workspace Configuration

Add embedding configuration to `workspace` table:

```typescript
export const workspace = pgTable("workspace", (t) => ({
  // ... existing fields ...

  // Memory extraction configuration (follows taskModelProviderId pattern)
  memoryExtractionEnabled: t.boolean("memory_extraction_enabled").default(true),
  memoryEmbeddingProviderId: t.text("memory_embedding_provider_id")
    .references(() => provider.id, { onDelete: "set null" }),
  memoryEmbeddingModelId: t.text("memory_embedding_model_id"),
  memoryExtractionModelId: t.text("memory_extraction_model_id"), // Model for LLM extraction
}));
```

**Fallback logic**: If `memoryEmbeddingProviderId` not set, fall back to `taskModelProviderId`.

## Core Implementation

### 1. Embedding Generation Utility

Create `apps/backend/src/utils/embeddings.ts`:

```typescript
import { embed, embedMany, cosineSimilarity } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { provider as providerTable } from "../db/schema.ts";

// Re-export cosineSimilarity from AI SDK
export { cosineSimilarity };

export async function generateEmbedding(
  text: string,
  provider: typeof providerTable.$inferSelect,
  modelId: string
): Promise<{ embedding: number[]; tokens: number }> {
  let embeddingModel;

  switch (provider.providerType) {
    case "openai": {
      // Create custom OpenAI provider with workspace-specific API key
      const customOpenAI = createOpenAI({
        apiKey: provider.apiKey,
        baseURL: provider.baseUrl || undefined,
      });
      embeddingModel = customOpenAI.embedding(modelId);
      break;
    }

    case "google": {
      const customGoogle = createGoogleGenerativeAI({
        apiKey: provider.apiKey,
      });
      embeddingModel = customGoogle.embedding(modelId);
      break;
    }

    case "anthropic":
      throw new Error("Anthropic doesn't support embeddings. Use OpenAI or Google provider.");

    default:
      throw new Error(`Provider ${provider.providerType} not supported for embeddings`);
  }

  // Use AI SDK embed function with configured model
  const result = await embed({
    model: embeddingModel,
    value: text,
  });

  return {
    embedding: result.embedding,
    tokens: result.usage?.tokens || 0,
  };
}

// Batch embedding generation for efficiency
export async function generateEmbeddings(
  texts: string[],
  provider: typeof providerTable.$inferSelect,
  modelId: string
): Promise<{ embeddings: number[][]; tokens: number }> {
  let embeddingModel;

  switch (provider.providerType) {
    case "openai": {
      const customOpenAI = createOpenAI({
        apiKey: provider.apiKey,
        baseURL: provider.baseUrl || undefined,
      });
      embeddingModel = customOpenAI.embedding(modelId);
      break;
    }

    case "google": {
      const customGoogle = createGoogleGenerativeAI({
        apiKey: provider.apiKey,
      });
      embeddingModel = customGoogle.embedding(modelId);
      break;
    }

    default:
      throw new Error(`Provider ${provider.providerType} not supported for embeddings`);
  }

  // Use embedMany for batch processing
  const result = await embedMany({
    model: embeddingModel,
    values: texts,
  });

  return {
    embeddings: result.embeddings,
    tokens: result.usage?.tokens || 0,
  };
}
```

**Important Notes**:

1. **Model String Format**: The AI SDK requires model strings in the format `"provider/model"` (e.g., `"openai/text-embedding-3-small"`).

2. **Provider Configuration**: The AI SDK providers (like `openai` and `google`) read their API keys from environment variables by default:
   - OpenAI: `OPENAI_API_KEY`
   - Google: `GOOGLE_GENERATIVE_AI_API_KEY`

3. **Custom Provider Configuration**: For workspace-specific providers with custom API keys, you'll need to configure the provider dynamically:
   ```typescript
   import { createOpenAI } from "@ai-sdk/openai";

   const customOpenAI = createOpenAI({
     apiKey: provider.apiKey,
     baseURL: provider.baseUrl,
   });

   const result = await embed({
     model: customOpenAI.embedding('text-embedding-3-small'),
     value: text,
   });
   ```

4. **Cosine Similarity**: Use the built-in `cosineSimilarity` function from the AI SDK rather than implementing it manually.

5. **Batch Processing**: Use `embedMany` when generating embeddings for multiple texts to improve efficiency and reduce API calls.

### 2. Memory Extraction Service

Create `apps/backend/src/services/memory-extraction.ts`:

See plan file for full implementation (includes extraction prompt, conversation preparation, deduplication, and batch processing).

**Note**: The service has a known limitation - determining userId from chat. Need to either:
1. Add `userId` column to chat table (recommended)
2. Query workspace membership to find chat creator
3. Store userId in chat on creation

### 3. Memory Retrieval Service

Create `apps/backend/src/services/memory-retrieval.ts`:

Implements semantic search using embeddings with fallback to keyword search. Retrieves user-level and workspace-level memories, ranks by relevance (similarity × importance), and updates access tracking.

### 4. Scheduler Setup

**Important**: The scheduler must handle horizontal scaling correctly. When multiple backend instances run (e.g., in Docker/Kubernetes), only ONE instance should process the memory extraction at a time to avoid race conditions and duplicate processing.

**Solution**: Use PostgreSQL advisory locks to implement distributed locking.

Create `apps/backend/src/jobs/scheduler.ts`:

```typescript
import { db } from "../db/index.ts";
import { sql } from "drizzle-orm";
import { processMemoryExtractionBatch } from "../services/memory-extraction.ts";

const MEMORY_EXTRACTION_INTERVAL_MS = parseInt(
  process.env.MEMORY_EXTRACTION_INTERVAL_MS || "300000" // 5 minutes
);

// Advisory lock ID for memory extraction (arbitrary unique number)
const MEMORY_EXTRACTION_LOCK_ID = 123456789;

async function runWithLock(fn: () => Promise<void>): Promise<void> {
  // Try to acquire advisory lock (non-blocking)
  const lockResult = await db.execute(
    sql`SELECT pg_try_advisory_lock(${MEMORY_EXTRACTION_LOCK_ID}) as acquired`
  );

  const acquired = lockResult.rows[0]?.acquired;

  if (!acquired) {
    console.log("Another backend instance is processing memories, skipping this run");
    return;
  }

  try {
    await fn();
  } finally {
    // Always release lock, even if processing fails
    await db.execute(
      sql`SELECT pg_advisory_unlock(${MEMORY_EXTRACTION_LOCK_ID})`
    );
  }
}

export function startScheduler() {
  const enabled = process.env.MEMORY_EXTRACTION_ENABLED !== "false";

  if (!enabled) {
    console.log("Memory extraction is disabled via environment variable");
    return;
  }

  console.log(
    `Starting memory extraction scheduler (interval: ${MEMORY_EXTRACTION_INTERVAL_MS}ms)`
  );

  // Run immediately on startup (with lock)
  runWithLock(async () => {
    await processMemoryExtractionBatch();
  }).catch(error => {
    console.error("Memory extraction batch failed:", error);
  });

  // Then run on interval (with lock)
  setInterval(async () => {
    try {
      await runWithLock(async () => {
        await processMemoryExtractionBatch();
      });
    } catch (error) {
      console.error("Memory extraction batch failed:", error);
    }
  }, MEMORY_EXTRACTION_INTERVAL_MS);
}
```

Integrate into `apps/backend/index.ts` (after database setup):

```typescript
import { startScheduler } from "./src/jobs/scheduler.ts";

// ... after main() ...

await main();

// Start background jobs (safe for horizontal scaling)
startScheduler();

console.log(`Platypus is running at http://localhost:${port}`);
```

**How It Works**:
- `pg_try_advisory_lock(id)` attempts to acquire a lock
- Returns `true` if lock acquired, `false` if another process has it
- Lock is automatically released on connection close (process crash/restart)
- Non-blocking: if lock is held, the instance skips this run without waiting
- Next interval will try again, ensuring processing eventually happens

### 5. Memory Injection into Chats

Modify `apps/backend/src/routes/chat.ts` to retrieve relevant memories and `apps/backend/src/system-prompt.ts` to format and inject memories into the system prompt.

## Environment Variables

Add to `apps/backend/.env`:

```bash
# Memory extraction configuration
MEMORY_EXTRACTION_ENABLED=true
MEMORY_EXTRACTION_INTERVAL_MS=300000  # 5 minutes
```

## Zod Schemas

Add memory schemas to `packages/schemas/index.ts` and extend workspace update schema with memory configuration fields.

## Known Limitations & Future Work

### MVP Limitations

1. **No userId on Chat**: Current chat schema doesn't store userId. Need to add this column or determine from workspace membership. For MVP, add `userId` column to chat table.

2. **Embedding Storage**: Storing embeddings as JSON strings initially. Consider pgvector migration later for:
   - Native vector operations (faster similarity search)
   - HNSW indexes for approximate nearest neighbor
   - Better performance at scale (10K+ memories per user)

3. **No User UI**: MVP focuses on automatic extraction and injection. User management UI (view/edit/delete memories) deferred to Phase 2.

4. **No Expiration**: Memory lifecycle management (confidence decay, archival) deferred to Phase 2.

5. **Error Handling**: Basic error handling in place. Need more robust retry logic and alerting for production.

6. **Horizontal Scaling**: Handled via PostgreSQL advisory locks. For very high scale (100+ instances), consider dedicated job queue system (Bull/BullMQ with Redis).

### Phase 2 Enhancements

- User management UI for viewing/editing/deleting memories
- Memory expiration and archival system
- pgvector migration for better performance
- Advanced deduplication with memory merging
- Memory insights and analytics dashboard
- Agent-level memory configuration

## Verification

### Testing Steps

1. Apply database schema changes with `pnpm drizzle-kit-push`
2. Configure workspace with OpenAI embedding provider
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
- `apps/backend/src/utils/embeddings.ts`
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

### Embedding Costs (OpenAI text-embedding-3-small)
- **Rate**: $0.02 per 1M tokens
- **10,000 memories/month**: ~500K tokens = **$0.01/month**

### Extraction Costs (GPT-4o-mini)
- **Average extraction**: ~3000 input + 500 output tokens
- **High-volume workspace**: ~$1.50/day
- **Mitigation**: Configurable per workspace, use cheaper models, adjust interval

Very affordable for typical usage patterns.
