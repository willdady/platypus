# Plan: Chat Context Compaction & Usage Indicator

Status: **chunks 1-11 implemented (ALL DONE)** (1-2 reviewed 2026-06-09; chunks 3-5 landed 2026-06-10; chunks 6-8 landed 2026-06-11; chunk 11 landed 2026-06-12; see §Code review 2026-06-10) · Branch target: `feature/context-compaction`

> This doc is the spec to implement against, not a proposal. Sections A–J are the
> design. The **Drift log & code-review checklist** at the bottom records every
> flaw found during review and the trap to re-check once code exists — read it
> before coding and again at PR time. Do not re-derive the happy path and skip
> the failure modes; they are written down precisely so we do not drift into them
> twice.

## Implementation status & code review — chunks 1-2 (reviewed 2026-06-09)

Chunks **1** (window resolution + single estimator + schema) and **2** (compaction
module + `writeWatermark` CAS + Tier 1) are landed on `feature/context-compaction`
(post main v1.95.0 merge). Backend tests: 1037 pass; chunk 1-2 unit tests:
context-window 20, token-estimate 14, compaction (CAS/budget/pairing/invalidation)
all green. Source `tsc --noEmit` clean for these files. This section is the
**start point for chunk 3** — read it before coding.

### Solid / verified

- **CAS durable writer (P3 / R1 / T10)** — the hardest part is correct and
  well-tested. Single versioned writer (`commitWatermark`→`casWrite`,
  `compaction.ts:84-160`); all three mutations (advance / dirty-clear / C4 reset)
  route through it; loser decides by **version** not watermark value; one-retry-
  then-skip, no livelock. No field write bypasses it.
- **C2 hysteresis, C3 budget, C4 invalidation, M1 map-reduce primitive, T7
  summarizer fallback** — VERIFIED in `compaction.ts`.
- **C4 wiring** — ~~VERIFIED~~ **OVERTURNED by the 2026-06-10 review (RV1).**
  The mechanism is wired but the comparison baseline is destroyed before it runs
  (ChatSink.onStart overwrite) and the two sides are canonicalized differently
  (inlined URLs, jsonb key order). See §Code review 2026-06-10, RV1.
- **Schema / migration / zod / lazy-rollout** — VERIFIED. Columns additive +
  nullable/defaulted; migration `0047_context_compaction.sql` matches schema;
  `modelMeta` optional in all variants; `contextSummary`/`summaryWatermark` kept
  out of chatSubmit/chatUpdate (server-managed); no eager backfill job.
- **Tier 1 gating (plan M3)** — VERIFIED. `request.id ? applyTier1IfNeeded : skip`;
  triggers (`{agentId,search}`, no id) and sub-agents (bypass `prepareChatTurn`)
  skip Tier 1; best-effort try/catch never breaks a turn (P4).
- **`compactModelMessages` Tier 2 adapter** — fully implemented + tested (NOT a
  stub). Recovery (chunk 3) and Tier 2 (chunk 4) can call it directly.

### Chunk 3 (Recovery + C1/M2) — landed 2026-06-10

- **§E recovery** — new `runs/recovery.ts`. `isContextOverflowError` (400/413 +
  per-provider body regex: OpenAI/vLLM, Anthropic, Google, Bedrock — drift T9,
  fixture-tested). `contextOverflowRecoveryMiddleware` wraps the model via
  `wrapLanguageModel` in BOTH `streamText` and `generateText` (agent-runner), so
  every step of a tool loop gets detect → `setCompactionDirty` (flag persisted on
  DETECTION, before retry outcome) → trim via **`compactModelMessages`** (T3, no
  bespoke trim; system head pinned; keep-recent halved, floor 2) → retry once.
  Second failure surfaces "Conversation too large… start a new chat" via
  `formatStreamError`. The V3 prompt is passed to `compactModelMessages`
  directly (structurally compatible shape) — no converter, no second trimmer.
  `setCompactionDirty` goes through `commitWatermark` (P3); no-op when already
  dirty. Headless runs get trim+retry but no dirty flag (no chat row).
- **C1 fix (partial — overhead path)** — `estimateOverheadTokens(systemPrompt,
tools)` in token-estimate.ts (char/4 of system prompt + each tool's name,
  description, `asSchema(...).jsonSchema`; flat 200/tool fallback). Threaded as
  `Tier1Input.overheadTokens`; the trigger projection
  (`projectTier1Tokens`) now counts it, and the compaction target is reduced by
  it (`targetTokens − overhead`) so hysteresis (C2) still holds. `log.warn` when
  overhead alone ≥ target (compaction would re-fire each turn).
  **C1 second half — DONE 2026-06-11.** `prepareChatTurn` now threads
  `lastInputTokens` from the last assistant message's
  `metadata.stats.contextTokens` (stamped by `applyMessageStats`, §H) into
  `applyTier1IfNeeded`. `projectTier1Tokens` takes
  `max(charBased, lastInputTokens)` (not additive — `charBased` is the whole
  unsummarized view, so adding would double-count history); cold-start margin
  applies only when it is absent (turn 1). C1 fully closed.
- **M2 fixed** — `COLD_START_MARGIN = 1.15` applied to the whole char-based
  projection whenever no provider baseline exists; dropped when
  `lastInputTokens` is present.
- **Defect 4 fixed** — `summarizerWindow` now resolved (task-model window →
  `computeBudget(...).inputBudget`) in `buildCompactionRuntime` and threaded to
  Tier 1 and recovery; M1 map-reduce is live in the wired flow.
- **Defect 9 fixed** — token-estimate header no longer claims per-turn provider
  counts.
- **Refactor** — `buildCompactionRuntime` (chat-execution) resolves window /
  config / budget / summarizer once per turn, never throws (falls back to the
  8192 default), and is shared by Tier 1 and the recovery middleware; `ChatTurn`
  gained a required `recovery: RecoveryContext` field consumed by agent-runner.
- Tests: backend suite 1068 pass (was 1037) — recovery matrix + middleware
  retry/dirty/failure paths, trim boundary safety, projection C1/M2 cases,
  `setCompactionDirty`, overhead estimator. Source tsc clean; eslint 0 errors.

## Chunk 3a — RV1-RV4 fixes (landed 2026-06-10)

All 4 critical defects resolved. Tests: 1068 pass (unchanged count). tsc clean on
source files. Key changes:

- **RV1** — `stableStringify` exported from `token-estimate.ts`; `affectedBelowWatermark`
  now uses it instead of `JSON.stringify` (jsonb key-order stability). C4 baseline
  fixed: `agent-runner.stream()` reads `loadChatMessages(id)` BEFORE `sink.onStart`
  overwrites the row, threads as `priorMessages` through `prepare()` →
  `prepareChatTurn()` → `applyTier1IfNeeded()`. C4 comparison now uses
  `rawMessages` (pre-`inlineFileUrls`) so file URLs match on both sides.
- **RV2** — Submit handler in `routes/chat.ts` verifies `data.id` belongs to
  `scope.workspaceId` (SELECT + 404 if workspace mismatch) before any run starts.
- **RV3** — `force?: boolean` added to both `UICompactOptions` and `ModelCompactOptions`;
  no-op estimate gate skipped when `force:true`. `applyTier1Compaction` passes
  `force: forceCompact` to `compactUIMessages` (dirty-forced path). Recovery's
  `trimOverflowingPrompt` passes `force: true` to `compactModelMessages`.
- **RV4** — Empty-prefix guard added before Stage 2 in `compactUIMessages`: when
  `prefix.length === 0` (history ≤ keepRecentMessages), return the pruned-recent
  without calling `summarize` and without committing a `watermark:null` + non-null
  summary (which would orphan the summary every turn).

## Chunk 3b — RV5-RV7 fixes (landed 2026-06-10)

All 3 HIGH non-blocking defects resolved. Tests: 1068 pass (unchanged count). tsc clean. Key changes:

- **RV5** — `content`-type tool results: `pruneModelMessage` now soft-trims text items and replaces
  media with `[N media item(s)]` placeholders; `renderModelMessages` extracts text from `content`
  items so the summarizer sees their content. Both paths covered by `// RV5:` inline markers.
- **RV6** — Recovery target overhead: `RecoveryContext.targetTokens` is now set to
  `Math.max(0, budget.targetTokens − overheadTokens)` in `chat-execution.ts`
  (mirrors the overhead-adjusted target Tier 1 already used).
- **RV7** — Context-window resolution family (all four sub-items):
  - (a) `litellm-registry.ts` populated with full registry covering OpenAI, Anthropic, Bedrock
    (Anthropic + Meta Llama + Amazon Titan/Nova + Mistral), Mistral direct, Meta Llama direct,
    and Qwen. Wired as `loadBuiltinRegistry` on the process-wide `contextWindowResolver`.
  - (b) Family heuristic uses boundary-safe `startsWith(key + "-"|"."|":"|"/")` — `gpt-4.5-preview`
    no longer silently resolves via the stale `gpt-4` entry.
  - (c) `contextWindowResolver.evict(providerId)` called in both `routes/provider.ts` PUT handlers
    on `modelMeta` change.
  - (d) `defaultHttpGetJson` uses `AbortSignal.timeout(5000)`; `#inflight` map prevents cold-cache
    stampede; the two `resolve` calls in `buildCompactionRuntime` are run in parallel
    (`Promise.all`). Note: default-source results are still cached for the full TTL (old defect 6 /
    MED priority — open, tracked separately).

## Code review 2026-06-10 — full-branch review of chunks 1-3 (RV1-RV7 ALL FIXED)

Multi-angle adversarial review of all compaction code (7 finder angles, every
candidate independently verified against the source). Every finding below is
CONFIRMED unless marked otherwise. **RV1-RV4 were blocking** and are now fixed.
**RV5-RV7 HIGH non-blocking fixes landed 2026-06-10 (chunk 3b).**

### Critical

- **RV1 — C4 invalidation broken in BOTH directions; durable summary likely never
  survives a turn in prod.** (`chat-execution.ts` `applyTier1IfNeeded` /
  `chat-sink.ts` `onStart` / `compaction.ts` `affectedBelowWatermark`)
  - _Missed edits:_ `AgentRunner.stream` awaits `sink.onStart` **before**
    `prepareChatTurn`, and `ChatSink.onStart` overwrites `chat.messages` with the
    just-submitted history — so `loadPersistedMessages` reads back the edited
    submission and the C4 check compares the edit against itself. An **in-place
    edit below the watermark is never detected**: the model gets the stale
    summary and the edited message is dropped from the view. (Truncate-and-
    regenerate accidentally still invalidates via the watermark-gone fallback.)
  - _Spurious invalidation:_ the incoming side is post-`inlineFileUrls`
    (`data:` URLs) while the persisted side holds `http /files/…` — any chat
    with a file at/below the watermark **invalidates + fully re-summarizes every
    turn** (one wasted summarize model call per turn, forever). Additionally
    `chat.messages` is **jsonb** (Postgres re-orders object keys), so the
    `JSON.stringify` byte-equality very likely diverges for ALL chats after one
    write→read round trip — the incremental summary never survives.
  - _Fix direction:_ capture the pre-overwrite history (read the row BEFORE
    onStart overwrites, or have onStart return the previous messages), compare
    the **un-inlined** submission, and use semantic equality (id + extracted
    text/tool content, or the SDK's `isDeepEqualData`) instead of
    `JSON.stringify` byte-equality. Also consider a content digest persisted at
    compaction time to avoid the per-turn full-history read (see RV9).
- **RV2 — cross-tenant compaction writes via unvalidated `request.id`
  (security).** (`routes/chat.ts` submit handler; `compaction.ts`
  `drizzleCompactionStore`) The submit route never verifies the body `id`
  belongs to the caller's workspace (every other chat route filters
  `id AND workspaceId`; submit does no chat-row lookup at all). The compaction
  store, `loadPersistedMessages`, `invalidateCompaction`, `setCompactionDirty`
  are keyed by `chat.id` only. A workspace-A owner submitting `id` = a
  workspace-B chat id can clear B's summary/watermark, set B's dirty flag, and
  CAS-write a summary derived from A's messages onto B's row (integrity, not
  read-exfiltration; requires knowing B's chat id). _Fix:_ verify `request.id`
  belongs to `scope.workspaceId` before the run starts (mirror the other chat
  routes), and/or scope the store's queries by workspaceId.
- **RV3 — recovery + dirty-forced compaction trust the estimator that already
  failed → permanent fail loop.** (`compaction.ts` no-op branches in both
  compactors; `recovery.ts` `trimOverflowingPrompt`) Both compactors return the
  messages **unchanged** when the char/4 estimate is ≤ target — but recovery
  only runs after the provider has REJECTED the prompt. With a >2× under-count
  (CJK ≈1 token/char; assistant `reasoning` parts excluded from counting AND
  from pruning/summarizing — they ARE wire payload in the V3 prompt), the retry
  resends a byte-identical prompt and deterministically fails; next turn the
  dirty flag forces Tier 1, which no-ops and **clears the flag without
  shrinking** → overflow → dirty again, every turn. _Fix:_ recovery (and
  dirty-forced Tier 1) must force-trim past the estimate gate — e.g. a `force`
  option on the compactors that skips the no-op branch and/or scales the
  target down when invoked post-rejection; count reasoning parts in the
  ModelMessage adapter (the "reasoning is UI-only" assumption in §B is wrong
  for the V3 prompt path).
- **RV4 — small-history compaction clobbers the watermark and orphans the
  summary.** (`compaction.ts` `compactUIMessages` boundary=0 path +
  `applyTier1Compaction` commit) When the over-target history has ≤
  `keepRecentMessages` messages (one huge paste; or `effectiveTarget≈0` from
  overhead), prefix=[] → a **wasted summarize call over an empty transcript** →
  commit of `{summary, watermark: null}`. A pre-existing watermark is
  overwritten with null; `viewAfterWatermark` ignores `contextSummary` when the
  watermark is null, so the summary is orphaned, the previously-summarized
  prefix reappears in the view, and the cycle repeats each turn. _Fix:_ skip
  Stage 2 when the prefix is empty (return the no-op shape; optionally prune
  inside `recent` for oversized tool outputs), and never commit
  `watermark: null` together with a non-null summary.

### High (all FIXED 2026-06-10 chunk 3b)

- **RV5 — `content`-type tool results (standard MCP output) never pruned and
  invisible to the summarizer.** ~~(`compaction.ts` `pruneModelMessage` handles
  only text/json variants; `renderModelMessages` renders `content` as `""`)~~
  **FIXED:** `pruneModelMessage` soft-trims text items + media placeholder;
  `renderModelMessages` extracts text items from `content` outputs.
- **RV6 — recovery target ignores per-turn overhead.** ~~(`chat-execution.ts`
  RecoveryContext gets raw `budget.targetTokens`; Tier 1 uses `target − overhead`)~~
  **FIXED:** `RecoveryContext.targetTokens = Math.max(0, budget.targetTokens − overheadTokens)`.
- **RV7 — context-window resolution family.** ~~(`context-window.ts`)~~
  (a) ~~prod registry still empty~~ **FIXED:** `litellm-registry.ts` vendored with
  full OpenAI/Anthropic/Bedrock/Mistral/Llama/Qwen coverage;
  (b) ~~raw `startsWith` heuristic~~ **FIXED:** boundary-safe separators
  (`"-"`, `"."`, `":"`, `"/"`) prevent `gpt-4.5-preview` → `gpt-4` resolution;
  (c) ~~`evict` called by zero routes~~ **FIXED:** `contextWindowResolver.evict(providerId)`
  wired in `routes/provider.ts` PUT handler;
  (d) ~~no timeout / no single-flight~~ **FIXED:** `AbortSignal.timeout(5000)` +
  `#inflight` Map + `Promise.all` the two resolve calls.
  (e) ~~default-source full-TTL cache (old defect 6, MED)~~ **FIXED 2026-06-11:**
  `source:"default"` results get `DEFAULT_SOURCE_CACHE_TTL_MS` (60 s) instead of
  the hour, so a registry MISS / transient API blip no longer pins 8192.

### Medium / low (RV8-RV10 — FIXED 2026-06-11, chunk 10)

- **RV8 — `finalize` in the snapshot-consumer's `finally` could mark a broken
  run "succeeded".** ~~(`agent-runner.ts`)~~ **FIXED:** the snapshot loop now
  captures the stream error (both the `readUIMessageStream` `onError` callback
  and the surrounding `catch` set `streamError`); the `finally` finalizes
  `"failed"` with that error unless the run was aborted/cancelled. (Origin note
  retained for the upstream-PR exclusion list: introduced by the tool-timestamps
  commits `3851da6`/`b97312f`, not the compaction chunks.)
- **RV9 — hot-path waste.** ~~3-4 full-history estimation passes; full base64
  decode per image; tool schemas re-serialized every turn~~ **FIXED (partial):**
  Tier 1 computes the unsummarized-view estimate **once** and threads it as
  `knownEstimate` into `compactUIMessages` (mirrors the Tier 2 `knownEstimate`
  from chunk 4); `bytesFromUrl` decodes only a 64 KB prefix for header parsing;
  `estimateOverheadTokens` memoizes each tool's serialized-schema length in a
  `WeakMap` keyed by the schema object. **Deliberately deferred:** the digest-based
  C4 check — the full-prefix compare is already correct (RV1 landed), so this is
  pure optimization of a correct path; revisit only if the per-turn JSONB
  read+stringify shows up in profiling.
- **RV10 — cleanup minors. FIXED:** `MODEL_BOUND_UI_PART_TYPES` now has the
  promised test (membership assertion); `toolResultOutputText` collapsed to the
  two real behaviours (`execution-denied` reason vs `value`), removing the dead
  `default`; the two `commitWatermark` closures in `applyTier1Compaction` share
  one `pinnedWrite` helper; the orphaned `invalidateCompaction` jsdoc above
  `affectedBelowWatermark` removed; JPEG walker skips `0xFF` fill bytes + `0xFF00`
  stuffing and treats TEM (`0x01`) as standalone. **Not done (cosmetic):**
  `bytesFromUrl` still duplicates storage/utils' private `parseDataUrl` — left as
  is; merging them couples the estimator to the storage layer for no behaviour
  change.

### Re-affirmed solid by this review

CAS writer/loser logic (P3/R1/T10), budget math (C3), tool-pairing boundaries,
the synthetic `context-summary` message (server-side only — never leaks to
persistence/frontend; cannot become the watermark), recovery middleware
single-retry semantics and summarizer non-recursion (fresh unwrapped task
model), Tier-1 skip for headless runs (M3), kill-switch wiring (§G) with the
documented dirty-forces-compaction exception (intent, has a test — though §G's
wording "disables ALL proactive compaction" should gain a sentence noting the
recovery hand-off still summarizes).

### Defects to fix (ordered by impact)

> 2026-06-10 note: still-open items below are subsumed by the §Code review
> 2026-06-10 list — defect 2 → RV7(a), 5 → RV7(c), 6 → RV7(d), 7 → RV5,
> 11's heuristic item → RV7(b). Track them there.

1. **C1 — trigger under-counts (HIGH). _FIXED: overhead half 2026-06-10; `lastInputTokens` half 2026-06-11 — threaded from last assistant message `metadata.stats.contextTokens` in `chat-execution.ts`._** `compaction.ts:719`
   `projected = estimate(afterWatermark) + priorSummaryTokens` — omits the prior
   turn's provider `usage.inputTokens` AND the system prompt / tool schemas / skill
   payload sent every turn. `Tier1Input` has no `lastInputTokens` field; the call
   site (`chat-execution.ts:537`) passes none. This is the live-test under-count
   (8888 real vs ~986 estimated) — trigger can silently never fire on tool-bearing
   agents; only recovery (chunk 3) catches the overflow. Same root issue as the
   **§Open trigger-estimator scope** note below.
2. **Empty litellm registry + alias map in prod (HIGH, compounding).**
   `context-window.ts:285,389` — the production singleton injects an empty registry
   loader and empty alias map, so every non-API provider (OpenAI/Anthropic/Bedrock)
   resolves to `DEFAULT_CONTEXT_WINDOW = 8192`. The budget math is therefore
   wrong-defaulted for those providers today. Must vendor litellm
   `model_prices_and_context_window.json` + build the alias map and wire them in.
3. **M2 — first-turn ×1.15 margin absent (MED). _FIXED 2026-06-10._**
   `compaction.ts:719` applies no
   cold-start inflation; a char/4 under-count can keep turn-1 from triggering.
4. **`summarizerWindow` not threaded (MED). _FIXED 2026-06-10._**
   `chat-execution.ts:537` calls
   `applyTier1Compaction` without `summarizerWindow`, so the M1 map-reduce path is
   dead in the wired flow — a large cold-start/imported history can overflow the
   summarizer call itself.
5. **T5 evict not wired (MED).** `routes/provider.ts:126` updates a provider
   (incl. `modelMeta`) without `contextWindowResolver.evict(providerId)`; window
   cache serves stale values until TTL.
6. **Window cache pins transient failures (MED). _FIXED 2026-06-11 (RV7e)._**
   default/MISS results now get a 60 s `DEFAULT_SOURCE_CACHE_TTL_MS`, not the hour.
7. **Latent T2 violation (LOW).** `token-estimate.ts` `case "content"`
   `stableStringify`s tool-output base64 image bytes into char/4 text. No current
   tool emits this shape; fix before any tool returns `content`-type media.
   _Still open — see note below._
8. **Latent T1 divergence (LOW). _Test added 2026-06-11._** The model adapter now
   has explicit per-variant tool-result-output coverage (text/json/content/
   execution-denied), which is the shape a custom `toModelOutput` emits. The
   exact UI-vs-Model equality (T1) holds for SDK-converted messages; a tool whose
   `toModelOutput` reshapes the payload remains a bounded, documented divergence.
9. **Doc bug. _FIXED 2026-06-10._** `token-estimate.ts` header claims "every later turn uses the real
   provider count" — false; char/4 is used every turn (ties to C1). Fix the comment
   when C1 is plumbed.
10. **Observability metrics absent. _FIXED 2026-06-11._** No metrics infra exists
    (pino only), so emitted as structured `metric:`-tagged log lines, greppable /
    dashboardable: `cas.conflict` (commitWatermark), `context_window.fell_to_default`
    - `litellm.key_miss` (context-window), `compaction.fired` (Tier 1),
      `summarize.latency_ms` (summarize wrapper), `recovery.overflow_detected` /
      `recovery.retry` / `recovery.failed` (recovery middleware).
11. **Low. _FIXED 2026-06-11 (partial):_** key-boundary heuristic done (RV7b);
    Bedrock-ARN path now also tries lowercased candidates (`context-window.ts`);
    dead `default: return ""` in the output switch removed (switch collapsed).

### Drift-checklist deltas (vs the table at the bottom)

`C1` → **VERIFIED** (overhead + margin 2026-06-10; `lastInputTokens` threaded 2026-06-11). `M2` → **VERIFIED**. `T3` → **VERIFIED** (producer landed
in chunk 3). `T9` → **VERIFIED**. `R4` → **PARTIAL** (window present & correctly
unfixed, but the gating `cas.conflict` metric is missing). `C4` → **BROKEN**
(2026-06-10 review, RV1 — baseline overwritten + byte-equality false
positives/negatives). `T1` → **PARTIAL** (reasoning parts ARE wire payload in
the V3 prompt path but excluded — RV3). Everything else listed
above → VERIFIED. `T5` → module hook present, **PUT-handler call missing** (RV7c).

### Chunk 3 (Recovery) — hand-off is clean

`applyTier1Compaction` already honors `state.compactionDirty` as a force-trigger and
clears it inside the same CAS write. Chunk 3 only needs the **producer** in
`agent-runner.ts`: `isContextOverflowError` (per-provider 400/413 body matrix, drift
T9), retry-once via `compactModelMessages` (NOT a bespoke trim, drift T3), and set
`compactionDirty=true` through `commitWatermark`. Recommend folding the **C1 fix**
(thread prior-turn `usage.inputTokens` + system/tool payload into the projection)
into the same chunk or the §H usage-metadata chunk, since recovery makes provider
`usage` available — without C1, recovery is the only thing standing between a
tool-bearing agent and a hard overflow.

### Branch & upstream-PR hygiene

**Decided 2026-06-09. Three roles, two live branches:**

- **`feature/context-compaction` = compaction DEV branch.** Sits on the fork/deploy
  lineage (off v1.90.0, later merged with main v1.95.0), so it carries
  non-compaction commits. It is **NOT** a clean upstream PR base.
- **`deploy/fresh` = TEST/deploy target.** The test server tracks the `deploy/fresh`
  **name** (`/srv/platypus`, compose project `platypus`; rebuilds rename back to it).
  It also carries **deploy-runtime fixes that must NOT live in feature or the PR**
  (MCP OAuth quirks, host routing). Do **not** deploy `feature` directly — it lacks
  those fixes and deploying it would regress MCP OAuth + host-based URL routing.
- **Upstream PR branch = one-time throwaway.** Cherry-pick compaction-only commits
  onto current upstream `main` at PR time. Never PR `feature` directly.

**Test cycle:** `git checkout deploy/fresh` → `git merge feature/context-compaction`
→ deploy. Cheap (shared lineage). The old compaction on `deploy/fresh` is
**superseded automatically** by the merge (chat-execution resolves to feature's
version) — nothing to remove by hand. A small `chat-execution.ts` conflict is
expected (deploy/fresh's `request.id` Tier-1 call vs feature's gated
`ChatTurnRequest`); resolve to feature's version.

**Why not collapse to one branch:** `deploy/fresh` holds deploy-runtime commits
feature deliberately omits (see below); folding them into feature would re-pollute
it and force a server reconfig. Keeping two branches is the lower-friction choice.

**Deploy/fresh-only commits feature must NOT absorb** (deploy-runtime; keep on
deploy/fresh, exclude from PR): `9ad424b`, `5c2fd38`, `b9e0172`, `455a390`,
`b24f623`, `852a54a` (6 MCP OAuth runtime fixes — client_secret_post, host
rewrites, skip resource-origin check, sync auth binding); `e26d95b`
(backendUrl-from-Host); `4daed7a`, `43171b1` (deploy/fresh's own main merges).

**EXCLUDE from the upstream PR** (fork/deploy-only or unrelated features — they
predate the compaction work and must not leak into the diff):

- `e3ccf25` — `compose.yaml` deploy local-build edit (pure deploy)
- `d4cd6f2` — backendUrl-from-Host (fork deploy hack)
- `cdef399` — MCP auto-refresh on 401 + scoped quirks (separate feature)
- `7320000`, `5cfb882` — configurable agent-run timeouts (separate feature)
- `b1daa88` — deploy/fresh main(v1.90) merge commit
- `759aae1` — fork docs (PROJECT.md / CLAUDE.md fork refs)
- `b97312f`, `c18c18d`, `d194edc`, `51f69af`, `0737a6a`, `3851da6` — tool-call
  duration / timestamps. **Borderline:** plan §I reuses this. Include ONLY if §I
  (per-message stats) ships in the same PR; otherwise it is a separate feature.

**INCLUDE** (compaction): `68cf725` (foundation+Tier 1), `d1d699e` (migration),
`e19029c` + the chunk-1-2 fix/plan commits from this session, plus chunks 3-9.
Note: the `0047_context_compaction` migration will need **renumbering** to match
upstream `main`'s migration sequence at cherry-pick time.

## Goal

Stop chats from hard-failing when message history exceeds a model's context
window. Three capabilities:

1. **Proactive compaction** — summarize old history before the window fills.
2. **Recovery** — catch context-overflow errors from providers and recover.
3. **Visibility** — a context-usage indicator (ring) next to the model selector.

Applies to top-level chats **and** sub-agents (both run through the shared
`agent-runner` / `ToolLoopAgent`, so implementing once covers both).

---

## Design principles (read first — these are load-bearing)

- **P1 — Compaction is a VIEW, not a DELETE.** The watermark + summary change
  _what is sent to the model_, never _what is stored_. Raw messages stay in the
  DB untouched. Consequences: forced compaction (§J) is **not** data loss — the
  user can still read full history; only the model payload is compacted. A future
  "expand summary" UI is free because originals persist. Never hard-delete a
  summarized message.
- **P2 — One estimator.** Token counting lives in exactly one function over one
  neutral structure (`CountUnit[]`). Tier 1 (UIMessages) and Tier 2
  (ModelMessages) both normalize into it. Divergence is impossible by
  construction, not monitored. (See drift T1.)
- **P3 — One durable writer.** All mutations of compaction state
  (`summaryWatermark`, `contextSummary`, `compactionDirty`) go through a single
  versioned CAS function `writeWatermark`. No other code path writes these
  fields. (See drift R1.)
- **P4 — Recovery is the net, proactive compaction is the plan.** The overflow
  catch (§E) must stay on even if proactive compaction is globally disabled. It
  is the last line, not a risk surface.

---

## Key facts established during research

- AI SDK (`ai@6.0.191`) reports real token usage **after** each call:
  `usage.inputTokens` / `outputTokens` / `totalTokens`
  (`apps/backend/src/runs/agent-runner.ts:148-194`). This is the primary,
  provider-accurate signal driving compaction — no pre-call counting needed
  except on the very first turn.
- AI SDK exposes **no** context-window metadata on the model interface, and
  there is **no** built-in pre-call tokenizer.
- AI SDK `prepareStep` hook (`ai/dist/index.d.ts:960-1023`) runs before each
  step of an in-flight response and can rewrite the `messages` sent to the
  model — this is how we compact _within_ a single response. Receives
  **ModelMessages** (post-`convertToModelMessages`).
- `prepareChatTurn` (`chat-execution.ts:430`) holds **UIMessages**
  (`turn.stream.messages`); conversion to ModelMessages happens later at
  `agent-runner.ts:360` (`await convertToModelMessages(...)`). **Tier 1 and
  Tier 2 therefore operate on different message shapes — see drift T1.**
- Provider context-window availability:
  - Google (`inputTokenLimit`), OpenRouter (`context_length`),
    vLLM/OpenAI-compatible (`max_model_len`) — **available via API**.
  - OpenAI, Anthropic, Bedrock — **not** via API; need lookup table / manual.
- Sub-agents run as tools (`apps/backend/src/tools/sub-agent.ts:56-159`) with
  fresh history (only a `task` string), each its own `ToolLoopAgent`.
- Model call sites: `streamText` `agent-runner.ts:358-397`,
  `generateText` `agent-runner.ts:543-584`.
- Error handling today only covers auth/rate-limit/5xx
  (`agent-runner.ts:636-657`) — no context-overflow handling.
- Frontend selector + `(i)` icon: `apps/frontend/components/chat.tsx:561-593`
  inside `PromptInputTools`. No progress/ring component exists yet. Token usage
  is **not** currently streamed to the client per message.
- `inlineFileUrls` (`chat-execution.ts:524`) fetches file/image bytes and inlines
  them into messages. It does **not** decode image dimensions today (see drift T2).
- `messageMetadata` callback (`agent-runner.ts:408`) fires at message **start**,
  before timing/usage exist — cannot carry stats. Stamp at the
  `applyToolCompletions` point (`:443`) instead (see §I).

---

## Design

### A. Context-window resolution

New module `apps/backend/src/runs/context-window.ts`.

`resolveContextWindow(provider, modelId): Promise<number>` resolution order:

1. **Manual override** — per-model entry in provider config (see schema below).
2. **API auto-detect** by provider type (cached per provider+model):
   - Google: `GET {baseUrl}/v1beta/models/{modelId}` → `inputTokenLimit`.
   - OpenRouter: `GET {baseUrl}/api/v1/models` → match id → `context_length`.
   - OpenAI-type: `GET {baseUrl}/v1/models` → if entry has `max_model_len`
     (vLLM and most OpenAI-compatible servers expose it) use it; official
     OpenAI omits it → fall through.
3. **litellm model registry** (replaces a homegrown table) — vendor/fetch
   litellm's `model_prices_and_context_window.json` (MIT, community-maintained).
   Each entry has `max_input_tokens` / `max_output_tokens`. Covers OpenAI /
   Anthropic / Bedrock families that don't expose the window via API.
   - **Key normalization (drift T4):** registry keys don't match our
     `resolvedModelId` 1:1. Lookup order:
     `exact(modelId) → strip provider prefix ("openai/") → lowercase → alias map → family heuristic → MISS`.
     Maintain a small alias map for Bedrock ARNs, Azure deployment names, vLLM
     custom names. `log.warn` on every MISS (it falls to default — must be visible).
4. **Conservative default** — `DEFAULT_CONTEXT_WINDOW = 8192`. `log.warn` on every
   fall-to-default. When the window is default/unknown the **ring renders neutral**
   (§H), never a guessed green→red ramp.

Detection results cached in-memory (per provider id + model id) with a TTL.
**Cache invalidation (drift T5):** editing a `modelMeta` override must
`cache.evict(providerId)` **immediately** in the provider PATCH handler — do not
wait for TTL. TTL is only a backstop for API-detected drift. Also resolve
`maxOutputTokens` the same way (registry `max_output_tokens` / API) — needed for
the budget math in §C.

#### Schema change (per-model, not per-provider)

A single per-provider number is wrong: one provider serves many models with
different windows. Store a per-model map.

- DB: add `modelMeta` JSONB column to the `provider` table
  (`apps/backend/src/db/schema.ts`), shape:
  `{ "<modelId>": { contextWindow?: number, maxOutputTokens?: number } }`.
- Zod: extend provider schema in `packages/schemas/index.ts` (full / create /
  update variants) with optional `modelMeta`.
- Apply via `pnpm drizzle-kit-push` (DDL only — additive nullable column, safe).
- UI (later): provider edit form shows resolved window per enabled model with an
  editable override field.

### B. Token estimation (cold start only) — the single estimator (P2)

`apps/backend/src/runs/token-estimate.ts`.

One function over one neutral structure — **no per-tier estimator**:

```ts
const MODEL_BOUND: PartType[] = ["text", "tool-call", "tool-result", "file", "image"];
// reasoning / source / step-start / data-* are UI-only — they never reach the
// model and MUST be excluded on both sides (drift T1).

type CountUnit = { role: Role; text: string; nonText: NonTextPart[] };

function toCountUnits(m: UIMessage): CountUnit[]      // Tier 1 adapter
function toCountUnits(m: ModelMessage): CountUnit[]   // Tier 2 adapter
const estimateTokens = (units: CountUnit[]): number   // char/4 text + modality table
```

- char/4 applies to **text parts only**. Never char/4 a base64 image.
- **Modality table (drift T2)** for non-text parts:
  - `anthropic: (w,h) => ceil(w*h/750)`
  - `openai: (w,h,detail) => detail==="low" ? 85 : tile85(w,h)` — **detail is
    usually unset → assume `high`** (over-count beats overflow).
  - `default: () => 1200` (conservative).
  - Dimensions via **cheap header parse** (PNG IHDR / JPEG SOF marker, ~32 bytes —
    no full decode) when bytes are in hand; bare URL or parse failure → `default`
    constant. Not "free": one buffer read per image, cold-start only.
- Used **only** on the first turn before any provider `usage` exists; every later
  turn uses the real `usage.inputTokens`.
- **Tier 1 estimate runs AFTER `inlineFileUrls` (drift T2)** so the payload is
  real, not a pre-inline underestimate.
- **Divergence feedback loop (drift T2):** on turn 2, compare the cold-start
  estimate vs real `usage.inputTokens`; `log.warn` when `|est−real|/real > 0.5`
  with model + part breakdown. That signal tunes the image constants over time.
- (Optional future: Anthropic `/v1/messages/count_tokens` for exact Claude counts.)

### C. Tier 1 — cross-turn compaction (durable)

Runs in `prepareChatTurn` (`chat-execution.ts:524-549`) before a response starts.
Operates on durable chat history (**UIMessages**). Remember **P1: this is a view
over history; raw messages are never deleted.**

**Budget math** (not a raw window ratio — fixes drift C3):

```
inputBudget   = contextWindow − maxOutputReserve − safetyReserve
                (safetyReserve = reserveRatio × contextWindow, default 0.05, per LibreChat;
                 maxOutputReserve from resolved maxOutputTokens)
triggerTokens = triggerRatio × inputBudget   (triggerRatio default 0.8)
targetTokens  = targetRatio  × inputBudget   (targetRatio  default 0.5)
```

**Trigger** (drift C1 — must count what _this_ turn adds, not just the last
response): `projected = lastInputTokens + estimateTokens(messagesSinceWatermarkOrLastTurn)`.
First turn: `projected = estimateTokens(allMessages) × 1.15` (char/4 safety
margin, drift M2). Compact when `projected >= triggerTokens`.

**Hysteresis** (drift C2 — the Cline #5616 thrash failure): compaction must reduce
the conversation to `<= targetTokens`, well below the trigger, so it does NOT
re-fire next turn. Trigger ratio (0.8) and target ratio (0.5) are deliberately
distinct.

Compaction (`apps/backend/src/runs/compaction.ts`) — staged, cheap-first
(LibreChat pattern). **Two adapters, shared leaf primitives** (P2):
`compactUIMessages` (Tier 1) and `compactModelMessages` (Tier 2 + recovery) both
call `estimateTokens` / `summarizePrefix` / `pickKeepBoundary`. Pairing rule
differs by shape:

- Tier 1 / UIMessage: an assistant message carrying tool-invocation parts is
  **atomic** — never split, never drop its paired result.
- Tier 2 / ModelMessage: keep assistant + following `role:"tool"` messages
  together.

Stages:

- Pin the system prompt.
- Keep the last `keepRecentMessages` (default ~10) verbatim; never split a
  tool-call / tool-result pair across the boundary.
- **Stage 1 — prune (no model call):** in the older prefix, degrade bulky tool /
  RAG results — soft-trim to head+tail, then replace with a placeholder
  (`[tool result elided]`) for results over `minPrunableChars`. Often enough to
  reach `targetTokens` without a summarization call.
- **Stage 2 — summarize:** if still above target, summarize the older prefix
  with the **task model** into one synthetic summary message.
  - **Model fallback (drift T7):** `provider.taskModelId → resolvedModelId (main)`.
    `log` which model summarized + token cost.
  - **Chunked / map-reduce** when the prefix exceeds the summarizer's own window
    (drift M1 — cold-start on a large imported history).
- Output: `[system, summaryMessage, ...pruned/keptRecent]`.
- **Fail loud:** emit a visible transcript event (`context-compacted`,
  "Summarized N earlier messages") rather than silently mutating.

**Persistence + watermark** — all writes through `writeWatermark` (P3, drift R1):

- Add to chat/run record: `contextSummary: text`, `summaryWatermark: int`
  (id/index of last summarized message), `compactionDirty: boolean default false`
  (drift T3), `version: int default 0` (drift R1 — CAS token).
- Each turn, summarize only messages _after_ the watermark and fold into the
  existing summary, then advance the watermark — incremental.
- **The single versioned CAS writer (P3, drift R1):**

  ```ts
  // EVERY mutation — advance | C4 reset | dirty-clear — goes through this.
  async function writeWatermark(
    chatId,
    expectVersion,
    patch /* {watermark?, summary?, dirty?} */,
  ) {
    const res = await db
      .update(chat)
      .set({ ...patch, version: expectVersion + 1 })
      .where(and(eq(chat.id, chatId), eq(chat.version, expectVersion)));
    return res.rowCount === 1; // false = conflict → re-read, decide by VERSION not watermark value
  }
  ```

- **Loser behavior on CAS conflict (drift T10):** re-read the row. If
  `version` moved and the watermark now covers my prefix → **SKIP** (winner
  already compacted; safe no-op) **and clear dirty**. Else retry **once**; second
  conflict → SKIP + `log.warn(contended)`. No recompute-loop, no livelock.
- **Invalidation (drift C4 + R1):** if any message at/below `summaryWatermark` is
  edited/deleted/regenerated, the summary is stale. The edit/delete/regenerate
  handler calls `writeWatermark` to **bump version + clear `contextSummary` +
  reset watermark** to the last unaffected message — all in one CAS write. Because
  the loser compares **version** (not watermark value), a compaction racing an
  invalidation sees a conflict and re-reads the reset state — it can never write a
  stale summary over mutated history. Branch/regenerate that forks below the
  watermark resets it on the new branch.

### D. Tier 2 — intra-turn compaction (in-memory)

For a single response with many tool/sub-agent calls that bloats the window
mid-loop. Uses `prepareStep` on both `streamText` and `generateText`.
Operates on **ModelMessages** via `compactModelMessages`.

`prepareStep({ messages, stepNumber, steps })`:

- Estimate current step tokens (same `estimateTokens`, P2); if `>= threshold`:
  - Summarize **old completed** tool results (steps several back), keep recent
    steps verbatim, preserve call/result pairing.
  - Return `{ messages: compacted }`.
- **Only fire when genuinely near limit** (drift m3 — mid-step summary adds
  latency; don't run it every step).

**Not persisted.** `prepareStep` edits are throwaway per-call — the SDK keeps its
own canonical message list and returns the _full_ messages in
`result.response.messages`, which commit to history as normal. Next turn, Tier 1
folds that finished (still-bloated) turn into the durable summary. Tier 2 only
keeps a heavy response executable; Tier 1 owns durable state.

### E. Recovery — context-overflow error handling (P4)

In `agent-runner.ts` (around `formatStreamError`, `:636-657`):

- `isContextOverflowError(err)` — `APICallError.isInstance(err)` AND
  (`statusCode` in {400, 413}) AND body matches
  `/context length|context_length_exceeded|prompt is too long|too many tokens|maximum context/i`.
- On detect mid-run:
  1. In-memory aggressive trim via **`compactModelMessages`** with a smaller
     `keepRecentMessages` (drift T3 — reuse the Tier 2 adapter, **no bespoke
     trim**, or T1 divergence returns).
  2. Retry the call **once**.
  3. Persist `compactionDirty = true` via `writeWatermark` (a small standalone
     UPDATE, independent of the stream's finalize — drift T3). Recovery **never**
     writes summary/watermark directly; it only flags.
  4. If retry still fails, surface: "Conversation too large even after trimming —
     start a new chat or reduce attachments." (No infinite retry.)
- **Durable compaction happens on the NEXT `prepareChatTurn`** (drift T3 —
  chosen path, not "finalize-or-next"): it sees `compactionDirty`, forces Tier 1
  before building messages, and clears the flag inside the same CAS write that
  advances the watermark. `compactionDirty` is **persisted** so a crashed/swapped
  worker still resumes correctly.

### F. Wiring for sub-agents

`ToolLoopAgent` constructor takes `contextWindow` + `maxOutputTokens` +
compaction config. Sub-agent tool creation (`sub-agent.ts:56-159`) already builds
a `ToolLoopAgent` per sub-agent — resolve each sub-agent model's window and pass
it through.

**Tier 2 only (drift M3):** sub-agents start fresh each invocation (only a `task`
string, no cross-turn history), so there is no durable history for Tier 1 to
compact. Just pass the window so `prepareStep` (Tier 2) fires if a sub-agent's own
tool loop bloats. Recovery (§E) covers them too since `agent-runner` is shared.

### G. Config surface + kill switch

**SUPERSEDED 2026-06-12 — going global+per-model (see Chunk 12).** The per-agent
fields below shipped in chunk 10 but are being removed: no surveyed tool
(Hermes/Codex/Claude/Cline) exposes per-agent compaction tuning, and the ratios
self-normalize to the model window so per-agent variance buys nothing measurable.

~~Per-agent optional fields, with sane defaults:~~

- ~~`compactionEnabled` (default true)~~
- ~~`triggerRatio` (default 0.8), `targetRatio` (default 0.5),
  `reserveRatio` (default 0.05), `keepRecentMessages` (default 10),
  `minPrunableChars` (default ~2000)~~

The runtime now uses `DEFAULT_COMPACTION_CONFIG` for all agents; window/output
size stays per-model via the §A resolver (`provider.modelMeta` override).

**Global kill switch:** env `COMPACTION_ENABLED` (default true) disables all
proactive compaction (Tier 1 + Tier 2) in prod without a deploy. **Recovery (§E)
ignores this flag** — it is the safety net (P4). After Chunk 12 this env flag is
the ONLY compaction toggle (the per-agent `compactionEnabled` is gone).

### H. Frontend context-usage indicator (the ring)

1. **Backend emits usage to client.** On run finish, include
   `{ inputTokens, contextWindow }` in the streamed message metadata. Today usage
   is run-level only (`types.ts:8-13`); surface last input-token count + resolved
   window per assistant message.
2. **New component** `apps/frontend/components/context-usage-ring.tsx` — small
   SVG/conic-gradient ring, fill = `inputTokens / contextWindow`. Color ramps
   (green → amber ≥0.7 → red ≥0.9). **Neutral grey, no fill %, when the window is
   unknown/default** (drift T6). Wrapped in `Tooltip`.
3. **Placement** — in `PromptInputTools` between the model selector and the `(i)`
   info icon (`chat.tsx:574-575`).
4. **Data source (drift U1):** resolve the window from the **currently selected
   model** (frontend already holds it in `PromptInputTools`; expose via the
   provider/model metadata API / `modelMeta` map), NOT from the last assistant
   message's metadata — else the ring shows the previous model's window after a
   model switch. Fill = `lastInputTokens / selectedModelWindow`.
5. **Tooltip label is REQUIRED, not optional (drift U2/m2):**
   `Last response: N / W (NN%) · current input not yet counted`. The ring reflects
   the last response, not the unsent composer input — say so. (Projected-input arc
   is deferred, see Open.)

### I. Per-message stats popover (next to Regenerate)

An `(i)` action under each assistant response showing input tokens, output
tokens, TTFT, and total generation time. Hover = tooltip, click = popover.

**Reuse the existing tool-call duration mechanism** (commits c18c18d / b97312f) —
`withToolTimestamps` + `applyToolCompletions` (`agent-runner.ts:63-120`),
`useToolDuration` + `formatDurationMs` (`hooks/use-tool-completed-at.ts`,
`lib/utils.ts:29-49`).

Backend (`agent-runner.ts`):

- Capture `startedAt` at run start, `firstTokenAt` at the first text-delta chunk,
  `finishedAt` when the stream finalizes (the `applyToolCompletions` point, `:443`).
- Capture token usage from `onFinish` / `totalUsage` (`:148-194`).
- Stamp onto `message.metadata` **at the `applyToolCompletions` point, NOT the
  `messageMetadata` callback** (which fires at message start before timing/usage
  exist). Shape:
  `metadata.stats = { inputTokens, outputTokens, startedAt, firstTokenAt, finishedAt }`.

Frontend:

- New `MessageAction` info icon in `chat-message.tsx:335-378`, beside Regenerate,
  rendered when `metadata.stats` exists.
- Content: `Input: N · Output: N`, `TTFT: formatDurationMs(firstTokenAt − startedAt)`,
  `Total: formatDurationMs(finishedAt − startedAt)`.
- TTFT/total are **server-measured**. Optional client-observed "Round-trip" line
  from the `useChat` send timestamp. Reuse `formatDurationMs`; mirror the
  client-observed fallback in `useToolDuration` for in-flight messages.

### J. Clickable ring — compact on demand

Make the §H ring actionable. **Remember P1: this compacts the model view, not the
stored history — it is not destructive in the data sense.**

- **Hover** — tooltip with percentage filled (already in H).
- **Click** — request compaction. If a response is generating, defer until the
  current message finishes, then run; if idle, run immediately.

Backend endpoint `POST /chats/:id/compact` (`routes/chat.ts`):

- Runs Tier 1 compaction once **regardless of threshold** (force), persists via
  `writeWatermark`, returns the new resolved usage (`inputTokens` estimate after
  compaction + `contextWindow`) so the ring refreshes immediately.
- Reuses the Tier 1 `compaction.ts` module.

Frontend:

- Ring `onClick` → if `status === "streaming"`, set a pending flag and fire on the
  chat's finish callback; else call now.
- **Pending-while-streaming visual (drift U4):** ring shows a pending badge +
  tooltip "will compact when response finishes", and is **disabled** (no
  re-click). On finish → spinner → updated fill from the response.
- **Confirm default-ON when the drop is significant (drift U3):**
  `messagesDropped > keepRecentMessages` OR estimated reduction `> 30%` of history
  → confirm. Below that → immediate, no prompt. (Confirm is UX courtesy; per P1 no
  data is destroyed regardless.)

---

## File-by-file change list

Backend:

- `apps/backend/src/runs/context-window.ts` — **new**: window resolution + API
  auto-detect + litellm registry w/ key normalization + cache + evict hook.
- `apps/backend/src/runs/token-estimate.ts` — **new**: single `estimateTokens` +
  `toCountUnits` adapters + image modality table + header-parse dims.
- `apps/backend/src/runs/compaction.ts` — **new**: `compactUIMessages` (Tier 1) +
  `compactModelMessages` (Tier 2 + recovery) + shared leaf primitives +
  `writeWatermark` CAS.
- `apps/backend/src/runs/agent-runner.ts` — `prepareStep` (Tier 2) on
  `streamText`/`generateText`; `isContextOverflowError` + retry-once recovery
  (reuses `compactModelMessages`, sets `compactionDirty`); pass `contextWindow`
  through; emit usage metadata; capture `startedAt`/`firstTokenAt`/`finishedAt` +
  usage and stamp `metadata.stats` at the `applyToolCompletions` point (§I).
- `apps/backend/src/services/chat-execution.ts` — Tier 1 in `prepareChatTurn`
  (after `inlineFileUrls`); resolve window; check/clear `compactionDirty`; all
  state writes via `writeWatermark`.
- `apps/backend/src/routes/chat.ts` — `POST /chats/:id/compact` (§J).
- `apps/backend/src/routes/provider.ts` — `cache.evict(providerId)` on modelMeta
  update (drift T5).
- `apps/backend/src/tools/sub-agent.ts` — pass per-sub-agent window/config.
- `apps/backend/src/db/schema.ts` — `provider.modelMeta` JSONB; chat/run
  `contextSummary` + `summaryWatermark` + `compactionDirty` + `version`; agent
  compaction fields.
- message edit/delete/regenerate handlers — call `writeWatermark` to invalidate
  (version bump + clear summary + reset watermark) (drift C4/R1).

Schemas:

- `packages/schemas/index.ts` — provider `modelMeta`; agent compaction fields;
  message-metadata usage + stats shape for the frontend.

Frontend:

- `apps/frontend/components/context-usage-ring.tsx` — **new**: ring (window from
  selected model), hover tooltip, clickable force-compact, pending/disabled state.
- `apps/frontend/components/chat.tsx` — render ring; resolve selected-model window;
  wire `onClick` → compact endpoint (defer while streaming).
- `apps/frontend/components/chat-message.tsx` — `(i)` stats `MessageAction` (§I).
- `apps/frontend/hooks/use-message-stats.ts` — **new** (optional): client-observed
  timing fallback for in-flight messages.

Migration:

- Additive nullable columns via `pnpm drizzle-kit-push` (dev). Prod via
  `scripts/migrate.ts`.
- **Lazy rollout (item 3):** existing chats get `version=0`, null summary,
  `compactionDirty=false`. They do **NOT** eagerly compact on deploy — Tier 1 only
  fires on each chat's next turn. **Do not add a backfill job** "to be safe" — it
  would create a thundering herd of summarize calls that lazy rollout avoids.

---

## Observability (item 4 — the design is only as good as the prod signal)

**Landed 2026-06-11.** No metrics infra exists in the backend (pino logging
only), so each signal is emitted as a structured `metric:`-tagged log line —
greppable today, trivially shipped to a counter later. Emitted:

- `compaction.fired` (Tier 1) with `tier` / `tokensBefore` / `tokensAfter` /
  `messagesDropped`. ✅
- `summarize.latency_ms` with `latencyMs` + `taskModelId` + `usage` (the model
  is in the same line). ✅
- `recovery.overflow_detected`, `recovery.retry`, `recovery.failed`. ✅
- `context_window.fell_to_default` + `litellm.key_miss` (drift T4/T6). ✅
- `cas.conflict` (per lost CAS + on contended-skip) — **decides whether the R4
  efficiency note ever needs fixing**. ✅

Still log-only (no dedicated metric): `estimate_vs_real.divergence` (drift T2
feedback loop) — deferred with the T2 image-constant tuning work.

---

## Tests

- `context-window`: resolution order; API parse for Google / OpenRouter / vLLM;
  litellm hits **incl. key normalization + Bedrock ARN / Azure / MISS→default**
  (drift T4); default fallback; cache evict-on-override (drift T5).
- `token-estimate`: char/4 text-only bounds; **`MODEL_BOUND` filter — UI-only
  parts excluded**; **`estimate(toCountUnits(ui)) === estimate(toCountUnits(convert(ui)))`
  exact on the filtered set** (drift T1); image modality table (constant, not
  char/4) + header-parse dims + missing-dims fallback (drift T2); estimate runs
  after inline.
- `compaction`: preserves tool-call/result pairing **both UIMessage and
  ModelMessage shapes**; respects `keepRecentMessages`; incremental watermark
  folding; prune Stage 1 reaches target without a model call when possible;
  hysteresis — output `<= targetTokens`, does not re-fire next turn; chunked
  summarize over an oversized prefix; **summarizer model fallback** when
  `taskModelId` unset (drift T7).
- `budget`: window − output reserve − safety reserve; trigger counts new
  (unsummarized) messages, not just last response (drift C1).
- `writeWatermark` / CAS (drift R1/T10): concurrent writers — one wins
  (`rowCount===1`), loser re-reads, decides by **version** not watermark value;
  loser SKIPs + clears dirty when winner advanced; one-retry-then-skip, no
  livelock; **invalidation reset bumps version and a racing compaction sees a
  conflict** (never writes stale summary over mutated history).
- `watermark-invalidation`: editing/deleting a message ≤ watermark clears summary,
  resets watermark, bumps version (drift C4).
- `agent-runner`: `prepareStep` trims old tool results only, fires only near limit
  (drift m3); overflow-error detection true/false matrix **across per-provider
  error bodies** (OpenAI / Anthropic / Google-vLLM fixtures, drift T9); retry-once
  **reuses `compactModelMessages`** (drift T3); sets `compactionDirty`; then clean
  failure.
- `recovery-persistence` (drift T3): after recovery, next `prepareChatTurn` sees
  `compactionDirty`, forces Tier 1, clears flag — and the next turn does **not**
  re-overflow; recovery never writes summary directly.
- Integration: synthetic long history → Tier 1 compacts + persists; injected 400
  overflow → recovery retries + succeeds; sub-agent inherits window (Tier 2 only).
- `message-stats`: `startedAt`/`firstTokenAt`/`finishedAt` captured in order;
  metadata stamped at `applyToolCompletions`, not message-start; TTFT/total format.
- `compact-endpoint`: force-compaction advances watermark (via `writeWatermark`)
  and returns refreshed usage; defers/queues while a run is mid-stream.
- Frontend: ring window comes from selected model not last-message metadata
  (drift U1); neutral state on unknown window (drift T6); pending/disabled while
  streaming (drift U4); confirm fires above the §J threshold (drift U3).

---

## Sequencing

1. Window resolution + single estimator + schema (`modelMeta`, `version`,
   `compactionDirty`, summary/watermark) — foundation. **✅ DONE** (open defects:
   empty prod registry, T5 evict, cache-pins-default — see Review §).
2. Compaction module + `writeWatermark` CAS + Tier 1 (cross-turn, persist).
   **✅ DONE** (open defects: C1 trigger under-count, M2 margin, summarizerWindow
   not threaded — see Review §).
3. Recovery (overflow detect + retry-once + dirty flag). **✅ DONE 2026-06-10**
   (C1 overhead fix + M2 margin + summarizerWindow threading folded in; the
   `lastInputTokens` half of C1 moves to step 6 — see Chunk 3 §).
   3a. **Review-fix chunk (RV1-RV4). ✅ DONE 2026-06-10.**
   3b. **Review-fix chunk (RV5-RV7). ✅ DONE 2026-06-10.** All HIGH non-blocking
   defects resolved — content-type pruner/renderer, recovery overhead target,
   litellm registry populated, heuristic boundary-safe, evict wired, timeout +
   single-flight in context-window resolver.
4. Tier 2 (`prepareStep`, in-memory). **✅ DONE 2026-06-10** `buildTier2PrepareStep`
   wired into both `streamText` and `generateText`; fires when accumulated
   ModelMessages exceed `triggerTokens` (drift m3); uses shared
   `compactModelMessages` adapter (drift T3); null when kill switch off.
   `Tier2Context` on `ChatTurn` threads config from `buildCompactionRuntime`.
   Tests: 1074 pass; tsc source clean.
   - **Chunk 4 review fix (2026-06-10):** Tier 2 trigger/target now subtract
     `overheadTokens` (RV6 extended to Tier 2 — the prepareStep estimate sees
     ModelMessages only, but system prompt + tool schemas consume the same
     window; without this, a large overhead lets the payload exceed the budget
     before Tier 2 fires). `compactModelMessages` gained `knownEstimate` so the
     prepareStep trigger estimate is reused instead of recomputed (RV9). Tests
     strengthened: summarize-on-fire + pairing-safety asserted, empty-prefix
     no-op asserts `undefined`.
5. Sub-agent wiring (Tier 2 only). **✅ DONE 2026-06-10** `Tier2Context` + `buildTier2PrepareStep` moved to `compaction.ts` (no-cycle); `createSubAgentTool` gains `prepareStep?`; `createSubAgentTools` gains `prepareStepFn?`; `loadSubAgents` resolves per-sub-agent compaction runtime + builds prepareStep map. Tests: 1077 pass; tsc source clean.
6. Frontend usage metadata + ring (§H). **✅ DONE 2026-06-10** `CompactionRuntime` + `ChatTurn.resolved` carry `contextWindow` + `contextWindowIsDefault` (from resolved window source). `applyMessageStats` stamps `metadata.stats = { inputTokens, outputTokens, contextTokens, startedAt, firstTokenAt, finishedAt, contextWindow, contextWindowIsDefault }` on last assistant message at `applyToolCompletions` point. New `GET /:providerId/context-window?modelId=X` endpoint returns resolved window (null when source = "default", drift T6). `MessageStats` schema in `@platypus/schemas`. New `ContextUsageRing` component (SVG donut, green/amber/red ramp, neutral when unknown, required tooltip, drift T6/U2). Ring placed in `PromptInputTools` between search and model selector; `contextWindowData` SWR-fetched per selected model (drift U1). Tests: 1077 pass; source tsc clean.
   - **✅ Code review for chunk 6 (2026-06-11).** One critical bug fixed: `inputTokens`/`outputTokens` from `accumulateStepStats` are the run-wide SUM across steps; feeding the summed input into the ring over-counts on multi-step tool loops (5-step loop → reported ≈ sum-of-all-prompts, pegging the ring red >100% when real fill ~37%). **Fix:** added `contextTokens` = last step's `usage.inputTokens` (peak context fullness, tracked in `streamText.onStepFinish`); the ring uses `contextTokens`, the §I cost popover keeps the summed `inputTokens`/`outputTokens`. Also: `ContextUsageRing` prop `inputTokens`→`usedTokens`; frontend `as any` casts replaced with typed `MessageStats`; removed dead `Tier2Context` import in `agent-runner.ts`. Documented trade-offs left as-is: numerator (last response's model) vs denominator (selected model) mismatch after a model switch is intentional (drift U1); `generate()` headless path stamps no stats (no UI); TTFT = first text part, excludes leading reasoning (matches §I wording).
7. Per-message stats popover (§I). **✅ DONE 2026-06-11** `MessageStatsPopover` in `chat-message.tsx`: info icon (lucide `InfoIcon`) in `MessageActions` for all assistant messages with `metadata.stats`; popover shows In/Out token counts (run-wide sums), TTFT (when `firstTokenAt` present), Total elapsed. Uses `formatDurationMs` from `lib/utils`. tsc clean; 1077 tests pass.
8. Clickable ring → compact endpoint (§J). **✅ DONE 2026-06-11** `POST /chats/:id/compact` runs force-Tier-1 via new `forceCompactChat` helper in `chat-execution.ts`; returns token estimate + context window so ring refreshes immediately. Frontend: `onClick` with defer-while-streaming + pending badge (drift U4); confirm dialog above threshold (drift U3); ring keyboard-accessible; hooks hoisted above early returns (rules-of-hooks fix). Tests: 1081 pass; tsc clean.
9. Per-agent config surface + `COMPACTION_ENABLED` kill switch. **✅ DONE 2026-06-11** DB + Zod schemas already had per-agent fields (`compactionEnabled`, `triggerRatio`, `targetRatio`, `reserveRatio`, `keepRecentMessages`, `minPrunableChars`); `resolveCompactionConfig` + `buildCompactionRuntime` already wired them; global `COMPACTION_ENABLED=false` kill switch in `chat-execution.ts`. Added compaction fields to `agentCreateSchema` / `agentUpdateSchema` (so routes pass through) and "Context compaction" section in `agent-form.tsx` Advanced settings. Backend 1081 pass; tsc clean.
   - **✅ Code review for chunk 9 (2026-06-11).** One MEDIUM + minors fixed. The
     editable surface newly exposed the C2 thrash hole (a user/API could set
     `targetRatio >= triggerRatio` → compaction re-fires every turn). **Fix:**
     (1) `agentCreateSchema`/`agentUpdateSchema` gained a zod `.refine` rejecting
     an inverted pair (checked only when both supplied; error on `targetRatio`);
     (2) `resolveCompactionConfig` clamps `targetRatio → triggerRatio * 0.9` as a
     runtime backstop for legacy/direct-write rows. Minors: `keepRecentMessages`
     base schema tightened `.nonnegative()`→`.min(1)` (0 keep-recent breaks
     pairing; form already enforced min=1); form description now states the
     target<trigger rule + that the global `COMPACTION_ENABLED` kill switch
     overrides the per-agent switch; lone `minPrunableChars` grid cell spans both
     columns (cosmetic). Backend 1081 pass; backend/schemas/frontend tsc clean on
     touched files (pre-existing unrelated test-type errors untouched).

Steps 1–3 deliver the core "no more hard fails" value; 4–9 are progressive
enhancement. Each step independently testable.

### Chunk 11 — UI polish + bug fixes (planned)

Three items discovered 2026-06-12. None block correctness; all are frontend-only
except the backend `context-compacted` stream event.

#### 11a. Bug U5 — ring jumps to pre-compaction value on user message send

**Root cause.** `compacted.atMessageCount` is compared against `messages.length`
(`chat.tsx:708`). When the user sends a new message the optimistic UI pushes a
user message immediately → `messages.length` increments by 1 → expiry condition
fires → ring falls back to `lastAssistantStats?.contextTokens` which still holds
the old (70 k) value from before compaction. After the assistant response arrives
`lastAssistantStats` is updated with the real post-compaction count (~20 k) and
the ring corrects. **Visible symptom:** ring briefly snaps back to 70 k the moment
the user hits Send, then returns to the correct ~20 k once the response lands.

**Fix.** Count only assistant messages for expiry:

```ts
// derive once; stable across user-message additions
const assistantMessageCount = useMemo(
  () => messages.filter((m) => m.role === "assistant").length,
  [messages],
);

const [compacted, setCompacted] = useState<{
  atAssistantMessageCount: number;
  tokens: number;
} | null>(null);

// at compact time:
setCompacted({
  atAssistantMessageCount: assistantMessageCount,
  tokens: body.inputTokens,
});

// ring usedTokens expression:
compacted?.atAssistantMessageCount === assistantMessageCount
  ? compacted.tokens
  : lastAssistantStats?.contextTokens;
```

A new user message does NOT change `assistantMessageCount` → compacted stays
valid. When the next assistant response lands, `assistantMessageCount` increments
→ compacted expires → ring reads the fresh `lastAssistantStats.contextTokens`.

**Files:** `apps/frontend/components/chat.tsx` only (3 small edits).

#### 11b. (i) icon: add mouseover tooltip

**Current state.** The `Info` button at `chat.tsx:741-743` is a bare
`DialogTrigger` — no tooltip, click-only. The user has to click to discover what
it does.

**Fix.** Wrap the existing `DialogTrigger`/`PromptInputButton` in a `Tooltip`
so hover shows a label without opening the dialog. Click still opens the dialog
(unchanged). Use the same `delayDuration={500}` as the ring. Tooltip text:
`"Agent info"` (or a one-line agent description if `selectedAgent.description`
is non-empty). Pattern:

```tsx
<Dialog open={isAgentInfoDialogOpen} onOpenChange={setIsAgentInfoDialogOpen}>
  <Tooltip delayDuration={500}>
    <TooltipTrigger asChild>
      <DialogTrigger asChild>
        <PromptInputButton aria-label="Agent info">
          <Info />
        </PromptInputButton>
      </DialogTrigger>
    </TooltipTrigger>
    <TooltipContent side="top">
      {selectedAgent.description?.trim() || "Agent info"}
    </TooltipContent>
  </Tooltip>
  <AgentInfoDialog … />
</Dialog>
```

Note: `TooltipTrigger asChild` wrapping `DialogTrigger asChild` is a safe
Radix composition — Radix merges event handlers via slot; the `onClick` from
`DialogTrigger` and the hover callbacks from `TooltipTrigger` coexist on the
same underlying `PromptInputButton` element.

**Files:** `apps/frontend/components/chat.tsx` only (reshape the existing JSX
block, no new imports needed — `Tooltip`/`TooltipTrigger`/`TooltipContent`
already imported).

#### 11c. Compaction chat trace (new §K)

**Goal.** Make compaction visible inside the chat timeline — not just via the
ring. Two states:

1. **Active / in-flight** — "compaction is happening right now" (between the
   user hitting Send and the first response token arriving).
2. **Historical** — "compaction happened here" (visible in the scrollback,
   including the LLM-generated summary since that IS a model call).

**Mental model.** Compaction is a model call forced by the system on the
user's behalf — structurally equivalent to a tool call initiated by the
assistant. It therefore maps naturally to the **existing tool-call UI**:
emit it as a synthetic `compact_context` tool-call + tool-result pair in the
stream before the actual response. No new rendering component needed — the
existing tool-call expander handles both active ("in flight") and historical
states for free. No fake user message injected; no custom banner.

**Why the backend needs to emit an event.** Tier 1 runs inside
`prepareChatTurn` (server-side, before streaming). The frontend has no other
channel to distinguish "compaction ran before this response" from normal
response latency. §C already prescribes `context-compacted` as a fail-loud
stream event; this chunk wires that emission as a tool-call pair.

**Backend change.** After a successful Tier 1 compaction in
`applyTier1Compaction`, emit a synthetic tool-call + tool-result into the
AI-SDK `dataStream` before the first assistant text part. Use the SDK's
`writeData` / `writeTool*` primitives (exact API depends on AI SDK version —
check `dataStream` surface in `chat-execution.ts`). Logical shape:

```ts
// tool-call part
{ toolCallId: "<uuid>", toolName: "compact_context", args: { messagesSummarized: N } }

// tool-result part
{
  toolCallId: "<uuid>",
  toolName: "compact_context",
  result: {
    messagesDropped: N,
    summaryExcerpt: string | undefined,  // first ~120 chars of LLM summary; absent for Stage-1-only (prune, no model call)
  }
}
```

`summaryExcerpt` carries the first ~120 chars of the LLM-generated summary.
This IS the model's own words — not a risk, and it gives users transparency
into what was retained. Omit when compaction ran Stage 1 only (prune, no
model call).

**Frontend — no new component.** The existing tool-call renderer in
`chat-message.tsx` already handles `tool-call` + `tool-result` parts. The
`compact_context` call will render like any other tool invocation:

- While streaming: shows "compact_context" with a spinner (active indicator).
- After complete: collapses to the tool-call expander showing args +
  result (including `summaryExcerpt` when present).

The result persists in `UIMessage.parts` (AI SDK durable storage) → appears
in scrollback automatically.

**What the user sees:**

```
▶ compact_context                              [expandable]
  ↳ messagesDropped: 34
    summary: "The user has been working on the Platypus
              monorepo, specifically the context-compaction
              feature…"
──────────────────────────────────────────────
[actual assistant response to user's question]
```

**Forced compaction (§J, ring click).** The `POST /chats/:id/compact`
endpoint runs outside of a normal streaming turn — no `dataStream` available.
Instead, after compaction succeeds the backend **persists a synthetic
assistant message** directly into the chat's message list (same DB write path
as real messages). Shape: role `assistant`, parts = `[tool-call, tool-result]`
for `compact_context`, no text content. The frontend refreshes the message
list after the POST resolves (SWR revalidation or optimistic append from the
response body) — the new message appears in the scrollback exactly like any
other tool-call exchange. The existing ring spinner + toast remain; the
synthetic message is the persistent trace.

**C4 / watermark safety — two paths:**

- **Tier 1 trace** — emitted parts live in `UIMessage.parts` of the following
  assistant message (stream data only, not a separate DB row). Do NOT affect
  message IDs, watermark comparisons, or C4 logic.
- **§J trace** — IS a real DB message row. Must be written with a message ID
  that is **above** the current `summaryWatermark` so it is never itself
  summarized. The existing `writeWatermark` CAS is not involved (the
  watermark already advanced during the compaction); just insert with a
  timestamp after the last real message. C4 invalidation only triggers on
  edits/deletes at/below the watermark — this new row is always above it, so
  no risk.

**Files:**

- `apps/backend/src/runs/compaction.ts` — return compaction result metadata
  (`messagesDropped`, `summaryExcerpt`) from `applyTier1Compaction` (or add
  an optional `dataStream` param to emit directly).
- `apps/backend/src/services/chat-execution.ts` — after
  `applyTier1IfNeeded`, if compaction ran, emit the tool-call + tool-result
  pair into `dataStream`.
- `packages/schemas/index.ts` — no change needed (tool-call parts already
  in the union).
- `apps/frontend/components/chat-message.tsx` — no change needed (existing
  tool-call renderer handles `compact_context` automatically). Optionally:
  add a display-name entry so it shows "Context compaction" instead of the
  raw function name.

**Tests:**

- Backend: `applyTier1Compaction` returns `{ messagesDropped, summaryExcerpt? }`;
  no emission when compaction does not fire (below trigger).
- Integration: stream from a compacted turn contains a `tool-call` part with
  `toolName: "compact_context"` before any `text` part.

**Sequencing.** 11a and 11b are trivial — do them first (one commit each).
11c has a backend+frontend surface; implement backend emission first (easy
to verify via the stream in DevTools), then verify existing tool-call UI
renders it without frontend changes.

#### Chunk 11 — code review fixes (landed 2026-06-12)

Review of the first 11c cut surfaced one correctness defect + three gaps; all fixed.

- **RV11 (HIGH) — synthetic trace was replayed to the provider.** The
  `compact_context` tool part is persisted into the assistant message (for
  scrollback) and was therefore re-converted by `convertToModelMessages` and
  sent to the model on every later turn — a phantom tool call for a tool not in
  `tools` (provider-rejection / model-confusion risk). **Fix:**
  `stripCompactionTraceParts` removes the part at both `convertToModelMessages`
  call sites (`agent-runner.ts` stream + generate); a trace-only message (§J) is
  dropped entirely so no empty assistant message is sent. The part still
  persists for the timeline; it just never reaches the model.
- **RV12 (MED) — trace emitted for no-op turns.** `compactionTrace` was built
  whenever `triggered`, but `messagesDropped` is 0 with no excerpt on prune-only
  and force-dirty-within-target runs → empty timeline entry. **Fix:**
  `compactionTrace` is now `undefined` unless an actual model summary ran
  (`usedModelCall && summaryText`).
- **RV13 (MED) — §J forced-compaction trace was unimplemented.** Ring-click
  compaction produced no timeline trace (only the auto path did). **Fix:**
  `forceCompactChat` persists a standalone synthetic assistant message via
  `buildCompactionTraceMessage` (above the watermark; stripped from the model
  payload like the Tier-1 trace), returns it from `POST /chats/:id/compact`, and
  the frontend appends it (id-dedup so SWR revalidation reconciles, no
  duplicate).
- **RV14 (LOW) — tests + display name.** Added `prependCompactionChunks`,
  `stripCompactionTraceParts`, `buildCompactionTraceMessage`, and trace-gating
  tests (backend suite 1096 pass). `humanizeToolType` maps `compact_context` →
  "Context compaction".

---

## Chunk 12 — remove per-agent compaction config, go global+per-model (planned, decided 2026-06-12)

**Decision.** Drop ALL per-agent compaction tuning shipped in chunk 10. Compaction
behavior becomes global (`DEFAULT_COMPACTION_CONFIG` + the `COMPACTION_ENABLED`
env kill switch); only window/output **size** stays per-model via the §A resolver.

**Why.** The 2026-06-12 field re-survey: no surveyed agent (Hermes, Codex CLI,
Claude Code, Cline) exposes per-agent compaction knobs — all use global config +
per-model window. Trigger/target are fractions of an already model-normalized
`inputBudget`, so per-agent variance is speculative generality. The agent-edit
form clutter is real cost for a feature ~100% of agents leave at default (every
agent on the test server has all six columns NULL).

**Trade-off (accepted).** Removing per-agent `compactionEnabled` loses the ability
to disable compaction for a single agent (e.g. an exact-recall code/legal agent
where lossy summarization corrupts output). Mitigation: the global
`COMPACTION_ENABLED` env still exists, and recovery (§E, P4) keeps such an agent
from hard-failing on overflow regardless. If a real need for single-agent opt-out
appears, revisit as a **per-model or per-workspace** flag — NOT per-agent.

**Change list.**

- `packages/schemas/index.ts` — remove `compactionEnabled`, `triggerRatio`,
  `targetRatio`, `reserveRatio`, `keepRecentMessages`, `minPrunableChars` from
  `agentSchema` + the `agentCreate`/`agentUpdate` picks; delete the
  `compactionRatioOrder` refinement (+ its `index.test.ts` cases).
- `apps/backend/src/db/schema.ts` — drop the six `agent` columns.
- New migration — `ALTER TABLE "agent" DROP COLUMN IF EXISTS ...` ×6. `IF EXISTS`
  because divergent-lineage server DBs (see deploy notes) may not have all six;
  destructive but safe — the columns hold only tuning overrides, NULL in practice.
- `apps/backend/src/runs/compaction.ts` — `resolveCompactionConfig` returns
  `DEFAULT_COMPACTION_CONFIG` unconditionally; delete `CompactionConfigOverrides`
  and the per-agent merge. Keep `DEFAULT_COMPACTION_CONFIG` + `computeBudget`.
- `apps/backend/src/services/chat-execution.ts` — drop the `agent` argument to
  `resolveCompactionConfig`; keep the `COMPACTION_ENABLED` env override.
- `apps/frontend` — remove the six compaction fields from the agent-edit form.

**Verify.** Agent create/update no longer accepts the six fields; chat still
compacts using defaults; `COMPACTION_ENABLED=false` still disables proactively;
recovery still fires when proactive is off; migrate is idempotent on a DB missing
some columns.

---

## Chunk 13 — compaction reliability + prompt overhaul (planned, 2026-06-12)

Chunk 12 shipped (`625ff96` + dead-`agent`-binding cleanup + env-override knobs
`da2c159`). Live test-server run on a single-vLLM provider (`qwen36`, lowered
ceiling via `.env`: trigger 0.2 / target 0.1 / keepRecent 4 / minPrunable 500)
surfaced a turn-killing bug + several prompt/UX gaps. All findings + fixes below.

### Observed bug — per-step timeout kills pre-stream compaction

Live log evidence (chat `hur61ZR79koiHQysBDS2o`):

- Trigger fired (`projected` 63,511 > `triggerTokens` 48,988).
- `summarize` ran **149,955 ms** on `qwen36`, **input 6,178 → output 8,631 tokens**
  (the summary was LONGER than its input — degenerate expansion, not compression).
- The run's **per-step stall timeout (120,000 ms) fired at ~120 s** → `level:50
"Run timed out" kind:"step"` → run aborted ~30 s **before** summarize returned.
- `summarize` ignored the abort, finished at 150 s, committed the watermark →
  `context-compacted` logged (dropped 9, 63,511 → 14,785). But the turn was already
  dead → **no model answer streamed, and the turn's assistant message was lost.**

Root cause: Tier-1 `summarize()` is a long blocking call that runs **inside
`prepareChatTurn`, before the response stream opens**, and does **not bump the
per-step stall timer**. The 120 s watchdog treats it as a stalled step and kills
the run.

Why the turn vanished from the chat: two separate writes. The durable
summary/watermark is a CAS write on the **chat row** (survived — later turns have
the summary, persisted value is a clean **770-char / ~193-token** structured
summary). The turn's **assistant message** (answer + the synthetic `compact_context`
trace part) only persists via the **response stream**, which never opened. So the
chat-row state advanced but the visible turn was lost.

Note: the 8,631-token runaway was the timed-out turn and was **discarded** — the
persisted summary is the good 193-token one. So `qwen36` _can_ summarize tightly;
the 8,631 was a pathological one-off. Confirms a `maxOutputTokens` ceiling loses
no context in normal operation (healthy output is ~10× below a 2k ceiling).

### Fixes (in priority order)

1. **Heartbeat during summarize (CRITICAL).** Compaction is legitimate long work,
   not a stall. Ping `onActivity` / bump the per-step timer on an interval while
   `summarize` runs so the 120 s watchdog keeps resetting. Directly stops the
   spurious kill. (`buildCompactionRuntime` already has `onActivity` in scope via
   the turn; thread it into the summarize wrapper, tick ~every 10 s.)

2. **`maxOutputTokens` ceiling (~2,000) + "be concise" prompt instruction.** Pure
   safety backstop against the runaway — NOT a blind truncation. The prompt asks
   the model to compress _to fit_ (length target); the ceiling only catches a
   degenerate run. Proven safe: real summaries are ~193 tokens. Also log
   `finishReason === "length"` so we know if the cap ever bit.

3. **Open the response stream BEFORE compaction (bigger refactor).** Today the
   synthetic `compact_context` chunks are injected post-hoc by `prependCompactionChunks`
   as a paired `tool-input-available` + `tool-output-available` — i.e. already
   "Completed", emitted only after the (already-open-too-late) model stream's
   `start`. To show live **Pending → Running → Completed** AND keep the HTTP /
   playit-tunnel connection alive during the wait (a second timeout vector):
   - Split the cheap trigger decision (`projectTier1Tokens` vs `triggerTokens`, no
     LLM) from the expensive `summarize`, so we know to emit the pending chunk
     before paying for summarize.
   - Build a prelude stream: `start` + `tool-input-available(compact_context)` →
     await summarize → `tool-output-available` → concat the model stream (suppress/
     merge the model's own `start` so the synthetic part + answer share one message
     id). Replaces the post-hoc `prependCompactionChunks` injection.
   - Move the compacted-messages await out of `prepareChatTurn` into the stream step.
   - Frontend is **already done** — `tool.tsx` renders `input-available` = "Running"
     (pulsing clock), `output-available` = "Completed". Zero frontend change.
   - Error path: if `summarize` throws after the pending chunk shows, resolve the
     tool part to `output-error` — do not leave it stuck "Running". Tier-1 stays
     best-effort (fail → proceed uncompacted) but must close the tool part.
   - Preserve invariants: `stripCompactionTraceParts` + snapshot persistence expect
     a well-formed input+output pair; tee/snapshot drain must see prelude chunks.

4. **Pass `abortSignal` into `summarize` (minor correctness).** Today summarize
   burned 30 s + a full LLM call _after_ the turn was dead. Make it cancellable so
   a real abort stops it. Fold into #3.

### Prompt overhaul

Current prompt (`chat-execution.ts` ~L578) is an unstructured one-liner with **no
length instruction** (the runaway's root). Prior-art survey of real summarization
prompts (2026-06-12):

- **Claude Code** — heaviest: chronological analysis + **9 sections** (Primary
  Request & Intent, Key Technical Concepts, Files & Code, Errors & fixes, Problem
  Solving, All user messages, Pending Tasks, Current Work, Optional Next Step);
  security-relevant instructions preserved **verbatim**.
- **Codex CLI** — handoff-oriented: _"You are performing a CONTEXT CHECKPOINT
  COMPACTION. Create a handoff summary for another LLM that will resume the task."_
  - 4 sections (progress & decisions · context/constraints/prefs · what remains ·
    critical data/refs). Prepends a **resume prefix** next turn (_"Another language
    model started to solve this problem and produced a summary…"_) so the resumer
    builds on prior work instead of restarting. Issue #14347: sections **reduce loss
    over repeated compactions**.
- **OpenCode** — 6 sections (done · WIP · files · next steps · user requests/
  constraints · decisions & rationale).
- **Hermes Agent** — weakest: just _"Summarize these conversation turns concisely"_
  → `[CONTEXT SUMMARY]: <raw>`, positional keep (first 3 + last 4 turns), Gemini
  Flash aux model. Open issue #499 proposes **copying Codex's structured handoff**
  — Hermes is behind us, not ahead.

Gaps vs prior art: (a) no length instruction → the runaway; (b) no section
structure → erodes across repeated re-compactions (we feed the prior summary back
in via `priorSummaryTokens`); (c) no "build on prior work" framing (our
`summaryUIMessage` prefix `[Summary of earlier conversation]` is just a label).

**Proposed replacement system prompt** (handoff + sections + concise + integrate-
prior; pairs with the #2 ceiling):

```
You are performing a context checkpoint compaction. Another instance of this
assistant will resume using ONLY your summary plus the most recent messages —
earlier history will be gone. Write a dense markdown handoff under these
headings (omit one only if truly empty):

- **Intent & open requests** — what the user wants, the latest explicit request, pending tasks.
- **Decisions & facts** — conclusions, confirmed values/IDs/paths, constraints and user
  preferences (preserve any security-relevant instruction verbatim).
- **Files & tools touched** — what was read/changed and why.
- **Current state & next step** — where things stand and the immediate next action.

If a prior summary appears in the history, integrate it — don't drop facts it
captured. Be concise: aim under ~1500 tokens. Output only the summary.
```

### Deferred / decided-against here

- **Selectable compaction model in provider UI** — DECIDED NO. The compaction
  model already = `provider.taskModelId` (same-provider only: summarize runs through
  the chat provider's own client `opened.languageModel(taskModelId)`). On a single
  vLLM (`modelIds` has one entry) there is no other model to pick, so a dropdown is
  a no-op. `workspace.taskModelProviderId` routes _other_ task work (tag/title) to a
  different provider but compaction does NOT use it. A separate fast compaction
  endpoint would need new wiring (route summarize through a task provider's client) +
  multi-model infra (2nd provider or a LiteLLM gateway) — not worth it now.

### Verify (Chunk 13)

Compaction no longer trips the per-step timeout (heartbeat); a slow summarize
streams a Running tool part instead of a blank turn; summary output is bounded
(`finishReason` logged if capped); the compacted turn's assistant message + trace
persist even when summarize is slow; the new prompt yields structured, concise,
multi-compaction-stable summaries.

---

## Chunk 14 — kept-message tool-result handling (planned, 2026-06-14)

Origin: live event on the test server — compaction fired but missed target badly
(`tokensAfter=75226` vs `targetTokens≈24000`). Cause: 4 recent messages were
massive mempalace (MCP) tool-result JSON dumps. Step 1 (drop prefix) already
collapses prefix tool results via `softTrim(out, 200)` in `renderUIMessages`, so
the summarizer only saw ~2.5k input tokens — but `keptMessages: recent` was
returned **verbatim**, so the bulky kept results dominated `tokensAfter`.

### The two-tier reality (established this session)

- **Tier 2 (`compactModelMessages`, `prepareStep`)** runs _between tool steps in
  one stream_. It prunes **prefix only**; `recent` is passed **verbatim**
  ([compaction.ts](apps/backend/src/runs/compaction.ts) `[summaryModelMessage(...), ...recent]`).
  So current-stream tool results are never trimmed mid-stream. **Caveat:** the
  keep-window is the last `keepRecentMessages` _messages_ counted flat, and in
  ModelMessage form a tool call + its result are two messages — so in a >5-tool
  stream the _early_ results of the same stream scroll into the prefix and DO get
  summarized mid-stream. Tier 2 protects the tail, not the whole stream.
- **Tier 1 (`compactUIMessages`)** runs _between turns_. The just-finished
  stream's tool results are the newest messages → land in `recent`. This is the
  only place a result the user is actively asking about can be trimmed.

### Mapping to Anthropic's shipped mechanisms (claude-api skill, 2026-06-14)

The Anthropic API converged on **three** complementary layers; Platypus today has
only the summarize leg:

1. **Compaction** — summarize earlier context near the window limit (beta
   `compact-2026-01-12`). ≈ Platypus Tier 1/Tier 2.
2. **Context editing (`clear_tool_uses`)** — _prune_ stale tool results + thinking
   blocks at configurable thresholds, keeping conversation structure; "keeps the
   transcript lean **without summarizing**." Platypus does NOT have this. → Task 2.
3. **Ingestion offload** — Managed Agents auto-offloads any MCP tool result
   > 100K tokens to a sandbox file, returning a truncated preview + path. An
   > ingestion cap, not compaction — the only real fix for "one result too big to
   > fit the window at all." → Task 3.

### Task 1 — make Tier 1 recent-trim safe (READY; partially shipped)

**Shipped 2026-06-14 (`64232d8`, on `test/compaction-clean-deploy`, deployed):**
recent tool results pruned via `pruneUIMessage(m, minRecentPrunableChars)` (default
`minPrunableChars * 5` = 10000 chars) across every over-target return path
including the empty-prefix / null-watermark bail; warns when post-compaction
estimate > `targetTokens * 2`; env override `COMPACTION_MIN_RECENT_PRUNABLE_CHARS`;
summarizer output ceiling 2000 → 4000.

**Still to do — adopt "option D" (overflow-gate + exempt newest)** so we stop
gutting active data for a _soft_-target miss:

- Missing `targetTokens` (0.5) is cheap — it's a hysteresis goal; the call still
  succeeds as long as `recent < inputBudget`. The hard wall is `inputBudget`
  (window − output reserve − safety, from `computeBudget`).
- Gate recent-trim on `estimate(recent)+summary > inputBudget` (call would
  actually overflow), NOT on the soft target. Below the wall, leave `recent`
  intact — full fidelity, just a missed hysteresis target that re-compacts next
  turn (cheap; empty-prefix path makes no summarizer call).
- Always exempt the single newest message regardless.
- Requires threading `inputBudget` into `UICompactOptions`.
- This is strictly better than the alternatives we weighed (B: exempt newest N —
  still over-trims under the test box's 0.1 target; A: raise threshold to 100k —
  reduces frequency only; C: revert — loses the pathological-dump guard). The test
  server's `COMPACTION_TARGET_RATIO=0.1` manufactures the worst case; prod 0.5
  rarely trips it.

### Task 2 — context-editing-style prune of kept tool results (NEEDS REVIEW + bigger plan)

The user's ideal model (decided 2026-06-14): in-stream, only compact near the
ceiling so the stream doesn't stop (Tier 2 already does this); **at stream end,
strip bulky tool results so the next turn doesn't start at 40k** (NEW); then
threshold-compact as chat continues (Tier 1 already does this). This is exactly
Anthropic's **context editing (`clear_tool_uses`)** — prune, don't summarize.

Design notes captured this session (to expand before implementing):

- The current "keep last N _messages_ verbatim" heuristic is backwards: in a
  > 10-tool stream the keep-window fills with raw tool results while the small,
  > high-value conversational text (question + answer) gets summarized into the
  > prefix. A type-aware policy is better: **keep conversational text + the newest
  > turn's results verbatim; compress older bulky results to placeholders.**
- Implement as a **model-view transform**, not destruction — full result stays in
  the DB/UI (display/audit); only the lean version is _sent_ to the model each
  subsequent turn. Platypus already separates stored messages from the model view
  (watermark + summary reconstruction), so this fits.
- Keep tool call↔result structural validity: replace the result _content_ with a
  short placeholder marker (`[mempalace result, 40k chars — elided after turn N]`),
  don't drop the message (providers reject an orphaned call). Size-gate it — tiny
  results (`"OK"`) gain nothing from a placeholder.
- The unavoidable tradeoff: eager stripping loses the immediate "based on those
  results, do X" follow-up. Options: (a) strip immediately + agent re-calls if
  needed; (b) placeholder-with-summary so the model can re-fetch intelligently
  (recommended); (c) one-turn grace (keep the just-finished turn's results one
  more turn). User's "next turn must not carry 40k" leans toward (b).
- Anthropic's `clear_tool_uses` is **threshold-triggered** with configurable
  thresholds, not strictly "every stream end" — decide whether to mirror that or
  go eager at each turn boundary.

This is a redesign of the compaction unit (messages → type-aware policies keyed
off turn boundaries), bigger than Task 1, and overlaps Task 3. Review before
building.

### Task 3 — ingestion cap for oversized MCP / sub-agent results (UPSTREAM ISSUE — file so we don't forget)

No tier can fix a _single_ result larger than the window by trimming other
messages. Today: sandbox tools self-cap (ADR-0002, `truncated` flag), but **MCP
tools (mempalace) and sub-agent returns have no cap** — one oversized result
overflows all tiers (Tier 2/recovery never prune `recent`) → provider reject →
error. The fix is an **ingestion cap at tool-result storage time** (mirror the
sandbox/ADR-0002 pattern and Anthropic's 100K MCP offload): truncate/offload the
oversized result, set a `truncated`-style marker, tell the model to narrow /
re-fetch. Lives in tool wrapping + agent-runner, not compaction.

**Action: file as an upstream issue on `willdady/platypus`** (per the issue-tracker
skill). Marked here so it isn't lost; not yet filed.

---

## Open / deferred decisions

- **OpenAI-compatible as a separate provider type** — not required (auto-detect
  probes `max_model_len` regardless of label). Deferred.
- **Persisting Tier 2** — deferred; revisit only if storing tool outputs verbatim
  is itself a problem.
- **Anthropic exact token counting** via `/v1/messages/count_tokens` — optional
  accuracy upgrade; deferred.
- **Projected-input arc on the ring (drift U2)** — char/4 of composer text added
  as a faint arc. Deferred; the honest tooltip label ships instead.
- **CAS contention optimization (drift R4)** — under a contended chat, the
  version is read → summarize (seconds) → CAS write, so the version can be stale
  by write time → wasted summarize (not corruption; loser skips safely). Bounded
  by one-retry-then-skip. **Do NOT fix now.** Gated on the `cas.conflict` metric
  (now emitted, chunk 10); if it shows repeated waste, move the version read to
  just-before-write or take a short advisory lock for the summarize window.

### Deliberately NOT done in chunk 10 (2026-06-11) — with reasons

The RV7e-RV10 + observability sweep closed the review backlog; these four were
left undone **on purpose**, not missed:

- **RV9 digest-based C4 check** — once a watermark exists, C4 reads the full
  `messages` JSONB row and `stableStringify`-compares the whole prefix every
  turn. The compare is already **correct** (RV1 landed); a content digest would
  only make it cheaper. Pure optimization of a correct path → revisit only if the
  per-turn read+stringify shows up in profiling, and fold it into any future
  C4 rework rather than touching the correctness path now.
- **defect 7 — `content`-type tool output base64 → char/4** (`token-estimate.ts`).
  The `content` tool-result variant `stableStringify`s media bytes into the
  char/4 blob. Fixing it **symmetrically** (so estimate(UI) === estimate(Model)
  still holds — the load-bearing P2/T1 invariant) requires extracting media into
  `nonText` on BOTH adapters, where the UI side stores `output` as untyped
  `unknown`. The risk to the tested invariant outweighs the benefit: **no current
  tool emits `content`-type media**. Fix before the first tool that does.
- **`bytesFromUrl` vs storage/utils `parseDataUrl` duplication** — merging them
  couples the estimator to the storage layer for zero behaviour change. Left as
  two small private regexes.
- **`estimate_vs_real.divergence` metric** (drift T2 feedback loop) — deferred
  with the image-constant tuning work it feeds; still log-only.
- **Trigger estimator scope — FIXED (drift C1).** Originally flagged from live
  test 2026-06-03; confirmed unfixed in chunk 2 by the 2026-06-09 review. **Both
  prescribed paths now landed:**
  1. **DONE 2026-06-10** — `estimateOverheadTokens` adds the system prompt + tool
     schemas to the projection (`projectTier1Tokens`) and subtracts them from the
     compaction target (the ~986-vs-8888 gap was dominated by tool schemas).
  2. **DONE 2026-06-11** — the ADR-prescribed prior-turn provider baseline is
     wired: `prepareChatTurn` threads `lastInputTokens` from the last assistant
     message's `metadata.stats.contextTokens`; `projectTier1Tokens` returns
     `max(charBased, lastInputTokens)` so turns ≥ 2 are floored by the real
     provider count instead of trusting char/4.

  The Qwen3.6 / vLLM under-count (provider 8888 vs estimate ~986) is closed: the
  projection now sees both the tool-schema overhead and the prior-turn provider
  count, so it no longer blows past the trigger silently.

---

## Drift log & code-review checklist

Every issue found across 4 review rounds, the resolution, and **the exact thing
to re-verify once the code exists.** Round trajectory: R1 design holes → R2
second-order effects → R3 a third-order race → R4 zero correctness findings (one
telemetry-gated note). This is the anti-regression list — check it at PR time.

| ID      | Issue                                                                                      | Resolution                                                                                                                                             | ✅ Verify in code                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1**  | Trigger only counted last response, not what this turn adds                                | `projected = lastInputTokens + estimate(newMsgs)`                                                                                                      | Trigger sums unsummarized new messages, not just last `usage`                                                                                  |
| **C2**  | Compacting to the trigger ratio re-fires next turn (Cline #5616 thrash)                    | Hysteresis: target 0.5 ≠ trigger 0.8                                                                                                                   | Post-compaction output `<= targetTokens`; a follow-up turn does not re-compact                                                                 |
| **C3**  | Raw window ratio ignored output + safety headroom                                          | `inputBudget = window − maxOutputReserve − safetyReserve`                                                                                              | Budget subtracts both reserves before ratios                                                                                                   |
| **C4**  | Edit/delete/regenerate below watermark → stale summary                                     | Invalidate via `writeWatermark`: version bump + clear summary + reset watermark                                                                        | Every edit/delete/regenerate handler calls `writeWatermark`; forking below watermark resets on new branch                                      |
| **M1**  | Cold-start on huge imported history exceeds summarizer's own window                        | Chunked / map-reduce summarize                                                                                                                         | Prefix larger than summarizer window is chunked, not sent whole                                                                                |
| **M2**  | First-turn char/4 underestimate                                                            | `× 1.15` margin + recovery net                                                                                                                         | First-turn projection applies the margin                                                                                                       |
| **M3**  | "Both tiers apply to sub-agents" was wrong                                                 | Sub-agents = Tier 2 only (no durable history)                                                                                                          | Sub-agent path wires Tier 2 + window only, no Tier 1                                                                                           |
| **T1**  | Tier 1 (UIMessage) and Tier 2 (ModelMessage) measured by different estimators → divergence | **One** `estimateTokens` over `CountUnit[]`, two adapters; `MODEL_BOUND` filter excludes UI-only parts both sides                                      | No second estimator exists; equality test passes exactly on filtered set; UI-only parts (reasoning/source/step/data) never counted             |
| **T2**  | char/4 on base64 images is meaningless; ordering vs inline unclear                         | Modality table (anthropic/openai/default), header-parse dims w/ constant fallback, detail→high; estimate AFTER `inlineFileUrls`; divergence `log.warn` | No char/4 on image bytes; Tier 1 runs post-inline; missing dims → 1200; turn-2 divergence logged                                               |
| **T3**  | Recovery compaction vs "single durable writer"; finalize-mid-error ambiguous               | Recovery does in-memory trim via `compactModelMessages` + sets persisted `compactionDirty`; durable write on NEXT `prepareChatTurn` only               | Recovery never writes summary/watermark directly; `compactionDirty` is a DB column; recovery trim calls the Tier 2 adapter, not a bespoke trim |
| **T4**  | litellm registry keys don't match our model IDs                                            | Normalization chain + alias map + `log.warn` on MISS                                                                                                   | Lookup tries exact→strip-prefix→lower→alias→family; Bedrock ARN / Azure resolve or log a miss                                                  |
| **T5**  | Window cache stale after override edit                                                     | `cache.evict(providerId)` in provider PATCH, immediate                                                                                                 | Editing modelMeta busts cache without waiting TTL                                                                                              |
| **T6**  | 8192 default silently over-compacts                                                        | `log.warn` on default; ring renders **neutral**, no false ramp                                                                                         | Fall-to-default is logged; ring is grey/no-% when window unknown                                                                               |
| **T7**  | `taskModelId` may be unset                                                                 | Fallback `taskModelId → main`; log model + cost                                                                                                        | Summarizer falls back to main model; no crash on unset                                                                                         |
| **T8**  | char/4 underestimates CJK/JSON                                                             | Accepted; margin + real-usage handoff + recovery net                                                                                                   | (No code; documented as text-only heuristic)                                                                                                   |
| **T9**  | One synthetic 400 doesn't cover per-provider error bodies                                  | Fixture set: OpenAI / Anthropic / Google-vLLM                                                                                                          | `isContextOverflowError` matrix tests real per-provider phrasings                                                                              |
| **T10** | CAS rejects stale write but loser behavior undefined → livelock risk                       | Re-read; if winner advanced → SKIP+clear-dirty; else retry once then SKIP                                                                              | Loser never recompute-loops; terminal state is skip; decides by version                                                                        |
| **R1**  | Loser-skip assumed monotonic watermark; C4 reset moves it backward → stale write back door | All writes (advance/reset/dirty) through one versioned CAS; loser compares **version** not watermark value                                             | Single `writeWatermark`; invalidation bumps version; no path mutates these fields outside it                                                   |
| **U1**  | Ring showed previous model's window after a model switch                                   | Resolve window from **selected** model, not last-message metadata                                                                                      | Ring reads selected-model window from `modelMeta`, refreshes on switch                                                                         |
| **U2**  | Ring lags pending composer input                                                           | Required tooltip label "current input not yet counted"; arc deferred                                                                                   | Tooltip text present and unmistakable                                                                                                          |
| **U3**  | Forced-compact confirm too soft                                                            | Confirm default-ON when drop significant (`>keepRecent` or `>30%`)                                                                                     | Threshold confirm wired; (P1: not destructive anyway)                                                                                          |
| **U4**  | No feedback for defer-while-streaming click                                                | Pending badge + disabled ring + "will compact on finish" tooltip                                                                                       | Ring disables + shows pending state between click and finish                                                                                   |
| **R4**  | CAS read→summarize→write window wastes summarize under contention                          | Accepted, **not fixed**; gated on `cas.conflict` metric                                                                                                | `cas.conflict` metric emitted; no premature lock added                                                                                         |
| **P1**  | (principle) compaction misread as data loss                                                | View-not-delete: raw messages persist                                                                                                                  | No code path hard-deletes a summarized message                                                                                                 |

---

## Appendix: prior art & review

### Prior art (open-source tools surveyed)

| Tool         | Strategy                                 | Window source                                 | Threshold                                               | Pitfall                                          |
| ------------ | ---------------------------------------- | --------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| Open WebUI   | none (BYO filter), errors out            | `num_ctx` (Ollama only)                       | n/a                                                     | silent overspend on API providers                |
| LibreChat    | **both**: prune tool results → summarize | `maxContextTokens` (yaml)                     | trigger on prune; `reserveRatio` 0.05                   | ignored on some endpoints                        |
| LangGraph    | `trim_messages` vs `SummarizationNode`   | you supply                                    | you set                                                 | trim breaks tool pairs                           |
| llama.cpp    | context-shift or HTTP 400                | `--ctx-size`, `--keep N`                      | off by default                                          | infinite shift loop / hard 400                   |
| Ollama       | silent clip                              | `num_ctx` (default 2048)                      | clips                                                   | silent token loss                                |
| Cline        | **summarize at %**                       | reads window − model buffer                   | `autoCondenseThreshold` (0-1)                           | **thrash (cline #5616)**                         |
| Claude Code  | **summarize at %**                       | reads window, live meter                      | ~83.5%, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`               | ~33k buffer reserved for compact                 |
| Codex CLI    | prune-from-memory → summarize            | `ctx − min(maxOut,20k)`                       | `effective − 13k`; **hard 90% cap**                     | freezes near threshold (#19116)                  |
| Hermes Agent | prune tool results → summarize           | provider metadata + `context_length` override | **0.50** primary + **0.85** hygiene net + 400-msg valve | token **floor** breaks sub-floor models (#14690) |
| OpenRouter   | middle-out truncate (gateway)            | `/models.context_length`                      | on overflow                                             | drops middle silently                            |
| litellm      | `trim_messages` (trim_ratio 0.75)        | **model registry JSON**                       | ratio                                                   | orphaned tool-call msgs                          |

Borrowed: litellm registry (§A), `reserveRatio` headroom (§C), prune-then-summarize
staging (§C), hysteresis vs thrash (§C), fail-loud event (§C), live usage meter (§H).

Sources: Open WebUI context-window docs + discussions #4983/#6402; LibreChat
summarization/model_specs/token_usage docs; LangGraph add-memory docs; llama.cpp
server README + issues #17284/#3969; Cline auto-compact docs + issue #5616;
litellm token_usage/message_trimming docs + `model_prices_and_context_window.json`;
OpenRouter models + message-transforms docs; vLLM engine args; Codex CLI compaction
docs + issues #11805/#19116; Claude Code auto-compact env override + issue #41818;
Hermes Agent context-compression docs + issues #12626/#14690.

### Field re-survey (2026-06-12) — verified complete vs Hermes / Codex / Claude Code / Cline

Re-checked the shipped implementation against the four agents above. **Every
"gap" the survey suggested is already implemented** — the design is at or ahead
of the field:

- **Real provider-token feeding** — already done (C1). `projectTier1Tokens`
  returns `max(charBased, lastInputTokens)`; the estimate is the cold-start
  fallback (turn 1, no prior `usage`) and the stale-tail top-up, not a
  replacement. Strictly safer than Hermes (which only falls back to estimate).
- **Input-tokens-only window** — already done (F1). `windowFromRegistryEntry`
  trusts only `max_input_tokens`, never litellm's `max_tokens` (the output cap).
- **Reserve carve / "90% cap" equivalent** — already done (C3). The trigger is a
  fraction of `inputBudget = window − maxOutputReserve − safetyReserve`, so even
  `triggerRatio = 1.0` (the schema max) fires below the raw window. Codex's hard
  90% clamp is structural here, not a separate clamp.
- **Two-layer (proactive + always-on recovery)** — P4; matches Hermes
  primary+hygiene and Claude's auto-compact+buffer.

**The token-FLOOR anti-pattern (Hermes #14690) — explicitly DO NOT copy.**
Hermes clamps the _trigger_ up with `max(ctx·pct, 64000)`, which exceeds the real
window on any sub-64k model → compaction never fires → silent overflow. Our
fraction-of-`inputBudget` trigger is inherently safe at any window size; a floor
belongs only on the _window fallback_ (`detected ?? DEFAULT`, never
`max(detected, FLOOR)`), which §A already does.

**Genuinely-absent, deferred (optional — not bugs):**

- **Message-count force-compact valve** (Hermes 400-msg `hygiene_hard_message_limit`).
  A count-based backstop independent of the token estimate — catches a blown
  estimator that the recovery net would otherwise have to absorb. Cheap; consider
  if the `estimate_vs_real.divergence` signal ever shows the estimator drifting.
- **`maxOutputReserve` floor when max-output is unknown.** `computeBudget` reserves
  `maxOutputTokens ?? min(4096, 0.25·ctx)`; a reasoning model with a large real
  output but no resolved `max_output_tokens` could under-reserve. Recovery covers
  it today; revisit only if overflow-on-output shows up for such a model.
- **Model-aware aggressiveness** (Cline trims 75% on small windows vs 50%). Marginal;
  our fixed `targetRatio` is adequate. Deferred.

### Review change log (applied to this doc)

- **C1–C4, M1–M3** — see drift table.
- **A** litellm registry replaces homegrown lookup table.
- **T1–T10, R1, R4, U1–U4** — round 2-4 findings, see drift table.
- **P1–P4** — design principles extracted from the review consensus.
- Added: prune-before-summarize Stage 1, fail-loud `context-compacted` event,
  Observability section, global kill switch, lazy-rollout note, ADR (queued:
  `docs/adr/NNNN-context-compaction.md` capturing the _why_ — two tiers,
  view-not-delete, CAS-on-version, char/4-not-tokenizer).
