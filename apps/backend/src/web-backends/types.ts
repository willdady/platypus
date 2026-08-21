import type { Tool } from "ai";
import { z } from "zod";
import type { WebBackendContext } from "@platypuschat/plugin-sdk";
import type { WithCoreRegistrar } from "../tools/closers.ts";

// The SDK is the single home of the executor-facing contract; core re-exports the
// types its internal callers need so nothing below imports the SDK directly.
export type {
  ReadUrlResult,
  WebBackendContext,
  WebBackendContribution,
  WebBackendExecutors,
  WebExecutorOptions,
  WebSearchResult,
  WebSearchResults,
} from "@platypuschat/plugin-sdk";

// Two of the output bounds live here rather than beside their siblings in
// `index.ts`: the input schemas below reference them, and `index.ts` imports this
// module, so keeping them there forced the schemas to restate the numbers and
// trust a comment to keep the copies in sync. `index.ts` re-exports this module,
// so every existing `MAX_URL_CHARS` / `MAX_READ_URL_CONTENT_CHARS` import from
// there still resolves.
//
// A URL is capped like every other string core hands the model. Unlike
// title/snippet/content_type, an over-length URL is *dropped* rather than
// truncated: a cut URL is a broken link, worse than no link at all. 2048 is
// generous relative to common browser/server URL-length limits.
//
// This bounds *output* only. The `read_url` input below is deliberately
// uncapped: presigned S3 URLs, Azure SAS links and some SharePoint/OAuth URLs
// legitimately run past 2048 chars, and rejecting them at the schema would fail
// as an AI-SDK input-validation error rather than through the graceful
// `{ error }` contract the rest of this module keeps. The returned `url` field
// stays inside the cap regardless, because `composeWebBackend` bounds every
// branch of its fallback chain — including the one that echoes the request.
export const MAX_URL_CHARS = 2_048;
// Mirrors sandbox MAX_READ_BYTES. Accepted limit, stated rather than implied: the
// executor hands core an already-materialised string, so this bounds *context and
// CPU*, not backend memory — a backend that buffers a 500 MB response does so
// before core sees it, and the per-call timeout is the only lever there.
export const MAX_READ_URL_CONTENT_CHARS = 1_000_000;
// What one `read_url` call may return — a separate lever from the cap above, and
// deliberately a smaller number.
//
// The two used to share `MAX_READ_URL_CONTENT_CHARS`, inherited from `fetchUrl`,
// which made the "bounds context" claim on that constant only half true: core
// held at most 1M chars, and a single `max_length: 1_000_000` still put all of
// them (~250k tokens) into the window in one call. Core owns this Tool outright,
// so the levers need not share a number: the cap bounds what core holds *across*
// a paginated read, this bounds any *one* page of it. 100k chars is ~25k tokens —
// a large read that a context can still absorb — and 20× the 5000-char default,
// with `start_index` there for anything longer.
//
// Enforced by **clamping inside `execute`, not by the input schema**, which still
// mirrors `fetchUrl`'s `max(1_000_000)`. A lower schema bound would reject a
// model that learned `fetchUrl`'s ceiling as an AI-SDK input-validation error —
// the same failure mode that capping `url` here was reverted for. Clamping needs
// no error path: the page comes back shorter and `next_start_index` already says
// there is more, which is exactly what a paginating model does next.
//
// Consequence worth stating: a 1M-char page is one `fetchUrl` call and ten
// `read_url` calls. The pagination *contract* — defaults, `next_start_index`, the
// hint text — stays byte-identical; only the page size differs.
export const MAX_READ_URL_SLICE_CHARS = 100_000;

// Core-owned, fixed input schemas (ADR-0014). A backend supplies executors only,
// so every Web-search backend presents the *same* model-facing signature and an
// Agent prompt does not couple to whichever backend an Operator configured.
//
// Tool names are snake_case — a deliberate, documented exception to the repo's
// camelCase tools (`fetchUrl`, `fsRead`…). These fill the slot provider-native
// search occupies, where the vocabulary is already `web_search`, and models carry
// strong priors on that name from the hosted OpenAI/Anthropic tools.

export const webSearchInputSchema = z.object({
  query: z.string().min(1).describe("The search query"),
});
export type WebSearchInput = z.infer<typeof webSearchInputSchema>;

// Mirrors `fetchUrl`'s pagination inputs byte-for-byte — `max_length` default
// 5000 and max 1_000_000, `start_index` default 0 — so a model cannot phrase a
// request that one tool accepts and the other rejects. Both core-owned bounds the
// ADR adds (`MAX_URL_CHARS` on the returned URL, `MAX_READ_URL_SLICE_CHARS` on the
// page) are enforced in `execute` rather than here, for the reason documented at
// each constant: this schema's rejections surface as AI-SDK input-validation
// errors, outside the graceful `{ error }` contract the rest of the module keeps.
export const readUrlInputSchema = z.object({
  // Uncapped on purpose — the one thing `MAX_URL_CHARS` deliberately does not
  // bound. See the note on that constant above: a length cap here would reject
  // legitimately long presigned URLs, and it is the only place `read_url` would
  // diverge from `fetchUrl`'s input.
  url: z.string().url().describe("URL to read"),
  max_length: z
    .number()
    .int()
    .min(1)
    .max(MAX_READ_URL_CONTENT_CHARS)
    .default(5_000)
    .describe("Maximum number of characters to return"),
  start_index: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Start character index for pagination"),
});
export type ReadUrlInput = z.infer<typeof readUrlInputSchema>;

// Model-facing returns. snake_case here, camelCase in the SDK types: this side
// must match `fetchUrl` exactly (see readUrlInputSchema above).

export type WebSearchToolResult = {
  query: string;
  results: Array<{ title: string; url: string; snippet?: string }>;
  answer?: string;
};

export type ReadUrlToolResult = {
  content: string;
  url: string;
  content_type: string;
  truncated: boolean;
  next_start_index?: number;
};

/**
 * What a Tool returns to the model when the call could not be served — a blocked
 * URL, a timeout, or a backend throw. A returned error object, not a rejection:
 * an executor throw must not surface as an AI-SDK tool error and abort the turn
 * (ADR-0014).
 */
export type WebToolError = { error: string };

/**
 * What core passes its own `buildTurnTools`, as distinct from what a Plugin's
 * `createExecutors` is handed.
 *
 * `WebBackendContext` is the plugin-facing shape ADR-0014 fixes at
 * `{ orgId, workspaceId, userId }`. This adds the one field core needs on its
 * own side of the seam and a backend has no business seeing: the id of the
 * Provider row whose `searchSource` named this backend. It is the field an
 * Operator edits — an org-scoped Shared Provider (ADR-0007) is one row serving
 * many Workspaces, so the Workspace alone names a symptom — and it is what the
 * warns raised here log when a turn is left with no search tools (issue #522).
 *
 * It also carries core's own registrar rather than the plugin-facing one: the
 * extra parameter is the attribution a closer's log line needs to name a culprit
 * (see `../tools/closers.ts`). The extra parameter is optional, so this stays
 * assignable to `WebBackendContext`.
 *
 * `composeWebBackend` forwards only the plugin-facing subset onward, so
 * widening this costs the published SDK contract nothing.
 */
export type TurnToolsContext = WithCoreRegistrar<WebBackendContext> & {
  providerId: string;
};

/**
 * One registered Web-search backend. The discriminator string lives in the
 * `provider.searchSource` column.
 *
 * `buildTurnTools` is the finished, guarded builder produced by
 * {@link composeWebBackend}: it resolves the backend's executors for this turn
 * and returns core-built `Tool`s with the caps, slicing, timeout, egress guard,
 * and error contract already applied. Per-turn callers just `Object.assign` its
 * output onto the turn's tool map.
 *
 * It is `buildTurnTools`, not `createTools`, on purpose: `createTools` is the
 * exact identifier ADR-0014 **rejects** for the contribution factory, so reusing
 * it on core's side of the seam would read as the rejected shape.
 */
export interface WebBackendRegistration {
  backend: string;
  name: string;
  buildTurnTools(ctx: TurnToolsContext): Promise<Record<string, Tool>>;
}
