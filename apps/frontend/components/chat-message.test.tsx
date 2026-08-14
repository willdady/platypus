import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WEB_BACKEND_TOOL_MARKER, type Agent } from "@platypus/schemas";
import type { PlatypusUIMessage } from "@platypus/backend/src/types";

// Streamdown pulls in shiki and a worker-ish runtime that jsdom can't host;
// the assertions here only care about the avatar rendered beside the message.
vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { ChatMessage, CUT_SHORT_NOTICE } from "./chat-message";

const makeAgent = (overrides: Partial<Agent>): Agent =>
  ({
    id: "agent-1",
    name: "Research Agent",
    avatarUrl: "https://example.com/agent-1.png",
    ...overrides,
  }) as Agent;

const agents = [makeAgent({})];

const assistantMessage = (
  metadata?: PlatypusUIMessage["metadata"],
): PlatypusUIMessage => ({
  id: "m1",
  role: "assistant",
  metadata,
  parts: [{ type: "text", text: "Hello" }],
});

function renderMessage(message: PlatypusUIMessage) {
  return render(
    <ChatMessage
      message={message}
      isLastMessage
      status="ready"
      isEditing={false}
      editContent=""
      editTextareaRef={{ current: null }}
      agents={agents}
      setEditContent={vi.fn()}
      onEditStart={vi.fn()}
      onEditCancel={vi.fn()}
      onEditSubmit={vi.fn()}
      onMessageDelete={vi.fn()}
      onRegenerate={vi.fn()}
      onCopyMessage={vi.fn()}
      copiedMessageId={null}
    />,
  );
}

describe("ChatMessage agent attribution", () => {
  it("renders the agent avatar when the message is attributed to an agent", () => {
    renderMessage(assistantMessage({ agentId: "agent-1" }));

    const avatar = screen.getByAltText("Research Agent");
    expect(avatar).toHaveAttribute("src", "https://example.com/agent-1.png");
  });

  // A direct provider/model run carries no attribution; an agentId that no
  // longer resolves (deleted agent) has to degrade the same way.
  it.each([
    ["a run with no attribution", undefined],
    ["an agentId that resolves to no agent", { agentId: "gone" }],
  ] as const)("falls back to the generic bot avatar for %s", (_, metadata) => {
    const { container } = renderMessage(assistantMessage(metadata));

    expect(screen.queryByAltText("Research Agent")).toBeNull();
    // The fallback is our own `bg-muted` circle wrapping an icon — asserted
    // via markup we own rather than a lucide-generated class name.
    expect(container.querySelector("div.bg-muted > svg")).not.toBeNull();
  });
});

// A Web-search backend's `web_search` is client-executed, so its citations arrive
// as a tool result rather than as `source-url` parts. Without lifting them, the
// same Chat toggle gives pills on Anthropic and nothing on vLLM (ADR-0014).
describe("ChatMessage sources from a Web-search backend", () => {
  // Core stamps this on the Tool it builds; the AI SDK carries it onto the part and
  // into the stored message. It is what identifies a plugin call on a provider that
  // does not report its own executions.
  const marker = { [WEB_BACKEND_TOOL_MARKER]: true };

  const searchMessage = (
    output: unknown,
    extraParts: unknown[] = [],
  ): PlatypusUIMessage =>
    ({
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-web_search",
          toolCallId: "c1",
          state: "output-available",
          toolMetadata: marker,
          input: { query: "platypus habitat" },
          output,
        },
        ...extraParts,
      ],
    }) as unknown as PlatypusUIMessage;

  const results = [
    { title: "Platypus", url: "https://example.com/platypus" },
    { title: "Habitat", url: "https://example.com/habitat" },
  ];

  /** The Sources row is a collapsed disclosure; the pills mount when it opens. */
  const openSources = () =>
    fireEvent.click(screen.getByRole("button", { name: /Used \d+ sources/ }));

  /** Same for the tool card, whose body holds the answer and any error. */
  const openToolCard = () =>
    fireEvent.click(screen.getByRole("button", { name: /Web search/ }));

  it("renders a Sources pill per result, titled by the backend's title", () => {
    renderMessage(searchMessage({ query: "platypus habitat", results }));
    openSources();

    expect(screen.getByRole("link", { name: "Platypus" })).toHaveAttribute(
      "href",
      "https://example.com/platypus",
    );
    expect(screen.getByRole("link", { name: "Habitat" })).toBeInTheDocument();
  });

  // The backend drops these before the model sees them; this is the copy that
  // decides what becomes an `href`, and a backend is third-party code.
  it("renders no pill for a result whose URL is not http(s)", () => {
    renderMessage(
      searchMessage({
        query: "x",
        results: [
          { title: "Evil", url: "javascript:alert(1)" },
          { title: "Data", url: "data:text/html,<script>alert(1)</script>" },
          { title: "Fine", url: "https://example.com/fine" },
        ],
      }),
    );
    openSources();

    expect(screen.queryByText("Evil")).toBeNull();
    expect(screen.queryByText("Data")).toBeNull();
    expect(screen.getByText("Fine")).toBeInTheDocument();
    // Nothing anywhere carries a rejected URL as a link target.
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(document.querySelector('a[href^="data:"]')).toBeNull();
  });

  // Unpresentable results are not counted either — a "Used 3 sources" row that
  // opens onto one pill is its own bug.
  it("counts only the results it will render", () => {
    renderMessage(
      searchMessage({
        query: "x",
        results: [
          { title: "Evil", url: "javascript:alert(1)" },
          { title: "Fine", url: "https://example.com/fine" },
        ],
      }),
    );

    expect(screen.getByText("Used 1 sources")).toBeInTheDocument();
  });

  // The card's count and the Sources row are one list: "2 results — listed above
  // as sources" over a single pill is the same bug the row itself avoids.
  it("counts only the presentable results on the card", () => {
    renderMessage(
      searchMessage({
        query: "x",
        results: [
          { title: "Evil", url: "javascript:alert(1)" },
          { title: "Fine", url: "https://example.com/fine" },
        ],
      }),
    );
    openToolCard();

    expect(screen.getByText(/1 result —/)).toBeInTheDocument();
    expect(screen.queryByText(/2 results/)).toBeNull();
  });

  // Nothing renders above, so nothing is claimed to: the alternative is a count
  // pointing at a Sources row that is not there.
  it("reports 0 results when no result was presentable", () => {
    renderMessage(
      searchMessage({
        query: "x",
        results: [{ title: "Evil", url: "javascript:alert(1)" }],
      }),
    );
    openToolCard();

    expect(screen.getByText("0 results")).toBeInTheDocument();
    expect(screen.queryByText(/Used \d+ sources/)).toBeNull();
  });

  it("falls back to the URL when a result carries no usable title", () => {
    renderMessage(
      searchMessage({
        query: "x",
        results: [{ title: "", url: "https://example.com/untitled" }],
      }),
    );
    openSources();

    expect(
      screen.getByRole("link", { name: "https://example.com/untitled" }),
    ).toBeInTheDocument();
  });

  it("cites a page once when two searches in a turn both return it", () => {
    renderMessage(
      searchMessage({ query: "a", results }, [
        {
          type: "tool-web_search",
          toolCallId: "c2",
          state: "output-available",
          input: { query: "b" },
          output: { query: "b", results: [results[0]] },
        },
      ]),
    );
    openSources();

    expect(screen.getAllByRole("link", { name: "Platypus" })).toHaveLength(1);
  });

  // Native `source-url` parts and a plugin backend's results share one row, so
  // a history that mixes both reads as one list with one count.
  it("merges plugin results with native source-url parts", () => {
    renderMessage(
      searchMessage({ query: "a", results: [results[0]] }, [
        {
          type: "source-url",
          sourceId: "s1",
          url: "https://vendor.example/cited",
        },
      ]),
    );

    expect(screen.getByText("Used 2 sources")).toBeInTheDocument();
    openSources();

    expect(screen.getByRole("link", { name: "Platypus" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "https://vendor.example/cited" }),
    ).toBeInTheDocument();
  });

  // The tool returns `{ error }` rather than rejecting, so a failed search
  // arrives as a successful part with nothing to cite.
  it("renders no Sources row when the search returned an error", () => {
    renderMessage(searchMessage({ error: "Web search is unavailable." }));

    expect(screen.queryByText(/Used \d+ sources/)).toBeNull();
    openToolCard();
    expect(screen.getByText("Web search is unavailable.")).toBeInTheDocument();
  });

  // The generic tool renderer would repeat every result as a raw JSON body,
  // beneath pills that already list them — where native search shows pills alone.
  it("shows the query on a compact card instead of the raw result JSON", () => {
    renderMessage(searchMessage({ query: "platypus habitat", results }));

    expect(
      screen.getByRole("button", { name: /Web search.*platypus habitat/ }),
    ).toBeInTheDocument();
    openToolCard();

    expect(screen.getByText(/2 results/)).toBeInTheDocument();
    expect(screen.queryByText("Parameters")).toBeNull();
  });

  // One message can carry both rows: a vendor emits `source-url` parts for
  // citations that are not search results, and a backend search can name the same
  // page. The plugin entry wins the collision — it has the backend's title, where a
  // `source-url` part has only the URL.
  it("cites a page once, by its title, when both rows name it", () => {
    renderMessage(
      searchMessage({ query: "a", results: [results[0]] }, [
        {
          type: "source-url",
          sourceId: "s1",
          url: "https://example.com/platypus",
        },
      ]),
    );

    expect(screen.getByText("Used 1 sources")).toBeInTheDocument();
    openSources();

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName("Platypus");
    expect(links[0]).toHaveAttribute("href", "https://example.com/platypus");
  });

  // "0 results" is true of a search that has not answered yet, and reads as a
  // search that found nothing. The marker is what identifies the call this early:
  // there is no output to recognise yet.
  it("says it is searching rather than reporting 0 results mid-call", () => {
    renderMessage({
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-web_search",
          toolCallId: "c1",
          state: "input-available",
          toolMetadata: marker,
          input: { query: "platypus habitat" },
        },
      ],
    } as unknown as PlatypusUIMessage);

    openToolCard();
    expect(screen.getByText("Searching…")).toBeInTheDocument();
    expect(screen.queryByText(/0 results/)).toBeNull();
  });

  // A denied call is not a running one. The header reports the state; the body must
  // not claim a search is in flight.
  it("claims no search in flight for a call that was denied", () => {
    renderMessage({
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-web_search",
          toolCallId: "c1",
          state: "output-denied",
          toolMetadata: marker,
          input: { query: "platypus habitat" },
        },
      ],
    } as unknown as PlatypusUIMessage);

    openToolCard();
    expect(screen.queryByText("Searching…")).toBeNull();
    expect(screen.queryByText(/0 results/)).toBeNull();
  });

  // The marker rides the first streaming chunk (`ai@7`, `tool-input-start`), so one
  // of our own calls is identifiable before its input finishes arriving.
  it("shows the card for a marked call still streaming its input", () => {
    renderMessage({
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-web_search",
          toolCallId: "c1",
          state: "input-streaming",
          toolMetadata: marker,
          input: { query: "platypus habitat" },
        },
      ],
    } as unknown as PlatypusUIMessage);

    openToolCard();
    expect(screen.getByText("Searching…")).toBeInTheDocument();
    expect(screen.queryByText("Parameters")).toBeNull();
  });

  // Messages stored before the marker shipped carry none. A finished call is still
  // recognisable by the result shape core owns, so their pills do not vanish.
  it("still lifts sources from a stored result that carries no marker", () => {
    renderMessage({
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-web_search",
          toolCallId: "c1",
          state: "output-available",
          input: { query: "platypus habitat" },
          output: { query: "platypus habitat", results: [results[0]] },
        },
      ],
    } as unknown as PlatypusUIMessage);

    expect(screen.getByText("Used 1 sources")).toBeInTheDocument();
  });
});

// Native provider search registers under the same `web_search` name as a plugin
// backend's (`services/provider.ts` — OpenAI, OpenRouter, Anthropic), so the tool
// name alone cannot tell them apart. `providerExecuted` can: a native part belongs
// on the generic renderer, which shows the vendor payload the compact card cannot
// read, and its citations come from `source-url` parts.
describe("ChatMessage and provider-executed web_search", () => {
  const nativeSearchMessage = (extraParts: unknown[] = []): PlatypusUIMessage =>
    ({
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-web_search",
          toolCallId: "c1",
          state: "output-available",
          providerExecuted: true,
          input: { query: "platypus habitat" },
          // Vendor-shaped: not core's `{ query, results }`.
          output: [
            { type: "web_search_result", url: "https://vendor.example/a" },
          ],
        },
        ...extraParts,
      ],
    }) as unknown as PlatypusUIMessage;

  it("leaves a native search on the generic tool renderer", () => {
    renderMessage(nativeSearchMessage());

    // Only the generic renderer shows the input/output blocks; the compact card
    // has neither, and would claim "0 results" on this vendor-shaped output.
    fireEvent.click(screen.getByRole("button", { name: /Web search/ }));
    expect(screen.getByText("Parameters")).toBeInTheDocument();
    expect(screen.queryByText(/\d+ results?/)).toBeNull();
    expect(screen.queryByText("Searching…")).toBeNull();
  });

  it("lifts no sources out of a native search result", () => {
    renderMessage(nativeSearchMessage());

    expect(screen.queryByText(/Used \d+ sources/)).toBeNull();
  });

  // A `source-url` part carries an optional title and Anthropic sends one. Rendering
  // the URL as the label regardless left native Providers showing raw URLs in the
  // row where a backend Provider shows real titles.
  it("titles a native source pill by the title the vendor sent", () => {
    renderMessage(
      nativeSearchMessage([
        {
          type: "source-url",
          sourceId: "s1",
          url: "https://vendor.example/cited",
          title: "Vendor page",
        },
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: /Used 1 sources/ }));
    expect(screen.getByRole("link", { name: "Vendor page" })).toHaveAttribute(
      "href",
      "https://vendor.example/cited",
    );
  });

  // `??` would have kept an empty string and rendered a pill with no label at all.
  it("falls back to the URL when the vendor sends an empty title", () => {
    renderMessage(
      nativeSearchMessage([
        {
          type: "source-url",
          sourceId: "s1",
          url: "https://vendor.example/cited",
          title: "",
        },
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: /Used 1 sources/ }));
    expect(
      screen.getByRole("link", { name: "https://vendor.example/cited" }),
    ).toBeInTheDocument();
  });

  // Titling the pill by the vendor's title takes the URL off the screen, so a
  // `javascript:` citation would read as an ordinary link. Same scheme check a
  // plugin result's URL goes through.
  it("drops a native source pill whose URL is not presentable", () => {
    renderMessage(
      nativeSearchMessage([
        {
          type: "source-url",
          sourceId: "s1",
          url: "javascript:alert(1)",
          title: "Vendor page",
        },
      ]),
    );

    expect(screen.queryByText(/Used \d+ sources/)).toBeNull();
  });

  it("still renders the native citations from source-url parts", () => {
    renderMessage(
      nativeSearchMessage([
        {
          type: "source-url",
          sourceId: "s1",
          url: "https://vendor.example/cited",
        },
      ]),
    );

    expect(screen.getByText("Used 1 sources")).toBeInTheDocument();
  });

  // `providerExecuted` is the provider package's to set, and
  // `@openrouter/ai-sdk-provider` never sets it — so a native search there is a
  // `tool-web_search` part with no flag, no marker, and no core-shaped output. It
  // must not read as a plugin call: on the card it would sit at "Searching…" for a
  // search that already ran.
  it("leaves an unflagged, unmarked native search on the generic renderer", () => {
    renderMessage({
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-web_search",
          toolCallId: "c1",
          state: "input-available",
          // Vendor-shaped: OpenRouter carries its results in the call's input.
          input: { results: [{ url: "https://vendor.example/a" }] },
        },
      ],
    } as unknown as PlatypusUIMessage);

    fireEvent.click(screen.getByRole("button", { name: /Web search/ }));
    expect(screen.getByText("Parameters")).toBeInTheDocument();
    expect(screen.queryByText("Searching…")).toBeNull();
    expect(screen.queryByText(/Used \d+ sources/)).toBeNull();
  });

  // The same part one chunk earlier. Core's marker is attached from the first
  // streaming chunk, so an unmarked `input-streaming` part is native by
  // elimination — treating the state itself as ours put a native OpenRouter search
  // on the compact card mid-stream, which then swapped renderer at
  // `input-available`.
  it("leaves an unmarked, streaming native search on the generic renderer", () => {
    renderMessage({
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-web_search",
          toolCallId: "c1",
          state: "input-streaming",
          input: { query: "platypus habitat" },
        },
      ],
    } as unknown as PlatypusUIMessage);

    fireEvent.click(screen.getByRole("button", { name: /Web search/ }));
    expect(screen.getByText("Parameters")).toBeInTheDocument();
    expect(screen.queryByText("Searching…")).toBeNull();
  });
});

// Issue #420: a reply that stopped at the model's output ceiling used to just
// stop mid-sentence, with the only record of it in the operator's log.
describe("ChatMessage truncation marker", () => {
  it("marks a message the run flagged as cut short at the output limit", () => {
    renderMessage(assistantMessage({ truncatedByTokenLimit: true }));

    expect(screen.getByText(CUT_SHORT_NOTICE)).toBeInTheDocument();
  });

  it.each([
    ["a message that finished cleanly", { agentId: "agent-1" }],
    ["a message with no metadata at all", undefined],
  ] as const)("renders no marker for %s", (_, metadata) => {
    renderMessage(assistantMessage(metadata));

    expect(screen.queryByText(CUT_SHORT_NOTICE)).toBeNull();
  });

  // The two keys arrive on separate metadata chunks that merge into one
  // message, so a truncated agent turn is the one case where both are set.
  it("keeps the agent avatar on a truncated agent turn", () => {
    renderMessage(
      assistantMessage({ agentId: "agent-1", truncatedByTokenLimit: true }),
    );

    expect(screen.getByAltText("Research Agent")).toBeInTheDocument();
    expect(screen.getByText(CUT_SHORT_NOTICE)).toBeInTheDocument();
  });
});

// Issue #353: the header carries the tool's execution time so a slow reply can
// be pinned on a specific tool rather than the model.
describe("ChatMessage tool duration", () => {
  const withToolPart = (part: unknown): PlatypusUIMessage =>
    ({
      id: "m1",
      role: "assistant",
      parts: [part],
    }) as PlatypusUIMessage;

  const staticToolPart = (toolMetadata?: Record<string, unknown>) => ({
    type: "tool-getCard",
    toolCallId: "call-1",
    state: "output-available",
    input: {},
    output: {},
    toolMetadata,
  });

  const dynamicToolPart = (toolMetadata?: Record<string, unknown>) => ({
    type: "dynamic-tool",
    toolName: "search",
    toolCallId: "call-1",
    state: "output-available",
    input: {},
    output: {},
    toolMetadata,
  });

  it.each([
    ["a static tool", staticToolPart({ durationMs: 1234 })],
    ["a dynamic tool", dynamicToolPart({ durationMs: 1234 })],
  ])("renders the persisted duration for %s", (_, part) => {
    renderMessage(withToolPart(part));

    expect(screen.getByText(/1\.2s/)).toBeInTheDocument();
  });

  // Tool calls recorded before this shipped carry no timing; they render the
  // header exactly as before rather than a placeholder.
  it.each([
    ["a static tool", staticToolPart()],
    ["a dynamic tool", dynamicToolPart()],
  ])("renders no duration for %s recorded before timing existed", (_, part) => {
    renderMessage(withToolPart(part));

    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByText(/\d+ms|\d+\.\d+s/)).toBeNull();
  });

  // The live case, and the one that was broken: mid-turn the SDK hands back a
  // tool part stripped of its metadata, so the figure has to come off the
  // message. Without this the duration was blank until the chat was re-fetched
  // — and the next turn then overwrote it out of the database.
  it.each([
    ["a static tool", staticToolPart()],
    ["a dynamic tool", dynamicToolPart()],
  ])("renders the duration delivered on the message for %s", (_, part) => {
    const message = withToolPart(part);
    message.metadata = { toolDurations: { "call-1": 1234 } };

    renderMessage(message);

    expect(screen.getByText(/1\.2s/)).toBeInTheDocument();
  });

  it("shows the same figure whichever carrier holds it", () => {
    const fromMessage = withToolPart(staticToolPart());
    fromMessage.metadata = { toolDurations: { "call-1": 1234 } };
    const { unmount } = renderMessage(fromMessage);
    const live = screen.getByText(/1\.2s/).textContent;
    unmount();

    renderMessage(withToolPart(staticToolPart({ durationMs: 1234 })));

    expect(screen.getByText(/1\.2s/).textContent).toBe(live);
  });
});
