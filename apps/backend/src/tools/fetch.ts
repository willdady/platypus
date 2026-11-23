import { tool } from "ai";
import { z } from "zod";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import robotsParser from "robots-parser";
import { WEB_BACKEND_TOOL_MARKER } from "@platypus/schemas";
import { logger } from "../logger.ts";
import {
  checkEgress,
  EGRESS_BLOCKED_MESSAGE,
  guardedFetch,
  MAX_FETCH_BODY_BYTES,
} from "../utils/egress-guard.ts";

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
    const fetched = await guardedFetch(robotsUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    if (!fetched.allowed || !fetched.response.ok) {
      return true;
    }
    const { text } = fetched;
    const robots = robotsParser(robotsUrl, text);
    return robots.isAllowed(url, "PlatypusBot") ?? true;
  } catch {
    return true;
  }
}

const turndown = new TurndownService({ headingStyle: "atx" });

export const createWebFetchTools = (ignoreRobotsTxt: boolean) => ({
  fetchUrl: tool({
    description:
      "Fetch content from a URL on the web. HTML is converted to Markdown to reduce token usage. Supports pagination for large pages.",
    metadata: { [WEB_BACKEND_TOOL_MARKER]: true },
    inputSchema: z.object({
      url: z.url().describe("URL to fetch"),
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
      const egress = await checkEgress(url);
      if (!egress.allowed) {
        logger.warn(
          { tool: "fetchUrl", url, reason: egress.reason },
          "Blocked a model-supplied URL by network policy",
        );
        return { error: EGRESS_BLOCKED_MESSAGE };
      }

      const allowed = await checkRobotsTxt(url, ignoreRobotsTxt);
      if (!allowed) {
        return {
          error:
            "Fetching this URL is disallowed by robots.txt. Set the @platypus/web-fetch plugin's config.ignoreRobotsTxt to true (via PLATYPUS_PLUGIN_CONFIG_WEB_FETCH) to override.",
        };
      }

      const fetched = await guardedFetch(url, {
        headers: {
          Accept: "text/markdown, text/html, */*",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!fetched.allowed) {
        logger.warn(
          { tool: "fetchUrl", url, reason: fetched.reason },
          "Blocked a model-supplied URL or its redirect by network policy",
        );
        return { error: EGRESS_BLOCKED_MESSAGE };
      }

      const finalUrl = fetched.url;
      const contentType = fetched.response.headers.get("content-type") ?? "";
      const body = fetched.text;

      let content: string;

      if (contentType.includes("text/html") && !raw) {
        const dom = new JSDOM(body, { url: finalUrl });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();
        if (article?.content) {
          content = turndown.turndown(article.content);
        } else {
          content = turndown.turndown(body);
        }
      } else {
        content = body;
      }

      const slice = content.slice(start_index, start_index + max_length);
      const truncated = start_index + max_length < content.length;
      const next_start_index = start_index + max_length;

      const note = truncated
        ? `\n\n[Content truncated. Pass start_index=${next_start_index} to continue reading.]`
        : fetched.truncated
          ? `\n\n[Content incomplete: the page exceeded the ${MAX_FETCH_BODY_BYTES}-byte download limit and the remainder was not read.]`
          : "";

      const result: {
        content: string;
        url: string;
        content_type: string;
        truncated: boolean;
        next_start_index?: number;
        incomplete?: true;
      } = {
        content: slice + note,
        url: finalUrl,
        content_type: contentType,
        truncated,
      };

      if (truncated) {
        result.next_start_index = next_start_index;
      }
      if (fetched.truncated) {
        result.incomplete = true;
      }

      return result;
    },
  }),
});
