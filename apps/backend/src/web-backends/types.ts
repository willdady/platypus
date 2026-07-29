import type { Tool } from "ai";
import { z } from "zod";
import type { WebBackendContext } from "@platypuschat/plugin-sdk";

// The SDK is the single home of the executor-facing contract; core re-exports the
// types its internal callers need so nothing below imports the SDK directly.
export type {
  ReadUrlResult,
  WebBackendContext,
  WebBackendContribution,
  WebBackendExecutors,
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
// generous relative to common browser/server URL-length limits. Capping the
// `read_url` input at the same number is what makes the bound an invariant —
// the tool's own `url` field is the fallback when a backend's resolved URL is
// rejected, so an uncapped input would let that fallback exceed the cap.
export const MAX_URL_CHARS = 2_048;
// Mirrors sandbox MAX_READ_BYTES. Accepted limit, stated rather than implied: the
// executor hands core an already-materialised string, so this bounds *context and
// CPU*, not backend memory — a backend that buffers a 500 MB response does so
// before core sees it, and the per-call timeout is the only lever there.
export const MAX_READ_URL_CONTENT_CHARS = 1_000_000;

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

// Mirrors `fetchUrl`'s pagination inputs byte-for-byte (max_length default 5000,
// start_index default 0) so a continuation read reads identically on both tools.
export const readUrlInputSchema = z.object({
  // Capped so the model cannot hand core a URL longer than the one core would
  // accept back from a backend — see MAX_URL_CHARS above.
  url: z.string().url().max(MAX_URL_CHARS).describe("URL to read"),
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
 * One registered Web-search backend. The discriminator string lives in the
 * `provider.webBackend` column.
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
  buildTurnTools(ctx: WebBackendContext): Promise<Record<string, Tool>>;
}
