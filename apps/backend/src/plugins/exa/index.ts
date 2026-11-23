import type {
  PlatypusPlugin,
  WebBackendContribution,
} from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import Exa from "exa-js";
import { z } from "zod";

const exaCredentialsSchema = z.object({ apiKey: z.string().min(1) }).strict();

type ExaCredentials = z.infer<typeof exaCredentialsSchema>;

const exaBackend: WebBackendContribution<unknown, ExaCredentials> = {
  backend: "exa",
  name: "Exa",
  createExecutors: (_ctx, plugin) => {
    const exa = new Exa(plugin.credentials.apiKey);
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

export const plugin: PlatypusPlugin<unknown, ExaCredentials> = {
  name: "@platypus/exa",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  credentialsSchema: exaCredentialsSchema,
  contributes: {
    webBackends: [exaBackend],
  },
};
