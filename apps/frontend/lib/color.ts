const DARK_TEXT = "#0a0a0a";
const LIGHT_TEXT = "#ffffff";

/** The sRGB channels of a `#rgb` or `#rrggbb` colour, or null. */
function parseHex(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const hex =
    match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** WCAG relative luminance of an sRGB colour. */
function luminance([r, g, b]: [number, number, number]): number {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

const contrast = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * Dark or light text, whichever contrasts more with `background` — for a
 * user-picked colour such as a Kanban label, where the theme's own text colour
 * may vanish into it. Undefined for a colour that isn't hex, leaving the text
 * to the theme.
 */
export function readableTextColor(background: string): string | undefined {
  const rgb = parseHex(background);
  if (!rgb) return undefined;
  const bg = luminance(rgb);
  const dark = luminance(parseHex(DARK_TEXT)!);
  return contrast(bg, dark) >= contrast(bg, 1) ? DARK_TEXT : LIGHT_TEXT;
}
