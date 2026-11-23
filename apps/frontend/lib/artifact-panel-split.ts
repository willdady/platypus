/** The Chat's width beside an open Artifact panel, before the User drags. */
export const ARTIFACT_CHAT_DEFAULT_WIDTH = 896;
/** The narrowest the Chat may be, by default or by drag. */
export const ARTIFACT_CHAT_MIN_WIDTH = 360;
/** The narrowest the Artifact panel may be, by default or by drag. */
export const ARTIFACT_PANEL_MIN_WIDTH = 400;

/** Where this browser remembers the Chat's chosen width, in pixels. */
export const ARTIFACT_CHAT_WIDTH_KEY = "platypus:chat:artifact-panel-width";

/**
 * The split between the Chat and an open Artifact panel, as percentages of the
 * row that holds them. `react-resizable-panels` positions its panels by
 * percentage, so the pixel rules are converted against the row's measured
 * width and recomputed whenever that width changes.
 */
export type ArtifactPanelSplit = {
  chatPercent: number;
  panelPercent: number;
  chatMinPercent: number;
  panelMinPercent: number;
};

/** The narrowest row that can hold both minimums side by side. */
export const ARTIFACT_SPLIT_MIN_ROW_WIDTH =
  ARTIFACT_CHAT_MIN_WIDTH + ARTIFACT_PANEL_MIN_WIDTH;

/** Whether `rowWidth` is wide enough to hold the Chat and the panel apart. */
export function rowFitsSplit(rowWidth: number): boolean {
  return rowWidth >= ARTIFACT_SPLIT_MIN_ROW_WIDTH;
}

/**
 * The Chat's width for a row `rowWidth` pixels wide: `min(896, rowWidth −
 * 400)`, never under 360. A row too narrow to hold both minimums gives the
 * Chat its 360 and leaves the panel whatever remains.
 */
export function defaultChatWidth(rowWidth: number): number {
  if (rowWidth <= 0) return 0;
  return chatWidthWithin(
    rowWidth,
    Math.min(ARTIFACT_CHAT_DEFAULT_WIDTH, rowWidth - ARTIFACT_PANEL_MIN_WIDTH),
  );
}

/**
 * The pane sizes for a row `rowWidth` pixels wide. Without a `chatWidth`, the
 * Chat takes its default width; a remembered width is clamped to the same
 * minimums, so a stored value never produces an invalid split.
 */
export function artifactPanelSplit(
  rowWidth: number,
  chatWidth?: number,
): ArtifactPanelSplit {
  if (rowWidth <= 0) {
    return {
      chatPercent: 0,
      panelPercent: 0,
      chatMinPercent: 0,
      panelMinPercent: 0,
    };
  }
  const width = chatWidthWithin(
    rowWidth,
    chatWidth ?? defaultChatWidth(rowWidth),
  );
  const panelWidth = rowWidth - width;
  const chatPercent = percentOf(width, rowWidth);
  return {
    chatPercent,
    panelPercent: Math.round((100 - chatPercent) * 100) / 100,
    chatMinPercent: percentOf(
      Math.min(ARTIFACT_CHAT_MIN_WIDTH, width),
      rowWidth,
    ),
    panelMinPercent: percentOf(
      Math.min(ARTIFACT_PANEL_MIN_WIDTH, panelWidth),
      rowWidth,
    ),
  };
}

function chatWidthWithin(rowWidth: number, preferred: number): number {
  const chatMin = Math.min(ARTIFACT_CHAT_MIN_WIDTH, rowWidth);
  const panelMin = Math.min(
    ARTIFACT_PANEL_MIN_WIDTH,
    Math.max(0, rowWidth - chatMin),
  );
  const chatMax = Math.max(chatMin, rowWidth - panelMin);
  return Math.min(chatMax, Math.max(chatMin, preferred));
}

function percentOf(pixels: number, rowWidth: number): number {
  return Math.round((pixels / rowWidth) * 10000) / 100;
}

/** The Chat's pixel width from a split percentage, for a remembered drag. */
export function chatWidthFromPercent(
  percent: number,
  rowWidth: number,
): number {
  return (percent / 100) * rowWidth;
}

/**
 * The Chat's reading column: `max-w-4xl` and four fifths of an `xl` window,
 * unless the Artifact panel is open — then the column the split gives the Chat
 * is filled edge to edge, with no empty margin beside the panel.
 */
export function chatColumnClass(panelOpen: boolean): string {
  return panelOpen ? "w-full" : "w-full xl:w-4/5 max-w-4xl";
}

/**
 * The width this browser remembered for the Chat, or `null` when none was
 * stored or storage cannot be read.
 */
export function readStoredChatWidth(): number | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const stored = localStorage.getItem(ARTIFACT_CHAT_WIDTH_KEY);
    if (stored === null) return null;
    const width = Number(stored);
    return Number.isFinite(width) && width > 0 ? width : null;
  } catch {
    return null;
  }
}

/** Remembers the Chat's width for this browser. Storage may refuse. */
export function storeChatWidth(width: number): void {
  try {
    localStorage.setItem(ARTIFACT_CHAT_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Not persisted; the split on screen still applies.
  }
}

/** Forgets the remembered width, so the next open uses the default split. */
export function clearStoredChatWidth(): void {
  try {
    localStorage.removeItem(ARTIFACT_CHAT_WIDTH_KEY);
  } catch {
    // Nothing stored to clear.
  }
}
