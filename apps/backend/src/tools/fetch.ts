import { tool } from "ai";
import { z } from "zod";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import robotsParser from "robots-parser";

const USER_AGENT = "PlatypusBot/1.0";

async function checkRobotsTxt(
  url: string,
  ignoreRobotsTxt: boolean,
): Promise<boolean> {
  if (ignoreRobotsTxt) {
    return true;
  }
  try {
    const { origin } = new URL(url);
    const robotsUrl = `${origin}/robots.txt`;
    const response = await fetch(robotsUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      // If robots.txt can't be fetched, assume allowed
      return true;
    }
    const text = await response.text();
    const robots = robotsParser(robotsUrl, text);
    return robots.isAllowed(url, "PlatypusBot") ?? true;
  } catch {
    // On error, assume allowed
    return true;
  }
}

const turndown = new TurndownService({ headingStyle: "atx" });

// The Web Fetch Tool set, parameterised by the plugin's deploy-time config. The
// `@platypus/web-fetch` manifest resolves `ignoreRobotsTxt` from
// PLATYPUS_PLUGIN_CONFIG (ADR-0013) and passes it in here, so the flag is a
// plugin-config value rather than a bare process.env read.
export const createWebFetchTools = (ignoreRobotsTxt: boolean) => ({
  fetchUrl: tool({
    description:
      "Fetch content from a URL on the web. HTML is converted to Markdown to reduce token usage. Supports pagination for large pages.",
    inputSchema: z.object({
      url: z.string().url().describe("URL to fetch"),
      max_length: z
        .number()
        .int()
        .min(1)
        .max(1000000)
        .default(5000)
        .describe("Maximum number of characters to return"),
      start_index: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Start character index for pagination"),
      raw: z
        .boolean()
        .default(false)
        .describe("Return raw content without markdown conversion"),
    }),
    execute: async ({ url, max_length, start_index, raw }) => {
      const allowed = await checkRobotsTxt(url, ignoreRobotsTxt);
      if (!allowed) {
        return {
          error:
            "Fetching this URL is disallowed by robots.txt. Set the @platypus/web-fetch plugin's config.ignoreRobotsTxt to true (via PLATYPUS_PLUGIN_CONFIG) to override.",
        };
      }

      const response = await fetch(url, {
        headers: {
          Accept: "text/markdown, text/html, */*",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(30000),
      });

      const finalUrl = response.url;
      const contentType = response.headers.get("content-type") ?? "";

      let content: string;

      if (contentType.includes("text/markdown")) {
        content = await response.text();
      } else if (contentType.includes("text/html") && !raw) {
        const html = await response.text();
        const dom = new JSDOM(html, { url: finalUrl });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();
        if (article?.content) {
          content = turndown.turndown(article.content);
        } else {
          content = turndown.turndown(html);
        }
      } else {
        content = await response.text();
      }

      const slice = content.slice(start_index, start_index + max_length);
      const truncated = start_index + max_length < content.length;
      const next_start_index = start_index + max_length;

      const result: {
        content: string;
        url: string;
        content_type: string;
        truncated: boolean;
        next_start_index?: number;
      } = {
        content: truncated
          ? `${slice}\n\n[Content truncated. Pass start_index=${next_start_index} to continue reading.]`
          : slice,
        url: finalUrl,
        content_type: contentType,
        truncated,
      };

      if (truncated) {
        result.next_start_index = next_start_index;
      }

      return result;
    },
  }),
});
