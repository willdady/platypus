# Kanban Board Feature - Implementation Plan

## Context

Platypus needs a kanban board feature so both human users and AI agents can manage work visually. Boards live under workspaces. Users define columns and drag cards between them. AI agents (especially on recurring schedules) can inspect boards, pick up cards, do work, and move cards — making this a natural complement to the schedule feature.

## Design Decisions

- **Ordering**: Float-based `position` field on columns and cards. Insert between two items using midpoint. Rebalance to integers when gap < 0.001.
- **Labels**: Board-scoped entities with name + hex color. Cards reference labels via JSONB array of label IDs.
- **Card attribution**: Two nullable column pairs — `createdByUserId`/`createdByAgentId` and `lastEditedByUserId`/`lastEditedByAgentId`. Exactly one is set per pair.
- **DnD**: `@dnd-kit/core` + `@dnd-kit/sortable` for accessible, cross-container drag. `motion` (already installed) for the 3D lift overlay animation.
- **Both columns and cards are draggable** via drag-and-drop.
- **Card body**: Markdown, rendered when viewing.
- **No WIP limits** for MVP.
- **No real-time sync** — SWR polling with `refreshInterval: 10000` on the board page.

---

## 1. Shared Schemas

**File**: `packages/schemas/index.ts`

Add schemas following existing conventions:

```
kanbanBoardSchema, kanbanBoardCreateSchema, kanbanBoardUpdateSchema
kanbanColumnSchema, kanbanColumnCreateSchema, kanbanColumnUpdateSchema
kanbanLabelSchema, kanbanLabelCreateSchema, kanbanLabelUpdateSchema
kanbanCardSchema, kanbanCardCreateSchema, kanbanCardUpdateSchema
kanbanCardMoveSchema          — { columnId, afterCardId: string | null }
kanbanBoardStateSchema        — board + columns (with nested cards) + labels
kanbanColumnReorderSchema     — { columnIds: string[] }
```

Card schema includes attribution fields. Board state schema is the nested response for the board page and AI tools.

---

## 2. Database Schema

**File**: `apps/backend/src/db/schema.ts`

Four new tables:

### `kanban_board`

| Column                 | Type                | Notes                |
| ---------------------- | ------------------- | -------------------- |
| id                     | text PK             | nanoid               |
| workspace_id           | text FK → workspace | cascade delete       |
| name                   | text                | unique per workspace |
| description            | text                | nullable             |
| created_at, updated_at | timestamp           | defaultNow           |

Index on `workspace_id`. Unique on `(workspace_id, name)`.

### `kanban_column`

| Column                 | Type                   | Notes          |
| ---------------------- | ---------------------- | -------------- |
| id                     | text PK                | nanoid         |
| board_id               | text FK → kanban_board | cascade delete |
| name                   | text                   |                |
| position               | real                   | float ordering |
| created_at, updated_at | timestamp              | defaultNow     |

Index on `board_id`.

### `kanban_label`

| Column                 | Type                   | Notes              |
| ---------------------- | ---------------------- | ------------------ |
| id                     | text PK                | nanoid             |
| board_id               | text FK → kanban_board | cascade delete     |
| name                   | text                   | unique per board   |
| color                  | text                   | hex e.g. "#ef4444" |
| created_at, updated_at | timestamp              | defaultNow         |

Index on `board_id`. Unique on `(board_id, name)`.

### `kanban_card`

| Column                  | Type                    | Notes                        |
| ----------------------- | ----------------------- | ---------------------------- |
| id                      | text PK                 | nanoid                       |
| column_id               | text FK → kanban_column | cascade delete               |
| title                   | text                    |                              |
| body                    | text                    | nullable, markdown           |
| label_ids               | jsonb                   | string[], default []         |
| position                | real                    | float ordering within column |
| created_by_user_id      | text FK → user          | set null on delete, nullable |
| created_by_agent_id     | text FK → agent         | set null on delete, nullable |
| last_edited_by_user_id  | text FK → user          | set null on delete, nullable |
| last_edited_by_agent_id | text FK → agent         | set null on delete, nullable |
| created_at, updated_at  | timestamp               | defaultNow                   |

Indexes: `column_id`, GIN on `label_ids`, composite `(column_id, position)`.

After editing schema, run `pnpm drizzle-kit-push`.

---

## 3. Backend API Routes

**New file**: `apps/backend/src/routes/kanban.ts`
**Mount in**: `apps/backend/src/server.ts` at `/organizations/:orgId/workspaces/:workspaceId/boards`

Middleware chain: `requireAuth` → `requireOrgAccess()` → `requireWorkspaceAccess` on all routes. Write operations additionally use `requireWorkspaceOwner`.

### Board CRUD

- `POST /` — create board (201)
- `GET /` — list boards (200, `{ results }`)
- `GET /:boardId` — get board (200 or 404)
- `PUT /:boardId` — update board (200)
- `DELETE /:boardId` — delete board (200)

### Board State

- `GET /:boardId/state` — full board with columns (sorted by position), cards nested in each column (sorted by position), and labels. Single endpoint consumed by frontend and AI tools.

### Column CRUD

- `POST /:boardId/columns` — create column, position = max existing + 1 (201)
- `PUT /:boardId/columns/:columnId` — update column name (200)
- `DELETE /:boardId/columns/:columnId` — delete column and its cards (200)
- `PUT /:boardId/columns/reorder` — accepts `{ columnIds: string[] }`, reassigns integer positions (200)

### Label CRUD

- `POST /:boardId/labels` — create label (201)
- `PUT /:boardId/labels/:labelId` — update label (200)
- `DELETE /:boardId/labels/:labelId` — delete label (200)

### Card CRUD + Move

- `POST /:boardId/columns/:columnId/cards` — create card, sets `createdByUserId` from auth (201)
- `PUT /:boardId/cards/:cardId` — update title/body/labels, sets `lastEditedByUserId` (200)
- `POST /:boardId/cards/:cardId/move` — move card to column + position via `kanbanCardMoveSchema` (200)
- `DELETE /:boardId/cards/:cardId` — delete card (200)

### Position Calculation (card move)

- `afterCardId = null` → position = first card's position / 2 (or 1.0 if empty column)
- `afterCardId` is last card → position = last card's position + 1.0
- `afterCardId = X` → position = midpoint of X and next card
- If gap < 0.001, rebalance all positions in column to 1.0, 2.0, 3.0... in a transaction

---

## 4. AI Agent Tools

**New file**: `apps/backend/src/tools/kanban.ts`

Factory function `createKanbanTools(workspaceId: string, agentId: string)` returns six tools:

| Tool            | Description                                                |
| --------------- | ---------------------------------------------------------- |
| `listBoards`    | List all boards in the workspace                           |
| `getBoardState` | Get full board state (columns + cards + labels)            |
| `createCard`    | Create a card in a column (sets `createdByAgentId`)        |
| `updateCard`    | Update card title/body/labels (sets `lastEditedByAgentId`) |
| `moveCard`      | Move card to column/position (sets `lastEditedByAgentId`)  |
| `deleteCard`    | Delete a card                                              |

### Registration

**File**: `apps/backend/src/tools/index.ts`

Register as a static tool set placeholder `"kanban"` with `registerToolSet()` so it appears in the tools list. The actual tool instances are created dynamically at chat-execution time (like schedule tools) because they need `workspaceId` and `agentId` context.

Update chat execution to inject kanban tools when agent's `toolSetIds` includes `"kanban"`. Follow the same pattern used for schedule tools in `apps/backend/src/services/chat-execution.ts`.

---

## 5. Frontend

### Install Dependencies

```
pnpm --filter frontend add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

### New Pages

```
apps/frontend/app/[orgId]/workspace/[workspaceId]/boards/
  page.tsx                    — board list (grid of cards linking to each board)
  create/page.tsx             — create board form
  [boardId]/
    page.tsx                  — the kanban board (full viewport, horizontal scroll)
    settings/page.tsx         — board settings: rename, manage columns, manage labels, delete
```

### New Components

| Component                  | Purpose                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `kanban-board.tsx`         | Top-level: DndContext, SortableContext for columns, DragOverlay with motion animation |
| `kanban-column.tsx`        | Single column: header, SortableContext for cards, add card button                     |
| `kanban-card.tsx`          | Card: useSortable, displays title + label badges. Click opens dialog.                 |
| `kanban-card-dialog.tsx`   | Modal for viewing/editing a card (title, markdown body, labels, attribution info)     |
| `kanban-label-badge.tsx`   | Small colored chip showing label name                                                 |
| `kanban-board-form.tsx`    | Create/edit board form (name, description)                                            |
| `kanban-label-manager.tsx` | CRUD for labels in board settings                                                     |

### Drag-and-Drop Architecture

- `DndContext` wraps the board with `closestCorners` collision detection
- Outer `SortableContext` (horizontal) for columns
- Inner `SortableContext` (vertical) per column for cards
- `DragOverlay` renders a `motion.div` with `rotate: 2deg`, `scale: 1.04`, elevated box-shadow for the 3D lift effect
- `PointerSensor` with `activationConstraint: { distance: 5 }` to prevent accidental drags
- Optimistic local state during drag; API call on `onDragEnd`; revert on error

### Sidebar Navigation

**File**: `apps/frontend/components/app-sidebar.tsx`

Add to `footerItems` array:

```typescript
{
  title: "Boards",
  url: `/${orgId}/workspace/${workspaceId}/boards`,
  icon: KanbanSquare
}
```

---

## 6. Implementation Order

1. Shared schemas (`packages/schemas/index.ts`)
2. Database schema (`apps/backend/src/db/schema.ts`) + `pnpm drizzle-kit-push`
3. Backend routes (`apps/backend/src/routes/kanban.ts`) + mount in `server.ts`
4. AI tools (`apps/backend/src/tools/kanban.ts`) + register in `index.ts` + wire into chat execution
5. Install frontend DnD deps
6. Frontend components (leaf to root): label badge → card → column → board → card dialog
7. Frontend pages: board list → create → board page → settings
8. Sidebar nav update
9. All tests
10. Bruno API collection files (`apps/backend/bruno/`)

---

## 7. Verification & Testing

### Schema Tests (`packages/schemas/kanban.test.ts`)

- `safeParse` tests for all kanban schemas (valid + invalid inputs)
- Test `kanbanCardMoveSchema` with null/string `afterCardId`
- Test hex color regex on label schema

### Backend Route Tests (`apps/backend/src/routes/kanban.test.ts`)

Following existing pattern with mock db from `test-utils.ts`:

- Auth (401), access control (403), validation (400), happy paths for all endpoints
- Board state endpoint returns correct nested structure
- Card move calculates correct position
- Column reorder assigns sequential positions
- Card creation sets `createdByUserId` from auth context

### AI Tool Tests (`apps/backend/src/tools/kanban.test.ts`)

- Unit test each tool's `execute` with mock db
- Verify `createdByAgentId`/`lastEditedByAgentId` attribution
- Verify workspace scoping (tools only access boards in their workspace)

### Frontend Component Tests

- `kanban-board.test.tsx` — cards render in correct columns, column headers visible
- `kanban-card.test.tsx` — title renders, labels display, click triggers dialog

### Manual End-to-End Verification

1. `pnpm dev` → create a board via UI → add columns → add cards → drag cards between columns
2. Verify 3D lift animation on drag
3. Create an agent with `kanban` toolset → chat with agent → ask it to create/move cards
4. Verify attribution shows correctly (human vs agent)
5. Run `pnpm test` — all new and existing tests pass
6. Run `pnpm build` — no type errors

---

## 8. Modified Files Summary

- `packages/schemas/index.ts`
- `apps/backend/src/db/schema.ts`
- `apps/backend/src/server.ts`
- `apps/backend/src/tools/index.ts`
- `apps/backend/src/services/chat-execution.ts`
- `apps/frontend/components/app-sidebar.tsx`
- `apps/frontend/package.json`
- `pnpm-lock.yaml`

## 9. New Files

### Backend

- `apps/backend/src/routes/kanban.ts`
- `apps/backend/src/tools/kanban.ts`

### Frontend Components

- `apps/frontend/components/kanban-board.tsx`
- `apps/frontend/components/kanban-column.tsx`
- `apps/frontend/components/kanban-card.tsx`
- `apps/frontend/components/kanban-card-dialog.tsx`
- `apps/frontend/components/kanban-label-badge.tsx`
- `apps/frontend/components/kanban-board-form.tsx`
- `apps/frontend/components/kanban-label-manager.tsx`

### Frontend Pages

- `apps/frontend/app/[orgId]/workspace/[workspaceId]/boards/page.tsx`
- `apps/frontend/app/[orgId]/workspace/[workspaceId]/boards/create/page.tsx`
- `apps/frontend/app/[orgId]/workspace/[workspaceId]/boards/[boardId]/page.tsx`
- `apps/frontend/app/[orgId]/workspace/[workspaceId]/boards/[boardId]/settings/page.tsx`
