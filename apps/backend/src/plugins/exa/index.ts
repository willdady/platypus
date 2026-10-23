import type {
  PlatypusPlugin,
  WebBackendContribution,
} from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import Exa from "exa-js";
import { z } from "zod";

// Deploy-time plugin credentials (ADR-0013): the Operator sets the Exa API key
// under PLATYPUS_PLUGIN_CONFIG_EXA, under `credentials`.
const exaCredentialsSchema = z.object({ apiKey: z.string().min(1) }).strict();

type ExaCredentials = z.infer<typeof exaCredentialsSchema>;

const exaBackend: WebBackendContribution = {
  backend: "exa",
  name: "Exa",
  createExecutors: (_ctx, plugin) => {
    const exa = new Exa((plugin.credentials as ExaCredentials).apiKey);
    return {
      web_search: async ({ query }, { signal }) => {
        const res = await exa.search(
          query,
          { numResults: 10, contents: { highlights: true } },
          { signal },
        );
        return {
          query,
          results: res.results.map((r) => ({
            title: r.title ?? r.url,
            url: r.url,
            snippet: r.highlights.join(" … ") || undefined,
          })),
        };
      },
      read_url: async ({ url }, { signal }) => {
        const res = await exa.getContents(url, { text: true }, { signal });
        const page = res.results[0];
        if (!page) {
          // Exa reports a failed crawl per URL in `statuses`, not as an HTTP error.
          const err = res.statuses?.[0]?.error;
          throw new Error(
            `Exa could not read ${url}${err?.tag ? ` (${err.tag})` : ""}`,
          );
        }
        return { content: page.text, url: page.url, contentType: "text/plain" };
      },
    };
  },
};

// Core plugin: the Exa Web-search backend (ADR-0014). Stands alone as a
// gate-able plugin because it sends queries and URLs to a third-party paid API —
// egress an Operator would plausibly want to deny in isolation (ADR-0013).
// Enable it by listing "@platypus/exa" in PLATYPUS_PLUGINS and supplying the API
// key. The discriminator stays the unprefixed core id "exa".
export const plugin: PlatypusPlugin = {
  name: "@platypus/exa",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  credentialsSchema: exaCredentialsSchema,
  contributes: {
    webBackends: [exaBackend],
  },
};
