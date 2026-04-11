# Support Multiple Webhooks per Workspace

## Context

Currently, each workspace can only have one webhook (enforced by a `UNIQUE` constraint on `workspace_id` in the `webhook` table). This change lifts that restriction so workspaces can have multiple webhooks, each independently configured with its own URL, events, headers, and signing secret. The implementation follows the existing providers/MCP CRUD pattern (list page → create page → edit page).

## 1. Database Schema

**File:** `apps/backend/src/db/schema.ts` (lines 532–561)

- Remove `.unique()` from the `workspaceId` column (line 542)
- Add a `name` column: `name: t.text("name").notNull().default("Webhook")`
- Update comment from "one per workspace" to "multiple per workspace"
- Keep the existing `idx_webhook_workspace_id` index (still needed for list queries)
- Run `pnpm drizzle-kit-push` after the change

## 2. Shared Schemas

**File:** `packages/schemas/index.ts` (lines 908–962)

- Add `name: z.string().min(1).max(100)` to `webhookSchema`
- Add `name: z.string().min(1).max(100)` to `webhookCreateSchema`
- Add `name: z.string().min(1).max(100).optional()` to `webhookUpdateSchema`

## 3. Backend Routes

**File:** `apps/backend/src/routes/webhook.ts`

Rewrite to use `:webhookId` params, following the provider/agent pattern (`and(eq(id), eq(workspaceId))`):

| Method                               | Path                            | Description                  |
| ------------------------------------ | ------------------------------- | ---------------------------- |
| GET `/`                              | List all webhooks for workspace | Returns `{ results: [...] }` |
| POST `/`                             | Create a new webhook            | No 409 check needed anymore  |
| GET `/:webhookId`                    | Get single webhook              |                              |
| PUT `/:webhookId`                    | Update webhook                  |                              |
| DELETE `/:webhookId`                 | Delete webhook                  |                              |
| POST `/:webhookId/regenerate-secret` | Regenerate signing secret       |                              |

- Import `and` from `drizzle-orm`
- Remove the 409/unique-constraint error handling from POST
- Include `name` in create and update payloads
- All single-resource routes filter by `and(eq(webhookTable.id, webhookId), eq(webhookTable.workspaceId, workspaceId))`

**File:** `apps/backend/src/server.ts` (line 130)

- Change route mount from `/webhook` to `/webhooks`

## 4. Webhook Delivery Service

**File:** `apps/backend/src/services/webhook-delivery.ts`

- Remove `.limit(1)` from the query (line 89)
- Replace single-webhook logic with a loop over all webhooks
- Construct the JSON body once, compute HMAC signature per-webhook (each has its own `signingSecret`)
- Fire each `deliverWebhook()` independently (parallel, fire-and-forget) so one failure doesn't block others
- `dispatchWebhook(workspaceId, event, data)` signature stays the same — callers unchanged

## 5. Frontend

### 5a. New list component

**Create:** `apps/frontend/components/webhooks-list.tsx`

Follow `providers-list.tsx` pattern:

- SWR fetch from `/organizations/${orgId}/workspaces/${workspaceId}/webhooks`
- Expect `{ results: Webhook[] }` response
- Render each webhook using `Item`/`ItemTitle`/`ItemContent` components with name as title, URL as subtitle
- Show enabled/disabled indicator
- Link items to `/${orgId}/workspace/${workspaceId}/settings/webhooks/${webhook.id}`
- "Add webhook" button linking to `.../webhooks/create`
- Empty state when no webhooks exist

### 5b. Update webhook form

**Modify:** `apps/frontend/components/webhook-form.tsx`

- Add `name` text input field at top of form
- Change props: replace `webhook?: Webhook` + `onMutate` with `webhookId?: string` (edit mode fetches its own data via SWR, matching `provider-form.tsx` pattern)
- Update all API URLs from `/webhook` to `/webhooks/${webhookId}` (edit) or `/webhooks` (create)
- Include `name` in `buildPayload()`
- On successful create → redirect to webhooks list
- On successful delete → redirect to webhooks list
- Add `name` to the local `Webhook` interface

### 5c. Delete old settings component

**Delete:** `apps/frontend/components/webhook-settings.tsx`

No longer needed — replaced by the list page + form pattern.

### 5d. Pages

**Delete** existing: `apps/frontend/app/[orgId]/workspace/[workspaceId]/settings/webhook/page.tsx`

**Create** three new pages (following providers pattern exactly):

1. `apps/frontend/app/[orgId]/workspace/[workspaceId]/settings/webhooks/page.tsx` — renders `WebhooksList`
2. `apps/frontend/app/[orgId]/workspace/[workspaceId]/settings/webhooks/create/page.tsx` — renders `WebhookForm` with `BackButton`
3. `apps/frontend/app/[orgId]/workspace/[workspaceId]/settings/webhooks/[webhookId]/page.tsx` — renders `WebhookForm` with `webhookId` prop and `BackButton`

### 5e. Sidebar menu

**Modify:** `apps/frontend/components/workspace-settings-menu.tsx`

- Change `webhookHref` from `.../settings/webhook` to `.../settings/webhooks`
- Change label from "Webhook" to "Webhooks"

## 6. Tests

### Backend route tests

**Modify:** `apps/backend/src/routes/webhook.test.ts`

- Update `baseUrl` from `/webhook` to `/webhooks`
- GET `/` now returns `{ results: [...] }` (200), not a single object or 404
- Remove the 409 conflict test
- Add `name` to all test payloads
- Add tests for `GET /:webhookId`, `PUT /:webhookId`, `DELETE /:webhookId`, `POST /:webhookId/regenerate-secret`
- Add 404 tests for non-existent webhook IDs

### Delivery service tests

**Modify:** `apps/backend/src/services/webhook-delivery.test.ts`

- Update mock chain: remove `.limit` (the query no longer uses `.limit(1)`)
- Add test: delivers to multiple webhooks (mock returns 2, verify 2 fetch calls with different signatures)
- Add test: skips webhooks not subscribed to the event
- Add test: continues delivery when one webhook fails
- Update existing tests for new mock structure

## Verification

1. Run `pnpm dev` and `pnpm drizzle-kit-push` to apply schema changes
2. Run `pnpm test` — all tests should pass
3. In the UI, navigate to workspace settings → Webhooks
4. Verify empty state is shown for a workspace with no webhooks
5. Create a first webhook with a name, URL, and selected events
6. Create a second webhook — confirm both appear in the list
7. Click into a webhook to verify edit form loads correctly
8. Test delete, regenerate secret, enable/disable
9. Verify webhook delivery still works (create a notification and confirm both webhooks receive events)
