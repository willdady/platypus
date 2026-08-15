import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Agent } from "@platypus/schemas";
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
