# Plan: Migrate Kanban Labels from Dedicated Table to JSONB + Unified Board Form

## Context

The kanban board feature currently stores labels in a dedicated `kanban_label` database table with separate CRUD API endpoints. This is over-engineered given that boards will only ever have a handful of labels. Additionally, the board settings page has a fragmented UX: the board form (name/description) has its own "Save Changes" button, while labels are managed independently below it via inline create/edit/delete operations. The user wants:

1. **Labels as JSONB on `kanban_board`** — eliminate the `kanban_label` table entirely, store labels as a JSONB array on the board record
2. **Unified board form** — a single form with one "Save" button for name, description, AND labels
3. **Fixed color palette** — users pick from a predefined set of colors instead of typing hex values

---

## 1. Define Color Palette Constant

**File**: `packages/schemas/index.ts`

Add a shared constant for the label color palette (used by both frontend and backend validation):

```typescript
export const KANBAN_LABEL_COLORS = [
  { name: "Red", value: "#ef4444" },
  { name: "Orange", value: "#f97316" },
  { name: "Amber", value: "#f59e0b" },
  { name: "Green", value: "#22c55e" },
  { name: "Teal", value: "#14b8a6" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Indigo", value: "#6366f1" },
  { name: "Purple", value: "#a855f7" },
  { name: "Pink", value: "#ec4899" },
  { name: "Gray", value: "#6b7280" },
] as const;
```

---

## 2. Update Shared Schemas

**File**: `packages/schemas/index.ts`

### Replace label schemas

Remove `kanbanLabelSchema`, `kanbanLabelCreateSchema`, `kanbanLabelUpdateSchema`, and the `hexColorRegex`.

Add an inline label schema:

```typescript
export const kanbanLabelSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(50),
  color: z.enum(KANBAN_LABEL_COLORS.map(c => c.value) as [string, ...string[]]),
});

export type KanbanLabel = z.infer<typeof kanbanLabelSchema>;
```

Note: the label schema no longer has `boardId`, `createdAt`, or `updatedAt` — it's just an embedded object.

### Update board schemas

Add `labels` to `kanbanBoardSchema`:

```typescript
export const kanbanBoardSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  labels: z.array(kanbanLabelSchema).default([]),
  createdAt: z.date(),
  updatedAt: z.date(),
});
```

Update `kanbanBoardCreateSchema` and `kanbanBoardUpdateSchema` to include `labels`:

```typescript
export const kanbanBoardCreateSchema = kanbanBoardSchema.pick({
  name: true,
  description: true,
  labels: true,
});

export const kanbanBoardUpdateSchema = kanbanBoardSchema.pick({
  name: true,
  description: true,
  labels: true,
});
```

### Update board state schema

Remove the top-level `labels` field from `kanbanBoardStateSchema` — labels now come from `board.labels`:

```typescript
export const kanbanBoardStateSchema = z.object({
  board: kanbanBoardSchema,
  columns: z.array(
    kanbanColumnSchema.extend({
      cards: z.array(kanbanCardSchema),
    }),
  ),
});

export type KanbanBoardState = z.infer<typeof kanbanBoardStateSchema>;
```

---

## 3. Update Database Schema

**File**: `apps/backend/src/db/schema.ts`

- **Delete** the entire `kanbanLabel` table definition and its export
- **Add** a `labels` JSONB column to `kanbanBoard`:

```typescript
labels: t.jsonb("labels").$type<{ id: string; name: string; color: string }[]>().notNull().default([]),
```

After editing, run `pnpm drizzle-kit-push`.

---

## 4. Update Backend Routes

**File**: `apps/backend/src/routes/kanban.ts`

### Remove

- Remove import of `kanbanLabel` from schema and `kanbanLabelCreateSchema`/`kanbanLabelUpdateSchema` from schemas
- **Delete** all three label CRUD routes: `POST /:boardId/labels`, `PUT /:boardId/labels/:labelId`, `DELETE /:boardId/labels/:labelId`

### Update board create (`POST /`)

The `kanbanBoardCreateSchema` now includes `labels`, so the create route will automatically accept labels in the request body. No additional changes needed — the `...data` spread already includes labels.

### Update board update (`PUT /:boardId`)

Same as create — the `kanbanBoardUpdateSchema` now includes `labels`, which will be spread into the update set.

### Update board state (`GET /:boardId/state`)

- Remove the labels query (`db.select().from(kanbanLabelTable)...`)
- Remove `labels` from the response — the board record itself now contains `labels`
- The response shape changes: `{ board, columns }` (no separate `labels` array)

---

## 5. Update AI Tools

**File**: `apps/backend/src/tools/kanban.ts`

- Remove import of `kanbanLabel` from schema
- In `getBoardState` tool: remove the labels query. Labels are now part of `boardRecord[0].labels`. Update the return to include labels from the board record:

```typescript
return {
  board: boardRecord[0],
  columns: columnsWithCards,
  labels: boardRecord[0].labels, // labels come from board now
};
```

(Keep `labels` in the tool response for backward compatibility with AI agents that reference it.)

---

## 6. Update Frontend: Unified Board Form

**File**: `apps/frontend/components/kanban-board-form.tsx`

Rewrite this component to include label management inline:

- Add state for `labels` array (each: `{ id, name, color }`)
- When editing, initialize from `board.labels`
- **Label section**: show existing labels as rows, each with a text input for name and a color picker (clickable palette swatches), plus a delete button. Below, an "Add Label" button that appends a new empty label with a default color and auto-generated nanoid.
- **Single submit button** at the bottom that POSTs/PUTs `{ name, description, labels }` to the backend

Form layout (top to bottom):
1. Name field
2. Description field
3. Labels section header
4. List of label rows (name input + color palette + delete button)
5. "Add Label" button
6. Submit button ("Create Board" or "Save Changes")

Install `nanoid` in the frontend for generating label IDs client-side:
```
pnpm --filter frontend add nanoid
```

---

## 7. Update Frontend: Board Settings Page

**File**: `apps/frontend/app/[orgId]/workspace/[workspaceId]/boards/[boardId]/settings/page.tsx`

- Remove import and usage of `KanbanLabelManager`
- Pass `board.labels` (from `data.board.labels`) into `KanbanBoardForm` via the existing `board` prop (extend the prop type to include `labels`)
- The form now handles everything atomically

---

## 8. Update Frontend: Board Create Page

**File**: `apps/frontend/app/[orgId]/workspace/[workspaceId]/boards/create/page.tsx`

No changes needed — the form starts with empty labels by default.

---

## 9. Update Frontend: Board Component Label References

**File**: `apps/frontend/components/kanban-board.tsx`

Update the label source from `data?.labels ?? []` to `data?.board.labels ?? []`, since labels are no longer a separate top-level field in the board state response.

---

## 10. Update Frontend: Card Dialog Label Type

**File**: `apps/frontend/components/kanban-card-dialog.tsx`

The `KanbanLabel` type is changing (no longer has `boardId`, `createdAt`, `updatedAt`), but the dialog only uses `id`, `name`, and `color` — so it should work without changes to the component logic. Verify the import type is still valid.

---

## 11. Delete Unused Files/Components

- **Delete** `apps/frontend/components/kanban-label-manager.tsx` — fully replaced by the inline label section in `kanban-board-form.tsx`

---

## 12. Update Tests

### Schema tests (`packages/schemas/kanban.test.ts` — if exists)
- Update label schema tests to validate the new inline structure
- Add tests for color enum validation (only palette colors accepted)

### Backend route tests (`apps/backend/src/routes/kanban.test.ts`)
- **Remove** all label CRUD test blocks (`POST /:boardId/labels`, `PUT /:boardId/labels/:labelId`, `DELETE /:boardId/labels/:labelId`)
- **Update** board state test to not expect a separate `labels` array in response
- **Update** board create/update tests to include `labels` in the request body

---

## Files Modified

| File | Change |
|------|--------|
| `packages/schemas/index.ts` | Add color palette, refactor label schema to inline, update board schemas, update board state schema |
| `apps/backend/src/db/schema.ts` | Delete `kanbanLabel` table, add `labels` JSONB to `kanbanBoard` |
| `apps/backend/src/routes/kanban.ts` | Delete label CRUD routes, update board state endpoint |
| `apps/backend/src/tools/kanban.ts` | Remove label table query, read labels from board record |
| `apps/backend/src/routes/kanban.test.ts` | Remove label CRUD tests, update board state tests |
| `apps/frontend/components/kanban-board-form.tsx` | Rewrite to include inline label management with color palette |
| `apps/frontend/components/kanban-board.tsx` | Update label source from `data.labels` to `data.board.labels` |
| `apps/frontend/app/[orgId]/workspace/[workspaceId]/boards/[boardId]/settings/page.tsx` | Remove `KanbanLabelManager`, pass labels via board prop |
| `apps/frontend/components/kanban-label-manager.tsx` | **Delete** |
| `apps/frontend/package.json` | Add `nanoid` dependency |

---

## Verification

1. Run `pnpm drizzle-kit-push` to apply schema changes
2. Run `pnpm test` — all tests pass
3. Run `pnpm build` — no type errors
4. Manual: create a new board with labels via the create form, verify labels persist
5. Manual: edit a board, add/remove/rename labels, change colors via palette, verify single Save works
6. Manual: verify cards still display labels correctly on the board
7. Manual: verify card dialog label toggling still works
8. Manual: test AI agent `getBoardState` tool returns labels correctly
