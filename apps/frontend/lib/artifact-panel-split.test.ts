import { describe, it, expect, beforeEach } from "vitest";
import {
  ARTIFACT_CHAT_WIDTH_KEY,
  artifactPanelSplit,
  chatColumnClass,
  chatWidthFromPercent,
  clearStoredChatWidth,
  defaultChatWidth,
  readStoredChatWidth,
  rowFitsSplit,
  storeChatWidth,
} from "./artifact-panel-split";

describe("defaultChatWidth", () => {
  it("holds the Chat at its reading width on a wide row", () => {
    expect(defaultChatWidth(1440)).toBe(896);
    expect(defaultChatWidth(2560)).toBe(896);
  });

  it("leaves the panel its minimum when the row is narrower", () => {
    expect(defaultChatWidth(1024)).toBe(624);
  });

  it("never takes the Chat below its own minimum", () => {
    expect(defaultChatWidth(760)).toBe(360);
    expect(defaultChatWidth(700)).toBe(360);
  });

  it("has no width without a row to measure", () => {
    expect(defaultChatWidth(0)).toBe(0);
  });
});

describe("artifactPanelSplit", () => {
  it("converts the default split against the measured row", () => {
    expect(artifactPanelSplit(1440)).toEqual({
      chatPercent: 62.22,
      panelPercent: 37.78,
      chatMinPercent: 25,
      panelMinPercent: 27.78,
    });
  });

  it("always adds up to a whole row, minimums included", () => {
    for (const available of [100, 360, 600, 700, 760, 1024, 1440, 2560]) {
      const split = artifactPanelSplit(available);
      expect(split.chatPercent + split.panelPercent).toBe(100);
      expect(split.chatMinPercent + split.panelMinPercent).toBeLessThanOrEqual(
        100,
      );
    }
  });

  it("clamps a remembered width to the minimums", () => {
    expect(artifactPanelSplit(1440, 200).chatPercent).toBe(25);
    expect(artifactPanelSplit(1440, 2000).chatPercent).toBe(72.22);
  });

  it("keeps the Chat at its minimum on a row too narrow for both", () => {
    const split = artifactPanelSplit(700, 500);
    expect(split.chatPercent).toBe(51.43);
    expect(split.panelPercent).toBe(48.57);
    expect(split.chatMinPercent).toBe(51.43);
    expect(split.panelMinPercent).toBe(48.57);
  });
});

describe("the remembered Chat width", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips the width it was given", () => {
    storeChatWidth(612.6);
    expect(readStoredChatWidth()).toBe(613);
    expect(localStorage.getItem(ARTIFACT_CHAT_WIDTH_KEY)).toBe("613");
  });

  it("reads nothing from missing or unreadable storage", () => {
    expect(readStoredChatWidth()).toBeNull();
    localStorage.setItem(ARTIFACT_CHAT_WIDTH_KEY, "wide");
    expect(readStoredChatWidth()).toBeNull();
    localStorage.setItem(ARTIFACT_CHAT_WIDTH_KEY, "-20");
    expect(readStoredChatWidth()).toBeNull();
  });

  it("forgets the width when cleared", () => {
    storeChatWidth(700);
    clearStoredChatWidth();
    expect(readStoredChatWidth()).toBeNull();
  });
});

describe("rowFitsSplit", () => {
  it("needs room for both minimums", () => {
    expect(rowFitsSplit(759)).toBe(false);
    expect(rowFitsSplit(760)).toBe(true);
    expect(rowFitsSplit(1440)).toBe(true);
  });
});

describe("chatWidthFromPercent", () => {
  it("turns a dragged split back into the Chat's pixels", () => {
    expect(chatWidthFromPercent(50, 1440)).toBe(720);
    expect(chatWidthFromPercent(62.22, 1136)).toBeCloseTo(706.82, 2);
  });
});

describe("chatColumnClass", () => {
  it("keeps the centred reading measure while the panel is closed", () => {
    expect(chatColumnClass(false)).toBe("w-full xl:w-4/5 max-w-4xl");
  });

  it("fills the column while the panel is open", () => {
    expect(chatColumnClass(true)).toBe("w-full");
  });
});
