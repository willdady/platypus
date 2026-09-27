import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateText, type Tool } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { MCPTransport } from "@ai-sdk/mcp";
import type { mcp as mcpTable } from "../db/schema.ts";

/**
 * The Last-known tool listing (ADR-0029, issue #635), against the real
 * `@ai-sdk/mcp` client — unlike `tool-session.test.ts`, which mocks it — so the
 * byte-identity claim is tested on the request a Provider would actually send.
 * Only the transport is faked: an in-memory MCP server a test can take down.
 */

vi.mock("../index.ts", () => ({ db: {} }));
vi.mock("../services/event-dispatch.ts", () => ({ dispatchEvent: vi.fn() }));
vi.mock("../services/sub-agent-validation.ts", () => ({
  validateSubAgentAssignment: vi.fn(),
}));
vi.mock("../storage/index.ts", () => ({ getStorage: vi.fn() }));

const { server } = vi.hoisted(() => ({
  server: {
    up: true,
    tools: [] as Array<Record<string, unknown>>,
    opened: 0,
    closed: 0,
  },
}));

const fakeTransport = (): MCPTransport => {
  const transport: MCPTransport = {
    start() {
      if (!server.up) return Promise.reject(new Error("connect ECONNREFUSED"));
      server.opened++;
      return Promise.resolve();
    },
    send(message) {
      if (!("method" in message) || !("id" in message))
        return Promise.resolve();
      const params = (message.params ?? {}) as Record<string, unknown>;
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fake", version: "1" },
            }
          : message.method === "tools/list"
            ? { tools: server.tools }
            : {
                content: [
                  { type: "text", text: `called ${String(params.name)}` },
                ],
              };
      queueMicrotask(() =>
        transport.onmessage?.({ jsonrpc: "2.0", id: message.id, result }),
      );
      return Promise.resolve();
    },
    close() {
      server.closed++;
      transport.onclose?.();
      return Promise.resolve();
    },
  };
  return transport;
};

vi.mock("../services/mcp-oauth-provider.ts", () => ({
  buildMcpTransportConfig: () => fakeTransport(),
}));

import {
  LAST_KNOWN_LISTING_MAX_AGE_MS,
  openToolSession,
  type ToolSessionScope,
} from "./tool-session.ts";
import { callTool as call } from "../test-utils.ts";

type McpRow = typeof mcpTable.$inferSelect;

const scope: ToolSessionScope = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  frontendUrl: undefined,
};
const agent = { id: "agent-1", toolSetIds: ["mcp-1"] };

// Keys deliberately out of alphabetical order: `jsonb` would re-sort them.
const TOOLS = [
  {
    name: "search",
    description: "Search things",
    inputSchema: {
      type: "object",
      properties: { zeta: { type: "string" }, alpha: { type: "number" } },
      required: ["zeta"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write",
    description: "Write things",
    inputSchema: { type: "object", properties: { body: { type: "string" } } },
  },
];

const HOUR = 60 * 60 * 1000;

/** One MCP row, persisted the way `json` would: a text round trip. */
const store = () => {
  let row = {
    id: "mcp-1",
    organizationId: null,
    workspaceId: "ws-1",
    name: "Flaky MCP",
    slug: "flaky",
    url: "https://mcp.example.com",
    headers: null,
    authType: "None",
    bearerToken: null,
    lastKnownToolListing: null,
    lastKnownToolListingFetchedAt: null,
  } as unknown as McpRow;
  const queries = {
    getMcp: vi.fn(() => Promise.resolve(row)),
    saveMcpToolListing: vi.fn(
      (_id: string, listing: unknown, fetchedAt: Date) => {
        row = {
          ...row,
          lastKnownToolListing: JSON.parse(
            JSON.stringify(listing),
          ) as McpRow["lastKnownToolListing"],
          lastKnownToolListingFetchedAt: fetchedAt,
        };
        return Promise.resolve();
      },
    ),
  };
  return {
    queries,
    age: (ms: number) => {
      row = {
        ...row,
        lastKnownToolListingFetchedAt: new Date(Date.now() - ms),
      };
    },
  };
};

/** The `tools` block of the request Anthropic would be sent, as bytes. */
const wireTools = async (tools: Record<string, Tool>): Promise<string> => {
  let body = "";
  const anthropic = createAnthropic({
    apiKey: "test",
    fetch: (_input, init) => {
      body = init?.body as string;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "msg_01",
            type: "message",
            role: "assistant",
            model: "x",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    },
  });
  await generateText({ model: anthropic("claude-x"), prompt: "hi", tools });
  return JSON.stringify((JSON.parse(body) as { tools: unknown }).tools);
};

describe("openToolSession — Last-known tool listing (#635)", () => {
  beforeEach(() => {
    server.up = true;
    server.tools = structuredClone(TOOLS);
    server.opened = 0;
    server.closed = 0;
  });

  it("serves the stored listing when the fetch fails, byte-identical on the wire", async () => {
    const { queries } = store();
    const live = await openToolSession(scope, agent, queries);
    const liveWire = await wireTools(live.tools);
    await live.dispose();

    server.up = false;
    const stale = await openToolSession(scope, agent, queries);

    expect(Object.keys(stale.tools)).toEqual(["flaky__search", "flaky__write"]);
    expect(await wireTools(stale.tools)).toBe(liveWire);
    expect(stale.readOnlyToolNames).toEqual(live.readOnlyToolNames);
    expect([...stale.readOnlyToolNames]).toEqual(["flaky__search"]);
    await stale.dispose();
  });

  it("drops the MCP's tools when the stored listing is a day old", async () => {
    const { queries, age } = store();
    await (await openToolSession(scope, agent, queries)).dispose();
    age(LAST_KNOWN_LISTING_MAX_AGE_MS);

    server.up = false;
    const session = await openToolSession(scope, agent, queries);
    expect(session.tools).toEqual({});
  });

  it("serves a listing just inside the day", async () => {
    const { queries, age } = store();
    await (await openToolSession(scope, agent, queries)).dispose();
    age(LAST_KNOWN_LISTING_MAX_AGE_MS - 60_000);

    server.up = false;
    const session = await openToolSession(scope, agent, queries);
    expect(Object.keys(session.tools)).toHaveLength(2);
  });

  it("drops the MCP's tools when nothing was ever stored", async () => {
    const { queries } = store();
    server.up = false;
    const session = await openToolSession(scope, agent, queries);
    expect(session.tools).toEqual({});
    expect(queries.saveMcpToolListing).not.toHaveBeenCalled();
  });

  it("fails a stale tool's call as unreachable while down, runs it once back, and closes the lazy client on dispose", async () => {
    const { queries } = store();
    await (await openToolSession(scope, agent, queries)).dispose();

    server.up = false;
    const session = await openToolSession(scope, agent, queries);
    await expect(
      call(session.tools.flaky__write, { body: "x" }),
    ).rejects.toThrow("MCP server 'Flaky MCP' is unreachable");

    server.up = true;
    const closedBefore = server.closed;
    expect(await call(session.tools.flaky__write, { body: "x" })).toEqual(
      expect.objectContaining({
        content: [{ type: "text", text: "called write" }],
      }),
    );
    // A second call reuses the lazily opened client.
    await call(session.tools.flaky__search, { zeta: "q" });
    expect(server.closed).toBe(closedBefore);

    await session.dispose();
    expect(server.closed).toBe(closedBefore + 1);
  });

  it("writes the listing only when it changes", async () => {
    const { queries } = store();
    await (await openToolSession(scope, agent, queries)).dispose();
    expect(queries.saveMcpToolListing).toHaveBeenCalledTimes(1);

    await (await openToolSession(scope, agent, queries)).dispose();
    expect(queries.saveMcpToolListing).toHaveBeenCalledTimes(1);

    server.tools = [TOOLS[0]];
    await (await openToolSession(scope, agent, queries)).dispose();
    expect(queries.saveMcpToolListing).toHaveBeenCalledTimes(2);
    expect(queries.saveMcpToolListing).toHaveBeenLastCalledWith(
      "mcp-1",
      expect.objectContaining({
        tools: [expect.objectContaining({ name: "search" })],
      }),
      expect.any(Date),
    );
  });

  it("refreshes an unchanged listing's fetched-at once it is an hour old, so a stable server keeps its grace", async () => {
    const { queries, age } = store();
    await (await openToolSession(scope, agent, queries)).dispose();
    age(HOUR - 60_000);
    await (await openToolSession(scope, agent, queries)).dispose();
    expect(queries.saveMcpToolListing).toHaveBeenCalledTimes(1);

    age(23 * HOUR);
    await (await openToolSession(scope, agent, queries)).dispose();
    expect(queries.saveMcpToolListing).toHaveBeenCalledTimes(2);

    // A day after the first fetch, but minutes after the refresh.
    server.up = false;
    const session = await openToolSession(scope, agent, queries);
    expect(Object.keys(session.tools)).toHaveLength(2);
  });

  it("still serves live tools when saving the listing fails", async () => {
    const { queries } = store();
    queries.saveMcpToolListing.mockRejectedValueOnce(new Error("db down"));
    const session = await openToolSession(scope, agent, queries);
    expect(Object.keys(session.tools)).toHaveLength(2);
    await session.dispose();
  });
});
