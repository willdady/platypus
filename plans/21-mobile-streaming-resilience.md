# Mobile Streaming Resilience

## Context

Chat streams frequently fail when the user backgrounds the browser on mobile, most notably Chrome on Android. The failure is most painful when the main agent has delegated to a sub-agent and the response takes 30+ seconds: the user switches apps, returns, and finds a stuck/incomplete assistant message with no way to recover the work that was done on the server.

### Why it happens

The trigger is **Chrome Android's deliberate backgrounding behavior**, which is unavoidable from our code:

- Chrome stops loading and resource fetching for tabs whose renderer has been in the background for ~5 minutes (StopLoadingInBackground feature).
- JavaScript timers in backgrounded tabs are throttled to once per minute after 5 minutes (intensive throttling, Chrome 88+).
- Under memory pressure on mobile devices, Chrome can discard the renderer entirely with no graceful close.
- Plain `fetch` streams (SSE) are **not** in the exemption list — only audio playback, WebSockets, and WebRTC connections are exempt from throttling.

When Chrome kills the SSE socket, our current architecture treats it as fatal:

1. **`apps/backend/src/routes/chat.ts:356`** — the LLM is invoked with `abortSignal: c.req.raw.signal`. The moment Hono notices the client is gone, the LLM call (and any in-flight tool/sub-agent execution) is cancelled mid-step.
2. **`apps/backend/src/routes/chat.ts:390`** — the chat record is only persisted in `onFinish`, which only fires on graceful completion. Aborted streams write nothing to the DB. All sub-agent activity that ran for 30 seconds is thrown away.
3. **`apps/frontend/components/chat.tsx:160-201`** — the frontend uses `DefaultChatTransport` with no `resume`, no reconnect endpoint, no `visibilitychange` listener, and no retry. Even the AI SDK's built-in `resume: true` would only resume on full remount, not on tab visibility change ([vercel/ai #11865](https://github.com/vercel/ai/issues/11865)).

This is not a bug in any single line of code — it's an architecture that assumes the client stays connected for the entire response. On mobile that assumption breaks routinely.

### Goal

Make a backgrounded mobile browser a **non-event**: the server keeps working, persists progress, and when the user returns the answer is just there. We are deliberately **not** building a Redis-backed live-token resumption system — that's a much larger project for marginal extra benefit.

### Scope (in / out)

**In scope**

1. Decouple the LLM execution from the client connection — server keeps running on disconnect.
2. Persist incremental progress to the DB during the stream, not just on `onFinish`.
3. Frontend reconciliation on tab return (visibility change, online).

**Out of scope**

- Live token-by-token resumption to a returning client (would require Redis + custom transport).
- Switching the SSE protocol or migrating to WebSocket.
- Any change to sub-agent internals.

## 1. Decouple client disconnect from LLM execution

**File:** `apps/backend/src/routes/chat.ts`

Currently the request's raw abort signal is wired straight through to `streamText`:

```ts
// Line 356 — current
abortSignal: c.req.raw.signal,
```

This means _any_ client disconnect cancels the LLM. Replace it with an internal `AbortController` that is **not** triggered by the client connection dropping:

```ts
const llmController = new AbortController();

// Replace line 356
abortSignal: llmController.signal,
```

The MCP cleanup listener at `chat.ts:309-313` also needs to change — it currently closes MCP clients on client disconnect, which would be premature now:

```ts
// REMOVE the addEventListener block at lines 309-313.
// MCP cleanup already happens in onFinish (line 392-393); that's enough.
```

**Result:** when the SSE socket dies (Chrome backgrounds the tab, network drops, user closes the tab), the LLM, tools, and sub-agents keep running. `streamText` writes into a stream that no one is reading; that's harmless — `toUIMessageStreamResponse` handles a closed downstream gracefully, and `onFinish` will still fire when the model completes.

### Stop button still needs to work

The frontend `stop()` button must still be able to cancel a running LLM. Add a new endpoint:

**Route:** `POST /organizations/:orgId/workspaces/:workspaceId/chat/:chatId/stop`

To plumb cancellation across the disconnected boundary, keep a per-chat map of active controllers:

```ts
// Module-level in chat.ts
const activeChatControllers = new Map<string, AbortController>();
```

In the POST handler, just before `streamText`:

```ts
// Cancel any prior in-flight stream for this chat (e.g. if user retries fast)
activeChatControllers.get(data.id)?.abort();
activeChatControllers.set(data.id, llmController);
```

In `onFinish` (and an `onError` equivalent), clear the map entry. The stop endpoint looks up the controller by `chatId` and calls `.abort()`. If no controller exists, it 204s — the stream already finished.

**Frontend wiring** (`apps/frontend/components/chat.tsx`): wrap `stop` so it both calls the AI SDK's local `stop()` (to detach the local fetch reader) **and** fires a `POST` to the new endpoint. The local stop alone is no longer enough because the server is now decoupled from the connection.

### Surviving server restarts

A server restart (deploy, crash) will still kill in-flight streams — that's fine, we're not aiming for zero data loss, just the common case of mobile backgrounding. Document this limit in a comment at the controller-map declaration.

## 2. Incremental message persistence

**File:** `apps/backend/src/routes/chat.ts`

`onFinish` is currently the only write path. If a stream errors or the LLM is stopped mid-flight, partial output and sub-agent activity are lost.

### 2a. Schema additions

**File:** `apps/backend/src/db/schema.ts` (chat table, lines 114-157)

Add two columns:

```ts
streamStatus: t.text("stream_status").default("idle"), // "idle" | "streaming" | "complete" | "error" | "stopped"
streamUpdatedAt: t.timestamp("stream_updated_at"),
```

Run `pnpm drizzle-kit-push` after the change.

The existing `messages` jsonb column is reused — no separate "partial" column. A consumer reading the chat at any time gets the latest snapshot; `streamStatus` tells them whether more is coming.

### 2b. Stream-side persistence

`toUIMessageStreamResponse` does not expose per-step progress directly. The simplest correct approach is to use `streamText`'s callbacks. Add to the `streamText` options at `chat.ts:350-358`:

```ts
const result = streamText({
  model: model as any,
  messages: await convertToModelMessages(inlinedMessages),
  stopWhen: [stepCountIs(resolvedMaxSteps)],
  tools,
  system: systemPrompt,
  abortSignal: llmController.signal,
  onStepFinish: async ({ stepType }) => {
    // Persist after each completed step (text generation, tool call, tool result).
    // We re-derive the current message array from result.response.messages —
    // see "Snapshotting in-progress messages" below.
    await persistInProgress(
      data.id,
      orgId,
      workspaceId,
      await result.response,
      "streaming",
      context,
      config,
      data,
    );
  },
  ...restConfig,
});
```

Also persist once at stream start (before any tokens flow) so the user's prompt is saved even if the first model call fails:

```ts
await persistInProgress(
  data.id,
  orgId,
  workspaceId,
  { messages },
  "streaming",
  context,
  config,
  data,
);
```

### 2c. Snapshotting in-progress messages

The AI SDK exposes the rolling response via `result.response.messages` (a `Promise<ModelMessage[]>` that resolves to the full conversation as messages complete). For per-step persistence we want UI messages, not model messages, to keep the wire format consistent with what the frontend already loads.

Build a small helper next to `upsertChatRecord`:

```ts
const persistInProgress = async (
  id: string,
  orgId: string,
  workspaceId: string,
  snapshot: { messages: PlatypusUIMessage[] }, // UI messages
  streamStatus: "streaming" | "complete" | "error" | "stopped",
  context: ChatContext,
  config: GenerationConfig,
  data: ChatSubmitData,
) => {
  /* same body shape as upsertChatRecord, plus streamStatus + streamUpdatedAt */
};
```

The cleanest way to get UI messages mid-stream is to capture them via the existing `originalMessages` + a custom `onChunk` accumulator. Alternative: keep `onStepFinish` but only persist the **input** messages plus an `assistant` placeholder marked `pending` — this is much simpler and good enough for the recovery UX. **Recommendation:** start with the simpler approach (placeholder), add proper accumulation in a follow-up if the placeholder UX is insufficient.

### 2d. Final persistence

Update `onFinish` (currently lines 390-408) to also set `streamStatus: "complete"` and `streamUpdatedAt: new Date()`. Add an `onError` (or wrap in try/catch around the stream) that writes `streamStatus: "error"` with whatever messages exist so far.

For a stop request triggered via the new endpoint in §1, the controller's abort will surface as an error in the AI SDK; handle it specifically and write `"stopped"`.

### 2e. Schema export

**File:** `packages/schemas/index.ts`

Add `streamStatus` and `streamUpdatedAt` to `chatSchema` so the frontend has a typed view:

```ts
streamStatus: z.enum(["idle", "streaming", "complete", "error", "stopped"]).optional(),
streamUpdatedAt: z.coerce.date().optional(),
```

## 3. Frontend visibility reconciliation

**File:** `apps/frontend/components/chat.tsx`

When the user returns to a backgrounded tab, the local `useChat` state is stale (its fetch stream died). We don't try to re-attach to a live stream — instead we re-fetch the persisted chat and let the user see the most recent server-side state.

### 3a. Re-fetch on visibility / online

Add an effect that listens for `visibilitychange` and `online`. When the tab becomes visible or the network reconnects **and** the local status is in `streaming`/`submitted`/`error`, re-fetch the chat record:

```ts
useEffect(() => {
  const onMaybeReturn = () => {
    if (document.visibilityState !== "visible") return;
    if (
      statusRef.current !== "streaming" &&
      statusRef.current !== "submitted" &&
      !error
    )
      return;
    mutate(
      joinUrl(
        backendUrl,
        `/organizations/${orgId}/workspaces/${workspaceId}/chat/${chatId}`,
      ),
    );
  };
  document.addEventListener("visibilitychange", onMaybeReturn);
  window.addEventListener("online", onMaybeReturn);
  return () => {
    document.removeEventListener("visibilitychange", onMaybeReturn);
    window.removeEventListener("online", onMaybeReturn);
  };
}, [backendUrl, orgId, workspaceId, chatId, error]);
```

`mutate` is already imported indirectly via `useSWR`; pull it from `swr`.

### 3b. Reconcile local state with persisted state

The existing hydrate effect at `chat.tsx:304-313` only runs when local status is **not** streaming. After a backgrounding event the local status will still be `"streaming"` (the fetch is dead but the hook didn't know), so that guard stops it from refreshing.

Refine the guard to also accept the case where the persisted chat reports `streamStatus === "complete"` or `"error"`/`"stopped"` while the local status is still `"streaming"`:

```ts
useEffect(() => {
  if (!chatData?.messages || chatData.messages.length === 0) return;

  const localIsActive =
    statusRef.current === "streaming" || statusRef.current === "submitted";
  const serverIsDone =
    chatData.streamStatus &&
    chatData.streamStatus !== "streaming" &&
    chatData.streamStatus !== "idle";

  if (!localIsActive || serverIsDone) {
    setMessages(chatData.messages);
    // Reset useChat's status by sending a no-op? — simpler: rely on next user action,
    // and add a banner showing "Server finished while you were away" if serverIsDone && localIsActive.
  }
}, [chatData, setMessages]);
```

When `serverIsDone && localIsActive`, the local hook still thinks it's streaming. The cleanest reset is to call `stop()` (which is idempotent and just closes the local reader) — this transitions status back to `"ready"` without firing any new request.

### 3c. UX affordance

When we detect the server finished while the tab was hidden, show a brief toast — e.g. "Response completed while you were away" — so the user understands why the message just appeared. Reuse the existing `sonner` toast.

### 3d. Stop button update

As described in §1, the existing stop call must also fire the new server-side stop endpoint:

```ts
const handleStop = useCallback(async () => {
  stop(); // local
  await fetch(
    joinUrl(
      backendUrl,
      `/organizations/${orgId}/workspaces/${workspaceId}/chat/${chatId}/stop`,
    ),
    { method: "POST", credentials: "include" },
  ).catch(() => {
    /* best-effort */
  });
}, [backendUrl, orgId, workspaceId, chatId, stop]);
```

Replace the call at line 389 (`return stop()`) with `return handleStop()`.

## 4. Tests

### Backend

**File:** `apps/backend/src/routes/chat.test.ts` (or new file if structure differs)

- `POST /chat` writes `streamStatus: "streaming"` to the DB before the first model token.
- Per-step persistence: the chat record's `messages` length grows across `onStepFinish` boundaries (use a fake/short-running model).
- Client disconnect mid-stream: simulate by aborting the request's reader; assert `streamText` continues (mock the model with a delayed resolve), `onFinish` still fires, and the final `streamStatus` is `"complete"`.
- New `POST /chat/:chatId/stop` endpoint: aborts an in-flight controller, returns 204; chat record ends with `streamStatus: "stopped"`.
- Stop on a chat with no active controller: returns 204, no error.
- Server restart simulation: clear the controller map; existing chats are unaffected.

### Frontend

**File:** `apps/frontend/components/chat.test.tsx` (or hook-level test)

- `visibilitychange → visible` while local status is `streaming` triggers a chat re-fetch.
- `online` event triggers a re-fetch.
- Reconciliation effect resets local messages when `chatData.streamStatus === "complete"` and local status is `streaming`.
- Stop button calls both local `stop()` and the new server endpoint.

## 5. Verification (manual)

1. Run `pnpm dev` and `pnpm drizzle-kit-push`.
2. Run `pnpm test` — all green.
3. **Desktop sanity:** start a long sub-agent task (use the slowest available agent + a multi-step task). Confirm streaming still works end-to-end.
4. **Stop button:** start a long task, click stop. Confirm the server log shows the abort, the chat persists with `streamStatus: "stopped"`, and the partial assistant message is preserved.
5. **Mobile golden path** (Chrome Android):
   - Start a long task that delegates to a sub-agent (target: ≥30 seconds).
   - Switch to a different app for 30 seconds, then return. Expect: assistant message updates to the latest server-side state without a page reload.
   - Switch apps for >5 minutes (force the StopLoadingInBackground threshold). Return. Expect: full final response visible, even though the stream died — toast shows "Response completed while you were away".
   - Lock the phone for 30 seconds during a stream. Unlock. Expect: same as above.
6. **Mobile network drop:** start a stream, toggle airplane mode for 10 seconds, toggle off. Expect: the chat record reflects whatever progress the server made; if the LLM finished while offline, the final answer appears on `online` event.
7. **Tab close mid-stream:** start a stream, close the tab. Re-open the chat from the sidebar within 30 seconds. Expect: the assistant response continues to appear (server kept running), final message persisted.

## Notes / explicit non-goals

- We are **not** building Redis-backed live-token resumption. A returning user will see the latest persisted snapshot, not the live token feed. This is a deliberate cost/benefit choice — see [vercel/ai #11865](https://github.com/vercel/ai/issues/11865) and [#6502](https://github.com/vercel/ai/issues/6502) for the complications that approach introduces (incompatibility with `stop()`, doubled resumes in Strict Mode, stale data after stream end).
- Server restarts will still abort in-flight streams. If/when we deploy on a horizontally-scaled environment we'll need a shared abort channel (Redis pub/sub or similar) and a process-level "in-flight chat" registry. Out of scope for this plan.
- The LLM provider's API call has its own internal timeouts; if Chrome backgrounds for >10 minutes and the provider drops the upstream connection, that's a different failure mode and `onError` will catch it and persist `"error"`.
