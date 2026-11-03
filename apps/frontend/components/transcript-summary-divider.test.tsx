import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { TranscriptSummaryStats } from "@platypus/schemas";
import type { ChatTranscriptSummary } from "@/lib/chat-summary";
import {
  SUMMARY_DIVIDER_TEXT,
  TranscriptSummaryDivider,
} from "./transcript-summary-divider";

const SUMMARY_TEXT = "The earlier messages, condensed.";

function stats(
  overrides: Partial<TranscriptSummaryStats> = {},
): TranscriptSummaryStats {
  return {
    modelId: "claude-sonnet-4-5",
    inputTokens: 12_345,
    outputTokens: 678,
    triggeredFromOccupancy: 0.82,
    ...overrides,
  };
}

function summary(
  overrides: Partial<ChatTranscriptSummary> = {},
): ChatTranscriptSummary {
  return {
    id: "summary-1",
    chatId: "chat-1",
    anchorId: "message-1",
    coveredIds: ["message-1"],
    text: SUMMARY_TEXT,
    stats: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function expand() {
  fireEvent.click(screen.getByRole("button", { name: SUMMARY_DIVIDER_TEXT }));
}

describe("TranscriptSummaryDivider", () => {
  it("shows no cost until the divider is expanded", () => {
    render(<TranscriptSummaryDivider summary={summary({ stats: stats() })} />);

    expect(screen.getByText(SUMMARY_DIVIDER_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(/Summarised by/)).not.toBeInTheDocument();
  });

  it("shows the model and formatted token counts when expanded", () => {
    render(<TranscriptSummaryDivider summary={summary({ stats: stats() })} />);

    expand();

    expect(screen.getByText(SUMMARY_TEXT)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Summarised by claude-sonnet-4-5 · 12,345 input · 678 output tokens",
      ),
    ).toBeInTheDocument();
  });

  it("shows only the summary text when the summary has no stats", () => {
    render(<TranscriptSummaryDivider summary={summary({ stats: null })} />);

    expand();

    expect(screen.getByText(SUMMARY_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(/Summarised by/)).not.toBeInTheDocument();
  });

  it("shows the model but no counts when the provider reported no usage", () => {
    render(
      <TranscriptSummaryDivider
        summary={summary({
          stats: stats({ inputTokens: 0, outputTokens: 0 }),
        })}
      />,
    );

    expand();

    expect(
      screen.getByText("Summarised by claude-sonnet-4-5"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/input/)).not.toBeInTheDocument();
    expect(screen.queryByText(/output tokens/)).not.toBeInTheDocument();
  });

  it("leaves out a single count the provider did not report", () => {
    render(
      <TranscriptSummaryDivider
        summary={summary({ stats: stats({ inputTokens: 0 }) })}
      />,
    );

    expand();

    expect(
      screen.getByText("Summarised by claude-sonnet-4-5 · 678 output tokens"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/input/)).not.toBeInTheDocument();
  });
});
