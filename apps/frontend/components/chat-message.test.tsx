import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  WEB_TOOL_NORMALIZED_KEY,
  type Agent,
  type NormalizedWebToolResult,
} from "@platypus/schemas";
import type { PlatypusUIMessage } from "@platypus/backend/src/types";

// Streamdown pulls in shiki and a worker-ish runtime that jsdom can't host;
// the assertions here only care about the avatar rendered beside the message.
vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import {
  ChatMessage,
  CUT_SHORT_NOTICE,
  SEARCH_UNAVAILABLE_NOTICE,
  STEP_LIMIT_NOTICE,
  isGenericToolPart,
} from "./chat-message";

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

function renderMessage(
  message: PlatypusUIMessage,
  overrides: Partial<React.ComponentProps<typeof ChatMessage>> = {},
) {
  return render(
    <ChatMessage
      message={message}
      isLastMessage
      status="ready"
      canSendMessages
      agents={agents}
      onEditStart={vi.fn()}
      onMessageDelete={vi.fn()}
      onRegenerate={vi.fn()}
      onCopyMessage={vi.fn()}
      copiedMessageId={null}
      {...overrides}
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

type MessagePart = NonNullable<PlatypusUIMessage["parts"]>[number];

describe("ChatMessage image parts", () => {
  const userMessageWithFilePart = (part: MessagePart): PlatypusUIMessage => ({
    id: "m1",
    role: "user",
    parts: [part, { type: "text", text: "Check this out" }],
  });

  it("renders an image media type with a URL inline, not as a file attachment", () => {
    renderMessage(
      userMessageWithFilePart({
        type: "file",
        mediaType: "image/png",
        url: "https://example.com/a.png",
        filename: "a.png",
      }),
    );

    expect(screen.getByAltText("a.png")).toHaveAttribute(
      "src",
      "https://example.com/a.png",
    );
  });

  // issue #579: a part can carry an image media type with nothing a client
  // can fetch (e.g. Provider-reference-only). Rendering it as a broken <img>
  // would be worse than the plain file card every non-image attachment gets.
  it("falls back to a file attachment for an image media type with no URL", () => {
    const { container } = renderMessage(
      userMessageWithFilePart({
        type: "file",
        mediaType: "image/png",
        url: "",
        filename: "a.png",
      }),
    );

    expect(container.querySelector("img")).toBeNull();
  });
});

// A Web-search backend's `web_search` result is normalized server-side into
// `{ kind: "search", results, ... }` and stamped onto `toolMetadata` (issue
// #525, `apps/backend/src/runs/web-tool-normalize.ts`) before the frontend
// ever sees it — these tests build parts exactly as that normalizer leaves
// them. Its results are client-executed, so its citations arrive as a tool
// result rather than as `source-url` parts; without lifting them, the same
// Chat toggle gives pills on Anthropic and nothing on vLLM (ADR-0014).
describe("ChatMessage sources from a Web-search backend", () => {
  const normalizedMetadata = (result: NormalizedWebToolResult) => ({
    [WEB_TOOL_NORMALIZED_KEY]: result,
  });

  const searchMessage = (
    result: NormalizedWebToolResult,
    extraParts: unknown[] = [],
    partOverrides: Record<string, unknown> = {},
  ): PlatypusUIMessage =>
    ({
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-web_search",
          toolCallId: "c1",
          state: "output-available",
          input: { query: "platypus habitat" },
          output: {},
          toolMetadata: normalizedMetadata(result),
          ...partOverrides,
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
    renderMessage(
      searchMessage({ kind: "search", query: "platypus habitat", results }),
    );
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
        kind: "search",
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
        kind: "search",
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
        kind: "search",
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
        kind: "search",
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
        kind: "search",
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
      searchMessage({ kind: "search", query: "a", results }, [
        {
          type: "tool-web_search",
          toolCallId: "c2",
          state: "output-available",
          input: { query: "b" },
          output: {},
          toolMetadata: normalizedMetadata({
            kind: "search",
            query: "b",
            results: [results[0]],
          }),
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
      searchMessage({ kind: "search", query: "a", results: [results[0]] }, [
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
    renderMessage(
      searchMessage({
        kind: "search",
        query: "x",
        error: "Web search is unavailable.",
      }),
    );

    expect(screen.queryByText(/Used \d+ sources/)).toBeNull();
    openToolCard();
    expect(screen.getByText("Web search is unavailable.")).toBeInTheDocument();
  });

  // The generic tool renderer would repeat every result as a raw JSON body,
  // beneath pills that already list them — where native search shows pills alone.
  it("shows the query on a compact card instead of the raw result JSON", () => {
    renderMessage(
      searchMessage({ kind: "search", query: "platypus habitat", results }),
    );

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
      searchMessage({ kind: "search", query: "a", results: [results[0]] }, [
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
  // search that found nothing.
  it("says it is searching rather than reporting 0 results mid-call", () => {
    renderMessage(
      searchMessage({ kind: "search" }, [], { state: "input-available" }),
    );

    openToolCard();
    expect(screen.getByText("Searching…")).toBeInTheDocument();
    expect(screen.queryByText(/0 results/)).toBeNull();
  });

  // A denied call is not a running one. The header reports the state; the body
  // must not claim a search is in flight.
  it("claims no search in flight for a call that was denied", () => {
    renderMessage(
      searchMessage({ kind: "search" }, [], { state: "output-denied" }),
    );

    openToolCard();
    expect(screen.queryByText("Searching…")).toBeNull();
    expect(screen.queryByText(/0 results/)).toBeNull();
  });

  it("shows the card for a call still streaming its input", () => {
    renderMessage(
      searchMessage({ kind: "search" }, [], { state: "input-streaming" }),
    );

    openToolCard();
    expect(screen.getByText("Searching…")).toBeInTheDocument();
    expect(screen.queryByText("Parameters")).toBeNull();
  });

  // Restoring the pre-normalization back-compat guess is explicitly out of
  // scope (issue #525): a search stored before normalization existed carries
  // no normalized `toolMetadata` and falls to the generic renderer, losing its
  // card and its Sources pills. An accepted, narrow regression — nothing is
  // lost from the Transcript, and the alternative is the guess this issue
  // exists to delete.
  it("falls to the generic renderer for a stored result with no normalized metadata", () => {
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

    expect(screen.queryByText(/Used \d+ sources/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Web search/ }));
    expect(screen.getByText("Parameters")).toBeInTheDocument();
  });
});

// Native provider search is normalized server-side too (issue #525), reduced
// to a bare count rather than the raw vendor payload. A shape the backend
// cannot read (OpenRouter's unknown output, an MCP `web_search`) carries no
// normalized metadata at all and stays on the generic renderer, which is the
// only one that can show whatever it really is.
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
          // Vendor-shaped: not core's `{ query, results }` — the normalizer
          // already reduced this to `resultCount` before the frontend saw it.
          output: [
            { type: "web_search_result", url: "https://vendor.example/a" },
          ],
          toolMetadata: {
            [WEB_TOOL_NORMALIZED_KEY]: {
              kind: "search",
              query: "platypus habitat",
              resultCount: 1,
            },
          },
        },
        ...extraParts,
      ],
    }) as unknown as PlatypusUIMessage;

  it("shows a bare count on the compact card, not the raw vendor payload", () => {
    renderMessage(nativeSearchMessage());

    fireEvent.click(screen.getByRole("button", { name: /Web search/ }));
    expect(screen.getByText("1 result")).toBeInTheDocument();
    expect(screen.queryByText(/listed above as sources/)).toBeNull();
    expect(screen.queryByText("Parameters")).toBeNull();
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

  // A shape the backend cannot read at all (OpenRouter's unknown output, an
  // MCP `web_search`) carries no normalized metadata — the backend never
  // guesses a tool's identity from its payload, so this stays on the generic
  // renderer exactly as an unrecognised tool always has.
  it("leaves an unreadable native search on the generic renderer", () => {
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
});

// Issue #578: the dispatch used to be an if/else-if chain where a specialised
// tool part had to be checked before the generic catch-all or it would land
// there too, rendering its raw JSON body a second time alongside the
// specialised card (and, for search, the Sources row above the parts loop).
// `isGenericToolPart` now excludes every specialised tool part by
// construction, so this holds regardless of where a renderer sits in the
// dispatch list.
describe("ChatMessage generic tool renderer exclusion", () => {
  it("never matches a web tool part carrying a normalized result", () => {
    expect(
      isGenericToolPart({
        type: "tool-web_search",
        toolCallId: "c1",
        state: "output-available",
        input: { query: "x" },
        output: {},
        toolMetadata: {
          [WEB_TOOL_NORMALIZED_KEY]: { kind: "search", query: "x" },
        },
      } as unknown as Parameters<typeof isGenericToolPart>[0]),
    ).toBe(false);
  });

  it.each([
    ["a stored pre-dispatcher delegation part", "tool-delegateToResearchBot"],
    ["a single-tool delegation part", "tool-delegate"],
  ])("never matches %s", (_, type) => {
    expect(
      isGenericToolPart({
        type,
        toolCallId: "c1",
        state: "output-available",
        input: { subAgent: "Research Bot", task: "x" },
        output: { entries: [] },
      } as unknown as Parameters<typeof isGenericToolPart>[0]),
    ).toBe(false);
  });

  it("never matches a load-skill part", () => {
    expect(
      isGenericToolPart({
        type: "tool-loadSkill",
        toolCallId: "c1",
        state: "output-available",
        input: { name: "x" },
        output: {},
      } as unknown as Parameters<typeof isGenericToolPart>[0]),
    ).toBe(false);
  });

  it("matches an ordinary tool part with no specialised renderer", () => {
    expect(
      isGenericToolPart({
        type: "tool-getCard",
        toolCallId: "c1",
        state: "output-available",
        input: {},
        output: {},
      } as unknown as Parameters<typeof isGenericToolPart>[0]),
    ).toBe(true);
  });

  // Native provider search is `tool-web_search` shaped but carries no
  // normalized metadata here — it must stay on the generic renderer, which is
  // the only one that can show its vendor-shaped payload.
  it("matches a web_search part with no normalized metadata", () => {
    expect(
      isGenericToolPart({
        type: "tool-web_search",
        toolCallId: "c1",
        state: "output-available",
        providerExecuted: true,
        input: { query: "x" },
        output: [
          { type: "web_search_result", url: "https://vendor.example/a" },
        ],
      } as unknown as Parameters<typeof isGenericToolPart>[0]),
    ).toBe(true);
  });
});

// Sub-agent delegations get a custom card the same way plugin web-search
// does; the same double-render risk applies if the generic branch ever
// caught one too.
describe("ChatMessage sub-agent tool dispatch", () => {
  const delegateMessage = (): PlatypusUIMessage =>
    ({
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-delegateToResearchBot",
          toolCallId: "c1",
          state: "output-available",
          input: { task: "Find the release date" },
          output: { entries: [], text: "It shipped in March." },
        },
      ],
    }) as unknown as PlatypusUIMessage;

  it("renders the sub-agent card instead of the generic tool renderer", () => {
    renderMessage(delegateMessage());

    expect(screen.getByText("Research Bot")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Research Bot"));

    // Only the sub-agent card's own labels appear — the generic renderer's
    // "Parameters"/raw "Result" JSON would mean the call rendered twice.
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.queryByText("Parameters")).toBeNull();
    expect(screen.queryByText("Result")).toBeNull();
  });

  // The new shape: one `delegate` tool for every sub-agent, so the target is
  // named in the input rather than in the tool name.
  it("routes a single-tool delegation to the same card", () => {
    renderMessage({
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-delegate",
          toolCallId: "c1",
          state: "output-available",
          input: { subAgent: "Research Bot", task: "Find the release date" },
          output: { entries: [], text: "It shipped in March." },
        },
      ],
    } as unknown as PlatypusUIMessage);

    expect(screen.getByText("Research Bot")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Research Bot"));
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.queryByText("Parameters")).toBeNull();
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

// Issue #540: a turn whose loop ran out of steps ended with no answer — often a
// tool card and nothing after it — and nothing anywhere said a step limit was
// what happened.
describe("ChatMessage step-limit marker", () => {
  it("marks a message the run flagged as stopped at the step limit", () => {
    renderMessage(assistantMessage({ stoppedAtStepLimit: true }));

    expect(screen.getByText(STEP_LIMIT_NOTICE)).toBeInTheDocument();
  });

  it.each([
    ["a message that finished cleanly", { agentId: "agent-1" }],
    ["a message with no metadata at all", undefined],
  ] as const)("renders no marker for %s", (_, metadata) => {
    renderMessage(assistantMessage(metadata));

    expect(screen.queryByText(STEP_LIMIT_NOTICE)).toBeNull();
  });

  // The two cut-short notices name different limits — one bounds the loop, the
  // other bounds a single reply — and a turn only ever hits one of them.
  it("renders the output-limit marker without the step-limit one", () => {
    renderMessage(assistantMessage({ truncatedByTokenLimit: true }));

    expect(screen.getByText(CUT_SHORT_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(STEP_LIMIT_NOTICE)).toBeNull();
  });

  it("keeps the agent avatar on a step-limited agent turn", () => {
    renderMessage(
      assistantMessage({ agentId: "agent-1", stoppedAtStepLimit: true }),
    );

    expect(screen.getByAltText("Research Agent")).toBeInTheDocument();
    expect(screen.getByText(STEP_LIMIT_NOTICE)).toBeInTheDocument();
  });
});

// Issue #522: a user turns search on, the backend the Provider names is gone or
// failed to start, and the reply is written without it. The model is never told
// — this row is the only place the difference is visible.
describe("ChatMessage search-unavailable notice", () => {
  it("marks a reply the run flagged as written without search", () => {
    renderMessage(assistantMessage({ searchUnavailable: true }));

    expect(screen.getByText(SEARCH_UNAVAILABLE_NOTICE)).toBeInTheDocument();
  });

  it.each([
    [
      "a message whose turn had the search it asked for",
      { agentId: "agent-1" },
    ],
    ["a message with no metadata at all", undefined],
  ] as const)("renders no notice for %s", (_, metadata) => {
    renderMessage(assistantMessage(metadata));

    expect(screen.queryByText(SEARCH_UNAVAILABLE_NOTICE)).toBeNull();
  });

  // The two notices answer different questions — how the reply was produced,
  // and how it ended — so a turn that lost its search and then ran out of
  // output budget shows both, in that order.
  it("renders both notices when the turn also stopped at the output limit", () => {
    renderMessage(
      assistantMessage({
        searchUnavailable: true,
        truncatedByTokenLimit: true,
      }),
    );

    const search = screen.getByText(SEARCH_UNAVAILABLE_NOTICE);
    const cutShort = screen.getByText(CUT_SHORT_NOTICE);
    expect(search).toBeInTheDocument();
    expect(cutShort).toBeInTheDocument();
    expect(
      search.compareDocumentPosition(cutShort) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the agent avatar on a search-less agent turn", () => {
    renderMessage(
      assistantMessage({ agentId: "agent-1", searchUnavailable: true }),
    );

    expect(screen.getByAltText("Research Agent")).toBeInTheDocument();
    expect(screen.getByText(SEARCH_UNAVAILABLE_NOTICE)).toBeInTheDocument();
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

const userMessage = (): PlatypusUIMessage => ({
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "Ask" }],
});

/**
 * Sending is workspace ownership, and until issue #710 the client gated only
 * the composer on it. The action bar was ungated, so an Org Admin or Operator
 * reading someone else's Chat got Edit, Delete and Regenerate — and Delete
 * mutated their transcript with no server call to refuse it.
 */
describe("ChatMessage action bar permissions", () => {
  it("offers Edit, Delete and Copy on a user message to someone who can send", () => {
    renderMessage(userMessage());

    for (const action of ["Edit", "Delete", "Copy"]) {
      expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
    }
  });

  it("offers Regenerate on the last reply to someone who can send", () => {
    renderMessage(assistantMessage());

    expect(
      screen.getByRole("button", { name: "Regenerate" }),
    ).toBeInTheDocument();
  });

  it.each([
    ["a user message", userMessage()],
    ["an assistant reply", assistantMessage()],
  ])("withholds every write action on %s from a reader", (_, message) => {
    renderMessage(message, { canSendMessages: false });

    for (const action of ["Edit", "Delete", "Regenerate"]) {
      expect(screen.queryByRole("button", { name: action })).toBeNull();
    }
  });

  // Reading is not writing: Copy takes nothing away from the Chat.
  it("still offers Copy to a reader", () => {
    renderMessage(userMessage(), { canSendMessages: false });

    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });
});

describe("ChatMessage while editing", () => {
  const editing = { editor: <div data-testid="editor">editing</div> };

  it("renders the edit surface in the message's place", () => {
    renderMessage(userMessage(), editing);

    expect(screen.getByTestId("editor")).toBeInTheDocument();
    expect(screen.queryByText("Ask")).toBeNull();
  });

  // The edit surface carries its own Save and Cancel; the message's own
  // actions would act on a message that is no longer on screen.
  it("withholds the message's own actions", () => {
    renderMessage(userMessage(), editing);

    for (const action of ["Edit", "Copy", "Delete"]) {
      expect(screen.queryByRole("button", { name: action })).toBeNull();
    }
  });

  // A message being edited shows its attachments inside the edit surface, not
  // above it — the transcript's copy would be a second, unremovable list.
  it("withholds the attachments the transcript would show", () => {
    const withImage: PlatypusUIMessage = {
      id: "u1",
      role: "user",
      parts: [
        {
          type: "file",
          url: "https://example.com/shot.png",
          mediaType: "image/png",
          filename: "shot.png",
        },
        { type: "text", text: "Ask" },
      ],
    };

    const { unmount } = renderMessage(withImage);
    expect(screen.getByAltText("shot.png")).toBeInTheDocument();
    unmount();

    renderMessage(withImage, editing);

    expect(screen.queryByAltText("shot.png")).toBeNull();
  });
});
