# PLAN — Compaction context-ring fixes (#1 revert-on-refresh, #2 estimate-vs-actual, #3 effectiveness)

> Source branch: `feature/context-compaction-clean` (PR source). Deploy/test branch:
> `feature/test-deploy-306-261-168` (combined PRs, runs on `zaneta:/srv/platypus`).
> Written 2026-07-10. Investigation was against live chat `JYk7oF-DZTgOp3RS4zgM2`.

---

## ⛔ OPEN QUESTIONS — ANSWER THESE FIRST (they gate the work)

### Q1 — Scope for fix #2 (estimate vs actual)

- **(a) Anchor to actual (recommended)** — report post-compact "after" as
  `lastProviderActual − estimatedSaved` so badge/ring speak provider-actual units.
  Removes the systematic overhead gap. Backend change + test.
- **(b) Anchor + investigate overhead** — also dig into why `estimateOverheadTokens`
  reported ~440 vs the provider's multi-k system+tools overhead, and fix the
  under-count at source. More thorough, more work.
- **(c) Skip #2, do only #1** — just make the ring survive reload; leave the estimate
  as-is. The overhead optimism + next-turn jump remain.

**DECISION: (a) anchor to actual** — report post-compact "after" as `lastProviderActual −
estimatedSaved` so badge/ring speak provider-actual units. (2026-07-10)

### Q2 — What to do about #3 (compaction leaves large recent messages untouched)

- **(a) Leave as-is (by design)** — `keepRecentMessages` protecting recent turns is
  intended. Document it, no code change.
- **(b) Summarize oversized retained msgs** — let compaction also condense a very large
  post-watermark message. Policy change to the compaction algorithm; needs its own
  design + tests.
- **(c) Just tune the trigger** — keep recent messages verbatim but weight large recent
  messages toward the compaction trigger so it fires sooner. Smaller than resummarizing.
- **(d) Other** — user selected "Other" on 2026-07-10; intent not yet captured. Clarify
  before doing anything on #3.

**DECISION: (c)+(b) blend** — lower `keepRecentMessages` default 10 → 5 (tune the trigger), AND
extend the retained-message wall-trim to condense large _retained_ parts above a size gate —
**tool results _and_ assistant text** (the dominant content in this chat's "big code answers" case),
newest message exempt, only when the kept view would breach the hard window wall. Broader than
Anthropic's `clear_tool_uses` (which is tool-results-only), since the user's bulk is assistant prose;
view-only per §View, not delete (raw stays in the DB). Token/size-driven, not message-count driven.
(2026-07-10)

---

## What the user observed (live test, chat `JYk7oF-DZTgOp3RS4zgM2`)

1. Hit Compact → ring went ~22k → 19.5k.
2. Refreshed page → ring jumped **back** to ~22k.
3. Sent "test" (tiny) → quick reply → ring jumped to **25530**.

## Ground truth from the server (logs + DB)

- Compaction **fired and persisted correctly**: `compaction.fired tier=1 tokensBefore=21990
tokensAfter=19575 messagesDropped=5`. DB `chat` row has `context_summary` (1685 chars,
  coherent), `summary_watermark=zKCxBehYTacP97rr` (= msg 13, a user msg), `compaction_dirty=f`.
- Persisted messages (26 total). Per-assistant `metadata.stats.contextTokens`:
  - msg 23 `msg-RL7JjVTM`: **21395** (last real turn before compact; output 7283 — a big code answer)
  - msg 24 `msg-sX6YYiAV`: **no stats**, single part `tool-compact_context` (the force-compact trace)
  - msg 26 `msg-xLHvbgCl`: **25530** (the "test" reply; `Step finished inputTokens:25530`)
- Earlier big answers retained (after watermark): msg 16 (+8287), msg 21 (+8346), msg 23 (+7283).

## Root cause — one tension, two symptoms

Two different token numbers live in the UI:

- **Provider-actual** `metadata.stats.contextTokens` = model-reported `inputTokens` of the last
  real turn. What the ring normally shows; what the Tier-1 projection trusts.
- **Local char/4 estimate** `tokensAfter` / `estimatedTokens` = what compaction computes; what
  the badge shows.

**#1 revert-on-refresh** — the post-compact estimate lives ONLY in the `compacted` React state
(`apps/frontend/components/chat.tsx:467`). Refresh wipes it → ring `usedTokens` falls back to
`lastAssistantStats.contextTokens` (`chat.tsx:412`, `:797-801`). The trace message (msg 24) has
NO `stats`, so both `lastAssistantStats` and the backend `findLastInputTokens`
(`apps/backend/src/services/chat-execution.ts:683`) skip it → ring shows the last real turn (21395).

**#2 jump to 25.5k** — MOSTLY REAL, not a metric artifact. Baseline 21395 was the input BEFORE the
last big code answer (msg 23, 7283 tok) entered history. The "test" turn's actual input = summary +
retained msgs (incl. that 7.3k answer) + new msg. Compaction removed ~5k of OLD small messages, but
the big recent answer newly entered context, so the ring correctly rose. There IS a systematic
sub-component: the estimate omits system-prompt + tool-schema overhead (badge `overheadTokens=440`
vs the provider counting several k), so the badge under-promises — but fixing it will NOT make the
ring "stay at 19.5k"; content growth is legitimate.

**Connection to #3** — the reason compaction felt useless AND the ring jumped is the same: the large
recent code messages dominate and compaction doesn't touch them. #1/#2 are display-honesty fixes;
**#3 is the only real lever on effectiveness.**

---

## Fix #1 — ring survives reload (frontend-only, recommended)

The trace message already persists `output.tokensAfter` in its `tool-compact_context` part.

- In `apps/frontend/components/chat.tsx` (`lastAssistantStats` derivation ~L412 and/or the
  `usedTokens` expression ~L797), when scanning newest-first: if the newest assistant message
  carrying usable data is a compaction trace (part type `tool-compact_context`), read its
  `output.tokensAfter` for `usedTokens` and mark the tooltip "estimated after compaction".
- No backend/schema change. Does NOT poison `findLastInputTokens` (keeps skipping the trace,
  keeps using provider-actual). Add a frontend test (trailing trace message → ring uses tokensAfter).
- **Rejected alt:** writing `stats.contextTokens` onto the trace message — breaks the backend
  projection invariant that relies on the trace having no stats (`chat-execution.ts:674-694`).

## Fix #2 — make the estimate honest (pending Q1 decision)

If Q1 = (a) or (b): anchor the reported "after" to the last provider-actual baseline in
`forceCompactChat` / Tier-1 (`apps/backend/src/services/chat-execution.ts`):

- `tokensSaved = tokensBefore_est − tokensAfter_est` (a delta — overhead cancels, reliable).
- `displayedAfter = lastProviderActual − tokensSaved` (via `findLastInputTokens`);
  fall back to raw estimate when there's no prior actual (fresh chat / usage-less provider).
- Flows to both the live ring (`/compact` response `inputTokens`, `routes/chat.ts:489`) and the
  reloaded ring (trace `output.tokensAfter`), so both speak provider-actual units. Backend test.
- If Q1 = (b): also investigate `estimateOverheadTokens` (`apps/backend/src/runs/token-estimate.ts:516`)
  — why ~440 on the compaction path vs multi-k actual (is the real system prompt + tools passed in?).
- Honest caveat: removes the systematic gap, NOT turn-to-turn growth from new large messages.

## Fix #3 — effectiveness (pending Q2 decision; user chose "Other" — clarify intent first)

Watermark left the 3 large recent code answers (~8k each) untouched; compaction summarized only old
small messages. See Q2 options. Likely by-design (`keepRecentMessages`), but it's the real lever if
the goal is "compaction visibly reduces the ring".

---

## Sequencing / deploy

1. Implement on `feature/context-compaction-clean`.
2. Run locally before build: `pnpm --filter backend test` + `pnpm typecheck`; for the frontend
   change also `pnpm --filter @platypus/frontend build` (catches things tests miss).
3. Cherry-pick the commit(s) onto `feature/test-deploy-306-261-168`, push to `fork`.
4. Redeploy on `zaneta` — this time **both** images (frontend change):
   - `git merge --ff-only fork/feature/test-deploy-306-261-168`
   - `docker build -t willdady/platypus-backend:latest  -f apps/backend/Dockerfile .`
   - `docker build -t willdady/platypus-frontend:latest -f apps/frontend/Dockerfile .`
   - `docker compose up -d backend frontend`
   - verify `/health` 200, boot log clean, ring behavior on reload.

## Key file references

- Ring component: `apps/frontend/components/context-usage-ring.tsx` (presentational; takes `usedTokens`).
- Ring wiring / `compacted` state / `runCompact`: `apps/frontend/components/chat.tsx:412, 467, 472, 797`.
- Force-compact route: `apps/backend/src/routes/chat.ts:481-500` (returns `inputTokens=estimatedTokens`, `traceMessage`).
- Force-compact service: `apps/backend/src/services/chat-execution.ts` (`forceCompactChat`, `findLastInputTokens:683`).
- Trace message builder / payloads / CompactionTrace: `apps/backend/src/runs/compaction.ts:1114-1189`.
- Overhead estimate: `apps/backend/src/runs/token-estimate.ts:516`.
- Live in-turn trace (already fixed for flicker, commit 030735f): `apps/backend/src/runs/agent-runner.ts:597-712`.
