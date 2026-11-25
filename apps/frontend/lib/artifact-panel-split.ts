export const ARTIFACT_CHAT_DEFAULT_WIDTH = 896;
export const ARTIFACT_CHAT_MIN_WIDTH = 360;
export const ARTIFACT_PANEL_MIN_WIDTH = 400;

export const ARTIFACT_CHAT_WIDTH_KEY = "platypus:chat:artifact-panel-width";

export type ArtifactPanelSplit = {
  chatPercent: number;
  panelPercent: number;
  chatMinPercent: number;
  panelMinPercent: number;
};

export const ARTIFACT_SPLIT_MIN_ROW_WIDTH =
  ARTIFACT_CHAT_MIN_WIDTH + ARTIFACT_PANEL_MIN_WIDTH;

export function rowFitsSplit(rowWidth: number): boolean {
  return rowWidth >= ARTIFACT_SPLIT_MIN_ROW_WIDTH;
}

export function defaultChatWidth(rowWidth: number): number {
  if (rowWidth <= 0) return 0;
  return chatWidthWithin(
    rowWidth,
    Math.min(ARTIFACT_CHAT_DEFAULT_WIDTH, rowWidth - ARTIFACT_PANEL_MIN_WIDTH),
  );
}

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

export function chatWidthFromPercent(
  percent: number,
  rowWidth: number,
): number {
  return (percent / 100) * rowWidth;
}

export function chatColumnClass(panelOpen: boolean): string {
  return panelOpen ? "w-full" : "w-full xl:w-4/5 max-w-4xl";
}

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

export function storeChatWidth(width: number): void {
  try {
    localStorage.setItem(ARTIFACT_CHAT_WIDTH_KEY, String(Math.round(width)));
  } catch {}
}

export function clearStoredChatWidth(): void {
  try {
    localStorage.removeItem(ARTIFACT_CHAT_WIDTH_KEY);
  } catch {}
}
