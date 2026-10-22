import type { FontKey } from "./types";

// Arial, Times New Roman and Courier New ship with every Windows install and
// are metric-compatible with the PDF standard fonts pdf-lib writes, so what
// the user types on screen lines up with what ends up in the saved PDF.
export const FONT_CSS: Record<FontKey, string> = {
  Helvetica: 'Arial, Helvetica, "Liberation Sans", sans-serif',
  Times: '"Times New Roman", Times, "Liberation Serif", serif',
  Courier: '"Courier New", Courier, "Liberation Mono", monospace',
};

export const FONT_LABEL: Record<FontKey, string> = {
  Helvetica: "Sans (Arial)",
  Times: "Serif (Times)",
  Courier: "Mono (Courier)",
};

export const LINE_HEIGHT = 1.2;

const baselineCache = new Map<string, number>();

/**
 * Distance from the top of a text box to the first baseline, as a fraction of
 * the font size, measured from the real browser layout. Using the measured
 * value for both the on-screen box and the PDF output keeps them aligned.
 */
export function baselineRatio(font: FontKey, bold = false, italic = false): number {
  const key = `${font}|${bold}|${italic}`;
  const cached = baselineCache.get(key);
  if (cached !== undefined) return cached;

  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute;visibility:hidden;left:-9999px;top:0;
    font-family:${FONT_CSS[font]};font-size:100px;line-height:${LINE_HEIGHT};
    font-weight:${bold ? 700 : 400};font-style:${italic ? "italic" : "normal"};white-space:pre`;
  const marker = document.createElement("span");
  marker.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
  probe.append(marker, document.createTextNode("Hg"));
  document.body.append(probe);
  const ratio = marker.offsetTop / 100;
  probe.remove();

  const value = ratio > 0.3 && ratio < 1.5 ? ratio : 0.95;
  baselineCache.set(key, value);
  return value;
}

/** Guesses the closest standard font for a PDF font name such as "ABCDEF+Calibri-Bold". */
export function guessFont(
  name: string,
  family = "",
  flags: { bold?: boolean; italic?: boolean } = {},
): { font: FontKey; bold: boolean; italic: boolean } {
  const n = `${name} ${family}`.toLowerCase();
  let font: FontKey = "Helvetica";
  if (/courier|mono|consol|menlo|typewriter/.test(n)) font = "Courier";
  else if (/times|serif(?!.*sans)|georgia|garamond|cambria|minion|book|palatino|roman/.test(n) && !/sans/.test(n)) font = "Times";
  return {
    font,
    bold: Boolean(flags.bold) || /bold|black|heavy|semibold|demi|,b\b/.test(n),
    italic: Boolean(flags.italic) || /italic|oblique|,i\b/.test(n),
  };
}
