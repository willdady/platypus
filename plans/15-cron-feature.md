# 15 - Cron Feature

## Context

Users need the ability to schedule agents to run automatically at specific times — either as one-off executions or on a repeating schedule. The agent runs headless (no browser streaming) and produces a chat record that can be reviewed later. This enables automation use cases like daily report generation, periodic data checks, or scheduled content creation.

Key constraints:

- Backend may be horizontally scaled — only one instance should execute each cron job per tick
- Cron-triggered chats are separate from regular chats (no sidebar pollution, no tag generation, no memory extraction)
- Instructions are sent as the initial user message (not injected into system prompt)

---

## 1. Database Schema

**File:** `apps/backend/src/db/schema.ts`

### New `cronJob` table

```typescript
export const cronJob = pgTable(
  "cron_job",
  (t) => ({
    id: t.text("id").primaryKey(),
    workspaceId: t
      .text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    agentId: t
      .text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "restrict" }),
    name: t.text("name").notNull(),
    description: t.text("description"),
    instruction: t.text("instruction").notNull(),
    cronExpression: t.text("cron_expression").notNull(),
    timezone: t.text("timezone").notNull().default("UTC"),
    isOneOff: t.boolean("is_one_off").notNull().default(false),
    enabled: t.boolean("enabled").notNull().default(true),
    maxChatsToKeep: t.integer("max_chats_to_keep").notNull().default(50),
    lastRunAt: t.timestamp("last_run_at"),
    nextRunAt: t.timestamp("next_run_at"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_cron_job_workspace_id").on(t.workspaceId),
    index("idx_cron_job_next_run_at").on(t.nextRunAt),
  ],
);
```

### Add `cronJobId` to `chat` table

```typescript
cronJobId: t.text("cron_job_id").references(() => cronJob.id, { onDelete: "cascade" }),
```

Add index: `index("idx_chat_cron_job_id").on(t.cronJobId)`

The `onDelete: "cascade"` means deleting a cron job also deletes all its chat history.

---

## 2. Shared Schemas

**File:** `packages/schemas/index.ts`

Add `cronJobSchema`, `cronJobCreateSchema`, `cronJobUpdateSchema`, `CronJob` type. Follow existing naming conventions. Key fields:

- `name`: string, min 1, max 100
- `instruction`: string, min 1, max 10000
- `cronExpression`: string (validated server-side with croner)
- `timezone`: string (IANA timezone)
- `isOneOff`: boolean
- `enabled`: boolean
- `maxChatsToKeep`: number, int, min 1, max 1000, default 50

Update `chatSchema` and `chatListItemSchema` to include optional `cronJobId`.

---

## 3. Extract Shared Chat Execution Helpers

**New file:** `apps/backend/src/services/chat-execution.ts`

Extract from `apps/backend/src/routes/chat.ts`:

- `createModel()` — creates AI SDK provider instance from provider config
- `resolveChatContext()` — resolves agent → provider/model/maxSteps
- `loadTools()` — loads tool sets + MCP tools
- `resolveGenerationConfig()` — merges agent config with overrides

Then update `chat.ts` to import these from the shared service. This avoids duplicating complex logic in the cron scheduler.

---

## 4. Backend CRUD Routes

**New file:** `apps/backend/src/routes/cron-job.ts`

Follow the pattern in existing route files (e.g., `agent.ts`).

Middleware chain: `requireAuth → requireOrgAccess() → requireWorkspaceAccess → requireWorkspaceOwner`

### Endpoints

| Method                     | Path                                                                        | Description |
| -------------------------- | --------------------------------------------------------------------------- | ----------- |
| `GET /`                    | List cron jobs in workspace                                                 |
| `POST /`                   | Create cron job. Validate cron expression with croner. Compute `nextRunAt`. |
| `GET /:cronJobId`          | Get single cron job                                                         |
| `PUT /:cronJobId`          | Update cron job. Recompute `nextRunAt`.                                     |
| `DELETE /:cronJobId`       | Delete cron job (cascades to its chats)                                     |
| `GET /:cronJobId/chats`    | List chats for this cron job, ordered by `createdAt DESC`                   |
| `POST /:cronJobId/trigger` | Manually trigger the cron job (runs immediately, useful for testing)        |

### Mount in `apps/backend/src/server.ts`

```typescript
app.route(
  "/organizations/:orgId/workspaces/:workspaceId/cron-jobs",
  cronJobRoute,
);
```

---

## 5. Cron Scheduler

**New file:** `apps/backend/src/jobs/cron-scheduler.ts`

Reuse the advisory lock + wall-clock-aligned scheduling pattern from `apps/backend/src/jobs/scheduler.ts`.

```
Lock ID: 987654321 (distinct from memory extraction's 123456789)
Check interval: 60 seconds (1 minute)
```

### `processDueCronJobs()` flow

1. Query `cronJob` where `enabled = true` AND `nextRunAt <= NOW()`
2. For each due job:
   a. Fetch the agent and its provider
   b. Fetch the workspace (need `ownerId` for user context — the workspace owner is used as the "user" for system prompt rendering, memory retrieval, etc.)
   c. Use extracted helpers: `createModel()`, `loadTools()`, `renderSystemPrompt()`
   d. Call `generateText()` (NOT `streamText()`) with:
   - The instruction as a single user message
   - All agent tools loaded
   - `maxSteps` from agent config
     e. Save result as a new chat via `upsertChatRecord()` with:
   - `cronJobId` set
   - `memoryExtractionStatus = "completed"` (skip memory extraction)
   - Empty `tags` array
     f. Update `cronJob.lastRunAt = NOW()`
     g. Compute next run via croner and update `nextRunAt`. If `isOneOff`, set `enabled = false`
     h. **Retention cleanup:** Delete oldest chats for this cronJobId beyond `maxChatsToKeep`

### Error handling

- If agent execution fails, log the error but don't disable the cron job
- Consider storing a `lastRunStatus` field (or just rely on the chat record existing or not)

### Start in `apps/backend/index.ts`

```typescript
import { startCronScheduler } from "./jobs/cron-scheduler.ts";
// After startScheduler():
startCronScheduler();
```

---

## 6. Exclude Cron Chats from Normal Flows

### Chat list endpoint (`apps/backend/src/routes/chat.ts` GET `/`)

Add `isNull(chatTable.cronJobId)` to the WHERE clause so cron chats never appear in the sidebar.

### Memory extraction (`apps/backend/src/services/memory-extraction.ts`)

Add `isNull(chatTable.cronJobId)` to `findChatsToProcess()` query. Belt-and-suspenders with the `memoryExtractionStatus = "completed"` set at creation time.

### Tag generation

Not called for cron chats — the cron scheduler simply never invokes the generate-metadata endpoint.

---

## 7. Frontend

### New dependency

Add `croner` to `apps/frontend` for client-side cron expression validation and "next run" preview.

### Route structure

```
/[orgId]/workspace/[workspaceId]/cron-jobs/          → List page
/[orgId]/workspace/[workspaceId]/cron-jobs/create/    → Create form
/[orgId]/workspace/[workspaceId]/cron-jobs/[cronJobId]/ → Edit form + nested chat history
```

### Sidebar (`apps/frontend/components/app-sidebar.tsx`)

Add a "Schedules" link in the sidebar footer (alongside the existing Settings link). Use the `Timer` icon from lucide-react.

### Cron Job List (`apps/frontend/components/cron-job-list.tsx`)

Grid layout matching agents-list.tsx pattern. Each card shows:

- Name, description
- Agent name (linked)
- Schedule (human-readable, e.g., "Every day at 9:00 AM UTC")
- Enabled/disabled badge
- Last run timestamp
- Actions: Edit, Toggle enabled, Delete

### Cron Job Form (`apps/frontend/components/cron-job-form.tsx`)

Follow `agent-form.tsx` patterns. Fields:

- **Name** — text input
- **Description** — text input (optional)
- **Agent** — select dropdown (fetched from workspace agents)
- **Instruction** — expandable textarea (the message sent to the agent each run)
- **Schedule mode toggle** — Simple / Advanced
  - **Simple mode:** Dropdowns that compose a cron expression under the hood
    - Frequency: Hourly, Daily, Weekly, Monthly
    - Time picker (hour/minute)
    - Day of week (for weekly), Day of month (for monthly)
  - **Advanced mode:** Raw cron expression text input with validation
- **Timezone** — select dropdown (IANA timezones)
- **One-off** — checkbox (run once then disable)
- **Max chats to keep** — number input (default 50)
- **Next run preview** — computed from the expression, displayed read-only

### Cron Job Detail Page

The edit page (`/cron-jobs/[cronJobId]/`) shows:

1. The edit form (top)
2. A "Run History" section (below) — table of chats from `GET /cron-jobs/:cronJobId/chats`
   - Columns: Title/ID, Created at, Duration (if tracked), Actions (View)
   - Click to navigate to `/chat/[chatId]` to view the full conversation
   - The chat view works as-is since cron chats are regular chat records

---

## 8. Dependencies

```bash
pnpm --filter backend add croner
pnpm --filter frontend add croner
```

---

## 9. Implementation Order

1. Add `croner` dependency to backend and frontend
2. Database schema: `cronJob` table + `chat.cronJobId` column → `pnpm drizzle-kit-push`
3. Shared schemas in `packages/schemas/index.ts`
4. Extract chat execution helpers into `apps/backend/src/services/chat-execution.ts`; update `chat.ts` imports
5. Backend CRUD routes for cron jobs (`apps/backend/src/routes/cron-job.ts`) + mount in `server.ts`
6. Cron scheduler service (`apps/backend/src/jobs/cron-scheduler.ts`) + start in `index.ts`
7. Filter cron chats from chat list endpoint and memory extraction
8. Frontend: cron-job-form component
9. Frontend: list/create/detail pages + route files
10. Frontend: sidebar navigation link
11. Bruno API collection for cron-job endpoints
12. Tests

---

## 10. Verification

1. **Database:** Run `pnpm drizzle-kit-push` and verify the `cron_job` table and `chat.cron_job_id` column exist
2. **CRUD:** Use Bruno to create/read/update/delete cron jobs via the API
3. **Manual trigger:** Use `POST /cron-jobs/:id/trigger` to execute a cron job immediately and verify a chat is created with `cronJobId` set
4. **Scheduler:** Create an enabled cron job with `* * * * *` (every minute), verify it triggers and produces chats
5. **Isolation:** Verify cron chats do NOT appear in the normal chat list sidebar
6. **Memory exclusion:** Verify cron chats are not picked up by memory extraction
7. **Retention:** Set `maxChatsToKeep = 3`, trigger multiple runs, verify old chats are deleted
8. **One-off:** Create a one-off cron job, verify it runs once and sets `enabled = false`
9. **Frontend:** Navigate to cron jobs list, create a new one via the form, verify schedule preview, check nested chat history on detail page
10. **Horizontal scaling:** Start two backend instances, verify only one processes each cron tick (check logs for advisory lock skip messages)

---

## Key Files to Modify/Create

| File                                                           | Action                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| `apps/backend/src/db/schema.ts`                                | Add `cronJob` table, add `cronJobId` to `chat`             |
| `packages/schemas/index.ts`                                    | Add cron job schemas, update chat schemas                  |
| `apps/backend/src/services/chat-execution.ts`                  | **New** — extracted shared helpers                         |
| `apps/backend/src/routes/chat.ts`                              | Import from shared helpers, filter cron chats from list    |
| `apps/backend/src/routes/cron-job.ts`                          | **New** — CRUD routes                                      |
| `apps/backend/src/server.ts`                                   | Mount cron-job routes                                      |
| `apps/backend/src/jobs/cron-scheduler.ts`                      | **New** — scheduler with advisory lock                     |
| `apps/backend/src/jobs/scheduler.ts`                           | Extract `runWithLock` and `scheduleAligned` to be reusable |
| `apps/backend/index.ts`                                        | Start cron scheduler                                       |
| `apps/backend/src/services/memory-extraction.ts`               | Exclude cron chats from extraction query                   |
| `apps/frontend/components/cron-job-form.tsx`                   | **New** — form component                                   |
| `apps/frontend/components/cron-job-list.tsx`                   | **New** — list component                                   |
| `apps/frontend/app/[orgId]/workspace/[workspaceId]/cron-jobs/` | **New** — route pages                                      |
| `apps/frontend/components/app-sidebar.tsx`                     | Add "Schedules" nav link                                   |
