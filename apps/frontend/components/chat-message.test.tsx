import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Agent } from "@platypus/schemas";
import type { PlatypusUIMessage } from "@platypus/backend/src/types";

// Streamdown pulls in shiki and a worker-ish runtime that jsdom can't host;
// the assertions here only care about the avatar rendered beside the message.
vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { ChatMessage } from "./chat-message";

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
});
