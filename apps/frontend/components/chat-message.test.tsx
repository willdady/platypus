import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import {
  WEB_TOOL_NORMALIZED_KEY,
  type Agent,
  type NormalizedWebToolResult,
  type PlatypusUIMessage,
} from "@platypus/schemas";
import { setErrorReporter } from "@/lib/error-reporting";
import { authMock } from "@/test/test-utils";

const { artifactReads } = vi.hoisted(() => ({
  artifactReads: new Map<string, { data?: unknown; deleted?: boolean }>(),
}));

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1", workspaceId: "ws1" }),
}));
vi.mock("@/hooks/use-artifact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-artifact")>();
  return {
    ...actual,
    useStoredArtifact: (stored?: { id: string; version: number }) =>
      artifactReads.get(`${stored?.id}:${stored?.version}`) ?? {},
  };
});

import { ARTIFACT_DELETED_DETAIL } from "./artifact-tool-card";
import {
  ChatMessage,
  CUT_SHORT_NOTICE,
  SEARCH_UNAVAILABLE_NOTICE,
  STEP_LIMIT_NOTICE,
  isGenericToolPart,
} from "./chat-message";
import type { Serialized } from "@/lib/api-write";

function makeAgent(overrides: Partial<Serialized<Agent>>): Serialized<Agent> {
  return {
    id: "agent-1",
    name: "Research Agent",
    avatarUrl: "https://example.com/agent-1.png",
    ...overrides,
  } as Serialized<Agent>;
}

const agents = [makeAgent({})];

function assistantMessage(
  metadata?: PlatypusUIMessage["metadata"],
): PlatypusUIMessage {
  return {
    id: "m1",
    role: "assistant",
    metadata,
    parts: [{ type: "text", text: "Hello" }],
  };
}

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
      onSwitchAlternative={vi.fn()}
      onCopyMessage={vi.fn()}
      copied={false}
      {...overrides}
    />,
  );
}

class TestImage extends EventTarget {
  src = "";
  complete = true;

  get naturalWidth() {
    return this.src.endsWith("/broken.png") ? 0 : 32;
  }
}

beforeEach(() => {
  vi.stubGlobal("Image", TestImage);
  artifactReads.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("ChatMessage agent attribution", () => {
  it("renders the agent avatar when the message is attributed to an agent", () => {
    renderMessage(assistantMessage({ agentId: "agent-1" }));

    const avatar = screen.getByAltText("Research Agent");
    expect(avatar).toHaveAttribute("src", "https://example.com/agent-1.png");
  });

  it("names the agent once per message, not on every part's avatar", () => {
    const { container } = renderMessage({
      ...assistantMessage({ agentId: "agent-1" }),
      parts: [
        { type: "text", text: "First" },
        { type: "text", text: "Second" },
      ],
    });

    expect(screen.getAllByAltText("Research Agent")).toHaveLength(1);
    expect(
      container.querySelectorAll('img[src="https://example.com/agent-1.png"]'),
    ).toHaveLength(2);
  });

  it("shows the fallback when the agent image fails to load", async () => {
    const { container } = renderMessage(
      assistantMessage({ agentId: "agent-1" }),
      { agents: [makeAgent({ avatarUrl: "https://example.com/broken.png" })] },
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-slot="avatar-fallback"]'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByAltText("Research Agent")).not.toBeInTheDocument();
  });

  it("shows the fallback for a resolved agent with no avatar URL", () => {
    const { container } = renderMessage(
      assistantMessage({ agentId: "agent-1" }),
      { agents: [makeAgent({ avatarUrl: undefined })] },
    );

    expect(
      container.querySelector('[data-slot="avatar-fallback"] svg'),
    ).not.toBeNull();
    expect(screen.queryByAltText("Research Agent")).not.toBeInTheDocument();
  });

  it.each([
    ["a run with no attribution", undefined],
    ["an agentId that resolves to no agent", { agentId: "gone" }],
  ] as const)("falls back to the generic bot avatar for %s", (_, metadata) => {
    const { container } = renderMessage(assistantMessage(metadata));

    expect(screen.queryByAltText("Research Agent")).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="avatar-fallback"] svg'),
    ).not.toBeNull();
  });
});

type MessagePart = NonNullable<PlatypusUIMessage["parts"]>[number];

function openToolCallGroups() {
  for (const header of screen.queryAllByRole("button", {
    name: /^\d+ tool calls?:/,
  })) {
    fireEvent.click(header);
  }
}

describe("ChatMessage part that fails to render", () => {
  const brokenToolPart = {
    type: "dynamic-tool",
    toolName: "broken",
    toolCallId: "call-1",
    state: "output-available",
    input: { count: BigInt(1) },
    output: "done",
  } as unknown as MessagePart;

  const messageWithBrokenPart: PlatypusUIMessage = {
    id: "m1",
    role: "assistant",
    parts: [
      { type: "text", text: "Before" },
      brokenToolPart,
      { type: "text", text: "After" },
    ],
  };

  const openBrokenTool = () => {
    openToolCallGroups();
    fireEvent.click(screen.getByRole("button", { name: /^broken/ }));
  };

  it("replaces only that part with a compact notice", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderMessage(messageWithBrokenPart);
    openBrokenTool();

    expect(screen.getByText("Couldn't render this part")).toBeInTheDocument();
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
  });

  it("keeps the message's own actions", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderMessage(messageWithBrokenPart);
    openBrokenTool();

    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("hands the failure to the error reporter", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reporter = vi.fn();
    setErrorReporter(reporter);
    try {
      renderMessage(messageWithBrokenPart);
      openBrokenTool();
    } finally {
      setErrorReporter(null);
    }

    expect(reporter).toHaveBeenCalledWith(expect.any(TypeError), {
      source: "message-part",
    });
  });
});

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

describe("ChatMessage Sandbox upload parts", () => {
  it("shows the upload's path and size, with no download link", () => {
    const { container } = renderMessage({
      id: "m1",
      role: "user",
      parts: [
        {
          type: "data-sandbox-upload",
          data: { path: "data.csv", size: 1_200_000 },
        },
        { type: "text", text: "Summarise it" },
      ],
    });

    const chip = screen.getByText("Sandbox").parentElement!;
    expect(chip).toHaveTextContent("data.csv");
    expect(chip).toHaveTextContent("1.2 MB");
    expect(container.querySelector("a")).toBeNull();
  });
});

// why: backend search citations arrive as a tool result, not as source-url parts
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

  const openSources = () =>
    fireEvent.click(screen.getByRole("button", { name: /Used \d+ sources/ }));

  const openToolCard = () => {
    openToolCallGroups();
    fireEvent.click(screen.getByRole("button", { name: /^Web search/ }));
  };

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

    expect(screen.queryByText("Evil")).not.toBeInTheDocument();
    expect(screen.queryByText("Data")).not.toBeInTheDocument();
    expect(screen.getByText("Fine")).toBeInTheDocument();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(document.querySelector('a[href^="data:"]')).toBeNull();
  });

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
    expect(screen.queryByText(/2 results/)).not.toBeInTheDocument();
  });

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
    expect(screen.queryByText(/Used \d+ sources/)).not.toBeInTheDocument();
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

  it("renders no Sources row when the search returned an error", () => {
    renderMessage(
      searchMessage({
        kind: "search",
        query: "x",
        error: "Web search is unavailable.",
      }),
    );

    expect(screen.queryByText(/Used \d+ sources/)).not.toBeInTheDocument();
    openToolCard();
    expect(screen.getByText("Web search is unavailable.")).toBeInTheDocument();
  });

  it("shows the query on a compact card instead of the raw result JSON", () => {
    renderMessage(
      searchMessage({ kind: "search", query: "platypus habitat", results }),
    );
    openToolCard();

    expect(
      screen.getByRole("button", { name: /^Web search.*platypus habitat/ }),
    ).toBeInTheDocument();

    expect(screen.getByText(/2 results/)).toBeInTheDocument();
    expect(screen.queryByText("Parameters")).not.toBeInTheDocument();
  });

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

  it("says it is searching rather than reporting 0 results mid-call", () => {
    renderMessage(
      searchMessage({ kind: "search" }, [], { state: "input-available" }),
    );

    openToolCard();
    expect(screen.getByText("Searching…")).toBeInTheDocument();
    expect(screen.queryByText(/0 results/)).not.toBeInTheDocument();
  });

  it("claims no search in flight for a call that was denied", () => {
    renderMessage(
      searchMessage({ kind: "search" }, [], { state: "output-denied" }),
    );

    openToolCard();
    expect(screen.queryByText("Searching…")).not.toBeInTheDocument();
    expect(screen.queryByText(/0 results/)).not.toBeInTheDocument();
  });

  it("shows the card for a call still streaming its input", () => {
    renderMessage(
      searchMessage({ kind: "search" }, [], { state: "input-streaming" }),
    );

    openToolCard();
    expect(screen.getByText("Searching…")).toBeInTheDocument();
    expect(screen.queryByText("Parameters")).not.toBeInTheDocument();
  });

  // why: the pre-normalisation back-compat guess is deliberately out of scope
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

    expect(screen.queryByText(/Used \d+ sources/)).not.toBeInTheDocument();
    openToolCallGroups();
    fireEvent.click(screen.getByRole("button", { name: /^Web search/ }));
    expect(screen.getByText("Parameters")).toBeInTheDocument();
  });
});

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

    openToolCallGroups();
    fireEvent.click(screen.getByRole("button", { name: /^Web search/ }));
    expect(screen.getByText("1 result")).toBeInTheDocument();
    expect(
      screen.queryByText(/listed above as sources/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Parameters")).not.toBeInTheDocument();
  });

  it("lifts no sources out of a native search result", () => {
    renderMessage(nativeSearchMessage());

    expect(screen.queryByText(/Used \d+ sources/)).not.toBeInTheDocument();
  });

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

    expect(screen.queryByText(/Used \d+ sources/)).not.toBeInTheDocument();
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

  it("leaves an unreadable native search on the generic renderer", () => {
    renderMessage({
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-web_search",
          toolCallId: "c1",
          state: "input-available",
          input: { results: [{ url: "https://vendor.example/a" }] },
        },
      ],
    } as unknown as PlatypusUIMessage);

    openToolCallGroups();
    fireEvent.click(screen.getByRole("button", { name: /^Web search/ }));
    expect(screen.getByText("Parameters")).toBeInTheDocument();
    expect(screen.queryByText("Searching…")).not.toBeInTheDocument();
    expect(screen.queryByText(/Used \d+ sources/)).not.toBeInTheDocument();
  });
});

describe("ChatMessage reply Artifacts", () => {
  const scope = { orgId: "org1", workspaceId: "ws1" };

  const write = (over: Record<string, unknown> = {}) =>
    ({
      type: "tool-createArtifact",
      toolCallId: "call-1",
      state: "output-available",
      input: { title: "Release notes", type: "markdown", content: "# 1.0" },
      output: { id: "artifact-1", title: "Release notes", version: 1 },
      ...over,
    }) as unknown as MessagePart;

  const update = (version: number) =>
    write({
      type: "tool-updateArtifact",
      toolCallId: `call-update-${version}`,
      input: { id: "artifact-1", edits: [{ old: "1.0", new: "1.1" }] },
      output: { id: "artifact-1", title: "Release notes", version },
    });

  const message = (parts: MessagePart[]): PlatypusUIMessage => ({
    id: "m1",
    role: "assistant",
    parts,
  });

  const tray = () =>
    screen.queryByRole("list", { name: "Files and artifacts" });

  const readAt = (version: number) =>
    artifactReads.set(`artifact-1:${version}`, {
      data: {
        artifact: {
          id: "artifact-1",
          title: "Release notes",
          type: "markdown",
          language: null,
        },
        version: { version, content: "# 1.1" },
      },
    });

  it("moves a stored Artifact into the tray once the reply finishes", () => {
    readAt(1);
    const onOpenArtifact = vi.fn();
    renderMessage(message([write()]), {
      artifactScope: scope,
      onOpenArtifact,
    });

    const list = screen.getByRole("list", { name: "Files and artifacts" });
    expect(within(list).getByText("Release notes")).toBeInTheDocument();
    expect(within(list).getByText("Markdown · Version 1")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /open/i }));

    expect(onOpenArtifact).toHaveBeenCalledWith({
      id: "artifact-1",
      version: 1,
    });
  });

  it("keeps the Card where the call happened while the reply is still writing", () => {
    renderMessage(
      message([
        write({
          state: "input-streaming",
          input: { title: "Release notes", type: "markdown" },
          output: undefined,
        }),
      ]),
      { status: "streaming", artifactScope: scope },
    );

    expect(tray()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Release notes/ })).toBeEnabled();
  });

  it("lists several writes to one Artifact as one row, at the latest version", () => {
    readAt(2);
    renderMessage(message([write(), { type: "step-start" }, update(2)]), {
      artifactScope: scope,
    });

    const list = screen.getByRole("list", { name: "Files and artifacts" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("Markdown · Version 2")).toBeInTheDocument();
  });

  it("lists an earlier reply's Artifact while a later turn runs", () => {
    readAt(1);
    renderMessage(message([write()]), {
      status: "streaming",
      isLastMessage: false,
      artifactScope: scope,
    });

    expect(tray()).toBeVisible();
  });

  it("says a deleted Artifact is gone in its tray row", () => {
    artifactReads.set("artifact-1:1", { deleted: true });
    renderMessage(message([write()]), { artifactScope: scope });

    const list = screen.getByRole("list", { name: "Files and artifacts" });
    expect(within(list).getByText("Release notes")).toBeInTheDocument();
    expect(within(list).getByText(ARTIFACT_DELETED_DETAIL)).toBeInTheDocument();
    expect(within(list).queryByRole("button")).not.toBeInTheDocument();
  });

  it("leaves a failed write in the body as a call row with its reason", () => {
    renderMessage(
      message([
        write({
          state: "output-error",
          output: undefined,
          errorText: "Artifact content must be at most 512 KB",
        }),
      ]),
    );

    expect(tray()).not.toBeInTheDocument();
    expect(
      screen.getByText("Artifact content must be at most 512 KB"),
    ).toBeInTheDocument();
  });

  it("leaves a denied write in the body with its reason", () => {
    renderMessage(
      message([
        write({
          state: "output-denied",
          output: undefined,
          approval: {
            id: "approval-1",
            approved: false,
            reason: "Blocked by a Tool gate",
          },
        }),
      ]),
    );

    expect(tray()).not.toBeInTheDocument();
    expect(screen.getByText("Blocked by a Tool gate")).toBeInTheDocument();
  });

  it("leaves a rejected write in the body with its reason", () => {
    renderMessage(
      message([
        write({
          state: "approval-responded",
          output: undefined,
          approval: {
            id: "approval-1",
            approved: false,
            reason: "You did not approve this call",
          },
        }),
      ]),
    );

    expect(tray()).not.toBeInTheDocument();
    expect(
      screen.getByText("You did not approve this call"),
    ).toBeInTheDocument();
  });
});

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

  it("never matches an Artifact Card part", () => {
    expect(
      isGenericToolPart({
        type: "tool-createArtifact",
        toolCallId: "c1",
        state: "output-available",
        input: { title: "Plan", type: "markdown", content: "# Plan" },
        output: { id: "artifact-1", title: "Plan", version: 1 },
      } as unknown as Parameters<typeof isGenericToolPart>[0]),
    ).toBe(false);
  });

  it("never matches an Artifact update Card part", () => {
    expect(
      isGenericToolPart({
        type: "tool-updateArtifact",
        toolCallId: "c1",
        state: "output-available",
        input: { id: "artifact-1", edits: [{ old: "a", new: "b" }] },
        output: { id: "artifact-1", title: "Plan", version: 2 },
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

  it.each([
    ["input-available", false],
    ["output-available", false],
    ["output-error", true],
    ["output-denied", true],
    ["approval-requested", true],
  ])("treats an fsDownload part in %s as generic: %s", (state, generic) => {
    expect(
      isGenericToolPart({
        type: "tool-fsDownload",
        toolCallId: "c1",
        state,
        input: { path: "a.bin" },
        output: { path: "a.bin", size: 1 },
      } as unknown as Parameters<typeof isGenericToolPart>[0]),
    ).toBe(generic);
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

    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.queryByText("Parameters")).not.toBeInTheDocument();
    expect(screen.queryByText("Result")).not.toBeInTheDocument();
  });

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
    expect(screen.queryByText("Parameters")).not.toBeInTheDocument();
  });
});

const NOTICES = [
  {
    name: "truncation",
    flag: "truncatedByTokenLimit",
    notice: CUT_SHORT_NOTICE,
  },
  {
    name: "step-limit",
    flag: "stoppedAtStepLimit",
    notice: STEP_LIMIT_NOTICE,
  },
  {
    name: "search-unavailable",
    flag: "searchUnavailable",
    notice: SEARCH_UNAVAILABLE_NOTICE,
  },
] as const;

describe.each(NOTICES)("ChatMessage $name notice", ({ flag, notice }) => {
  it("marks a message the run flagged", () => {
    renderMessage(assistantMessage({ [flag]: true }));

    expect(screen.getByText(notice)).toBeInTheDocument();
  });

  it.each([
    ["a message that finished cleanly", { agentId: "agent-1" }],
    ["a message with no metadata at all", undefined],
  ] as const)("renders no notice for %s", (_, metadata) => {
    renderMessage(assistantMessage(metadata));

    expect(screen.queryByText(notice)).not.toBeInTheDocument();
  });

  it("keeps the agent avatar on a flagged agent turn", () => {
    renderMessage(assistantMessage({ agentId: "agent-1", [flag]: true }));

    expect(screen.getByAltText("Research Agent")).toBeInTheDocument();
    expect(screen.getByText(notice)).toBeInTheDocument();
  });
});

describe("ChatMessage transcript summary status", () => {
  const waiting: PlatypusUIMessage = {
    id: "m1",
    role: "assistant",
    parts: [
      {
        type: "data-transcript-summary-status",
        data: { text: "Summarising earlier messages…" },
      },
      { type: "text", text: "Reply" },
    ],
  };

  it("renders the status the turn streamed where the reply will be", () => {
    renderMessage(waiting, { status: "streaming" });

    expect(
      screen.getByText("Summarising earlier messages…"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("drops the status once the turn is over", () => {
    renderMessage(waiting, { status: "ready" });

    expect(
      screen.queryByText("Summarising earlier messages…"),
    ).not.toBeInTheDocument();
  });
});

describe("ChatMessage notices together", () => {
  it("renders the output-limit marker without the step-limit one", () => {
    renderMessage(assistantMessage({ truncatedByTokenLimit: true }));

    expect(screen.getByText(CUT_SHORT_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(STEP_LIMIT_NOTICE)).not.toBeInTheDocument();
  });

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
});

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

  const TOOL_PARTS = [
    ["a static tool", staticToolPart],
    ["a dynamic tool", dynamicToolPart],
  ] as const;

  const CARRIERS = [
    [
      "persisted on the part",
      (build: (m?: Record<string, unknown>) => unknown) =>
        withToolPart(build({ durationMs: 1234 })),
    ],
    [
      "delivered on the message",
      (build: (m?: Record<string, unknown>) => unknown) => {
        const message = withToolPart(build());
        message.metadata = { toolDurations: { "call-1": 1234 } };
        return message;
      },
    ],
  ] as const;

  it.each(
    TOOL_PARTS.flatMap(([partName, build]) =>
      CARRIERS.map(
        ([carrierName, carry]) =>
          [`${partName}, ${carrierName}`, carry(build)] as const,
      ),
    ),
  )("renders the duration for %s", (_, message) => {
    renderMessage(message);

    expect(screen.getByText(/1\.2s/)).toBeInTheDocument();
  });

  it("shows the same figure whichever carrier holds it", () => {
    const [, fromMessage] = CARRIERS[1];
    const { unmount } = renderMessage(fromMessage(staticToolPart));
    const live = screen.getByText(/1\.2s/).textContent;
    unmount();

    const [, fromPart] = CARRIERS[0];
    renderMessage(fromPart(staticToolPart));

    // eslint-disable-next-line jest-dom/prefer-to-have-text-content
    expect(screen.getByText(/1\.2s/).textContent).toBe(live);
  });

  it.each(TOOL_PARTS)(
    "renders no duration for %s recorded before timing existed",
    (_, build) => {
      renderMessage(withToolPart(build()));

      expect(screen.getByText("Completed")).toBeInTheDocument();
      expect(screen.queryByText(/\d+ms|\d+\.\d+s/)).not.toBeInTheDocument();
    },
  );
});

function userMessage(): PlatypusUIMessage {
  return {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "Ask" }],
  };
}

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
      expect(
        screen.queryByRole("button", { name: action }),
      ).not.toBeInTheDocument();
    }
  });

  it("still offers Copy to a reader", () => {
    renderMessage(userMessage(), { canSendMessages: false });

    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });
});

describe("ChatMessage action bar during a turn", () => {
  it.each(["submitted", "streaming"] as const)(
    "withholds the bar from the last reply while the chat is %s",
    (status) => {
      renderMessage({ ...assistantMessage(), parts: [] }, { status });

      for (const action of ["Copy", "Delete", "Regenerate"]) {
        expect(
          screen.queryByRole("button", { name: action }),
        ).not.toBeInTheDocument();
      }
    },
  );

  it("keeps the bar on earlier messages while the chat is submitted", () => {
    renderMessage(userMessage(), { status: "submitted", isLastMessage: false });

    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it.each(["submitted", "streaming"] as const)(
    "keeps the bar on the last user message while the chat is %s",
    (status) => {
      renderMessage(userMessage(), { status, isLastMessage: true });

      for (const action of ["Edit", "Copy", "Delete"]) {
        expect(
          screen.getByRole("button", { name: action }),
        ).toBeInTheDocument();
      }
    },
  );

  it("shows the bar once the chat is ready", () => {
    renderMessage(assistantMessage(), { status: "ready" });

    expect(
      screen.getByRole("button", { name: "Regenerate" }),
    ).toBeInTheDocument();
  });
});

describe("ChatMessage Alternatives", () => {
  const second = {
    index: 1,
    count: 3,
    previousId: "u1-a",
    nextId: "u1-c",
  };
  const first = {
    index: 0,
    count: 2,
    previousId: null,
    nextId: "m1-b",
  };

  it("labels a user message's position and moves between its Alternatives", () => {
    const onSwitchAlternative = vi.fn();
    renderMessage(userMessage(), { alternatives: second, onSwitchAlternative });

    expect(
      screen.getByRole("group", { name: "Message 2 of 3" }),
    ).toHaveTextContent("2/3");
    fireEvent.click(screen.getByRole("button", { name: "Next message" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous message" }));

    expect(onSwitchAlternative.mock.calls).toEqual([
      ["u1", "u1-c"],
      ["u1", "u1-a"],
    ]);
  });

  it("labels a reply's position, with no way past the first", () => {
    renderMessage(assistantMessage(), { alternatives: first });

    expect(
      screen.getByRole("group", { name: "Response 1 of 2" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Previous response" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next response" })).toBeEnabled();
  });

  it("never calls them versions or branches", () => {
    const { container } = renderMessage(assistantMessage(), {
      alternatives: first,
    });

    expect(container.innerHTML).not.toMatch(/version|branch/i);
  });

  it("shows no arrows to a reader", () => {
    renderMessage(userMessage(), {
      alternatives: second,
      canSendMessages: false,
    });

    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /message$/ }),
    ).not.toBeInTheDocument();
  });

  it("shows no arrows on a message with no Alternatives", () => {
    renderMessage(userMessage());

    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it.each(["submitted", "streaming"] as const)(
    "holds the arrows and Regenerate on earlier replies while the chat is %s",
    (status) => {
      renderMessage(assistantMessage(), {
        alternatives: { ...first, index: 1, previousId: "m1-a" },
        status,
        isLastMessage: false,
      });

      for (const action of ["Previous response", "Regenerate"]) {
        expect(screen.getByRole("button", { name: action })).toBeDisabled();
      }
    },
  );
});

describe("ChatMessage while editing", () => {
  const editing = { editor: <div data-testid="editor">editing</div> };

  it("renders the edit surface in the message's place", () => {
    renderMessage(userMessage(), editing);

    expect(screen.getByTestId("editor")).toBeInTheDocument();
    expect(screen.queryByText("Ask")).not.toBeInTheDocument();
  });

  it("withholds the message's own actions", () => {
    renderMessage(userMessage(), editing);

    for (const action of ["Edit", "Copy", "Delete"]) {
      expect(
        screen.queryByRole("button", { name: action }),
      ).not.toBeInTheDocument();
    }
  });

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

    expect(screen.queryByAltText("shot.png")).not.toBeInTheDocument();
  });
});

describe("ChatMessage dynamic tool renderer", () => {
  const dynamicToolMessage = (
    state: "input-available" | "output-available",
  ): PlatypusUIMessage => ({
    id: "m1",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "github__create_issue",
        toolCallId: "c1",
        state,
        input: { title: "Fix the thing" },
        output: state === "output-available" ? { number: 7 } : undefined,
      } as unknown as MessagePart,
    ],
  });

  it("names the row after the tool and stays collapsed until clicked", () => {
    renderMessage(dynamicToolMessage("output-available"));
    openToolCallGroups();

    const trigger = screen.getByRole("button", {
      name: /^github__create_issue/,
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByText("Parameters")).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(screen.getByText("Parameters")).toBeInTheDocument();
    expect(screen.getByText("Result")).toBeInTheDocument();
  });

  it("reports a running call in the shared status words", () => {
    renderMessage(dynamicToolMessage("input-available"));

    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("shows a call a Tool gate denied, with the gate's reason", () => {
    renderMessage({
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "db__drop_table",
          toolCallId: "c1",
          state: "output-denied",
          input: { table: "users" },
          approval: {
            id: "a1",
            approved: false,
            reason: 'Blocked by the "No DROP" Tool gate: Drops a table.',
          },
        } as unknown as MessagePart,
      ],
    });
    openToolCallGroups();
    fireEvent.click(screen.getByRole("button", { name: /^db__drop_table/ }));

    expect(screen.getByText("Denied")).toBeInTheDocument();
    expect(
      screen.getByText('Blocked by the "No DROP" Tool gate: Drops a table.'),
    ).toBeInTheDocument();
  });
});

describe("ChatMessage tool approvals", () => {
  const waiting: PlatypusUIMessage = {
    id: "m1",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "db__drop_table",
        toolCallId: "c1",
        state: "approval-requested",
        input: { table: "users" },
        approval: {
          id: "ap1",
          requestReason:
            'The "Cautious" Tool gate wants a person to approve this call: Drops a table.',
        },
      } as unknown as MessagePart,
    ],
  };

  it("shows the call, its input and the gate's reason, with Approve and Deny", () => {
    const onApprovalResponse = vi.fn();
    renderMessage(waiting, { onApprovalResponse });

    expect(screen.getByText("db__drop_table")).toBeInTheDocument();
    expect(screen.getByText(/"table": "users"/)).toBeInTheDocument();
    expect(
      screen.getByText(
        'The "Cautious" Tool gate wants a person to approve this call: Drops a table.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprovalResponse).toHaveBeenCalledWith("ap1", true);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onApprovalResponse).toHaveBeenCalledWith("ap1", false);
  });

  it("shows a call the User denied as Denied, with the reason", () => {
    renderMessage({
      ...waiting,
      parts: [
        {
          ...(waiting.parts[0] as object),
          state: "approval-responded",
          approval: {
            id: "ap1",
            approved: false,
            reason: "The User sent a new message instead.",
          },
        } as unknown as MessagePart,
      ],
    });
    openToolCallGroups();
    fireEvent.click(screen.getByRole("button", { name: /^db__drop_table/ }));

    expect(screen.getByText("Denied")).toBeInTheDocument();
    expect(
      screen.getByText("The User sent a new message instead."),
    ).toBeInTheDocument();
  });

  it("offers no answer where the reply cannot be resumed", () => {
    renderMessage(waiting);

    expect(screen.getByText("Approval Requested")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Deny" }),
    ).not.toBeInTheDocument();
  });
});

describe("ChatMessage Tool call groups", () => {
  const call = (id: string, toolName: string, state = "output-available") =>
    ({
      type: "dynamic-tool",
      toolName,
      toolCallId: id,
      state,
      input: {},
      output: state === "output-available" ? "ok" : undefined,
      errorText: state === "output-error" ? "boom" : undefined,
    }) as unknown as MessagePart;

  const delegate = {
    type: "tool-delegateToResearchBot",
    toolCallId: "d1",
    state: "output-available",
    input: { task: "Find it" },
    output: { entries: [], text: "Found." },
  } as unknown as MessagePart;

  const message = (parts: MessagePart[]): PlatypusUIMessage => ({
    id: "m1",
    role: "assistant",
    parts,
  });

  const groupHeaders = () =>
    screen.queryAllByRole("button", { name: /^\d+ tool calls?:/ });

  it("folds adjacent calls into one group, across a step boundary", () => {
    renderMessage(
      message([
        call("c1", "alpha"),
        { type: "step-start" },
        call("c2", "beta"),
        call("c3", "alpha"),
      ]),
    );

    expect(groupHeaders().map((header) => header.ariaLabel)).toEqual([
      "3 tool calls: alpha, beta",
    ]);
  });

  it("ends a group at text and at a Sub-Agent delegation", () => {
    renderMessage(
      message([
        call("c1", "alpha"),
        { type: "text", text: "Between" },
        call("c2", "beta"),
        delegate,
        call("c3", "gamma"),
      ]),
    );

    expect(groupHeaders().map((header) => header.ariaLabel)).toEqual([
      "1 tool call: alpha",
      "1 tool call: beta",
      "1 tool call: gamma",
    ]);
    expect(screen.getByText("Research Bot")).toBeVisible();
  });

  it("keeps each call its own disclosure inside an opened group", () => {
    renderMessage(message([call("c1", "alpha"), call("c2", "beta")]));
    openToolCallGroups();

    fireEvent.click(screen.getByRole("button", { name: /^beta/ }));

    expect(screen.getByRole("button", { name: /^alpha/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: /^beta/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("shows a verb while the last group of a streaming reply is active", () => {
    renderMessage(message([call("c1", "alpha", "input-available")]), {
      status: "streaming",
    });

    expect(groupHeaders()[0]).not.toHaveTextContent("alpha");
  });

  it("settles a group once a later part follows it, mid-turn", () => {
    renderMessage(
      message([call("c1", "alpha"), { type: "text", text: "Next" }]),
      { status: "streaming" },
    );

    expect(groupHeaders()[0]).toHaveTextContent("alpha");
  });

  it("settles the last group when the turn is stopped", () => {
    const parts = [call("c1", "alpha", "input-available")];
    const { rerender } = renderMessage(message(parts), { status: "streaming" });
    expect(groupHeaders()[0]).not.toHaveTextContent("alpha");

    rerender(
      <ChatMessage
        message={message(parts)}
        isLastMessage
        status="ready"
        canSendMessages
        agents={agents}
        onEditStart={vi.fn()}
        onMessageDelete={vi.fn()}
        onSwitchAlternative={vi.fn()}
        onCopyMessage={vi.fn()}
        copied={false}
      />,
    );

    expect(groupHeaders()[0]).toHaveTextContent("alpha");
  });

  it("badges a settled group when one of its calls failed", () => {
    renderMessage(
      message([call("c1", "alpha"), call("c2", "beta", "output-error")]),
    );

    expect(groupHeaders()[0]).toHaveAccessibleName(
      "2 tool calls: alpha, beta (with errors)",
    );
    expect(groupHeaders()[0]).toHaveTextContent("Error");
  });
});

describe("ChatMessage offered files", () => {
  const offer = (id: string, path: string, state = "output-available") =>
    ({
      type: "tool-fsDownload",
      toolCallId: id,
      state,
      input: { path },
      output: state === "output-available" ? { path, size: 10 } : undefined,
      errorText: state === "output-error" ? "File not found" : undefined,
      approval:
        state === "output-denied"
          ? { id: "a1", approved: false, reason: "Blocked by a Tool gate" }
          : undefined,
    }) as unknown as MessagePart;

  const call = (id: string, toolName: string) =>
    ({
      type: "dynamic-tool",
      toolName,
      toolCallId: id,
      state: "output-available",
      input: {},
      output: "ok",
    }) as unknown as MessagePart;

  const message = (parts: MessagePart[]): PlatypusUIMessage => ({
    id: "m1",
    role: "assistant",
    parts,
  });

  const tray = () =>
    screen.queryByRole("list", { name: "Files and artifacts" });

  it("lists each offered path once, in a tray under the finished reply", () => {
    renderMessage(
      message([
        offer("c1", "a.csv"),
        { type: "step-start" },
        offer("c2", "a.csv"),
        offer("c3", "b.pdf"),
        { type: "text", text: "Done" },
      ]),
    );

    expect(screen.getAllByRole("link", { name: /download/i })).toHaveLength(2);
    expect(tray()).toBeVisible();
  });

  it("shows no tray while the turn is in flight", () => {
    renderMessage(message([offer("c1", "a.csv")]), { status: "streaming" });

    expect(tray()).not.toBeInTheDocument();
  });

  it("shows the tray on an earlier message while a later turn runs", () => {
    renderMessage(message([offer("c1", "a.csv")]), {
      status: "streaming",
      isLastMessage: false,
    });

    expect(tray()).toBeVisible();
  });

  it("shows no tray when nothing was offered", () => {
    renderMessage(message([{ type: "text", text: "Hi" }]));

    expect(tray()).not.toBeInTheDocument();
  });

  it("groups the calls on either side of an offer together", () => {
    renderMessage(
      message([call("c1", "alpha"), offer("c2", "a.csv"), call("c3", "beta")]),
    );

    expect(
      screen
        .queryAllByRole("button", { name: /^\d+ tool calls?:/ })
        .map((header) => header.ariaLabel),
    ).toEqual(["2 tool calls: alpha, beta"]);
  });

  it("renders a failed offer inline as a tool error, not in the tray", () => {
    renderMessage(message([offer("c1", "gone.txt", "output-error")]));

    expect(tray()).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^1 tool call:.*with errors/ }),
    ).toBeVisible();
  });

  it("renders a denied offer inline, not in the tray", () => {
    renderMessage(message([offer("c1", "secret.txt", "output-denied")]));
    openToolCallGroups();
    fireEvent.click(screen.getByRole("button", { name: /^Fs Download/i }));

    expect(tray()).not.toBeInTheDocument();
    expect(screen.getByText("Blocked by a Tool gate")).toBeInTheDocument();
  });
});

describe("ChatMessage line breaks", () => {
  const text = "first line\nsecond line";

  it("keeps a single newline in a user message as a line break", () => {
    renderMessage({ id: "u1", role: "user", parts: [{ type: "text", text }] });

    expect(screen.getByText(/first line/).innerHTML).toContain("<br>");
  });

  it("leaves an assistant reply's single newline to Markdown", () => {
    renderMessage({
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text }],
    });

    expect(screen.getByText(/first line/).innerHTML).not.toContain("<br>");
  });
});
