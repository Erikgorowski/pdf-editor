import type { FontKey } from "../types";

/** Styles for newly created edits; the properties bar updates these as the user changes them. */
export const defaults = {
  text: { font: "Helvetica" as FontKey, size: 12, bold: false, italic: false, color: "#111827" },
  highlight: { color: "#ffd43b", opacity: 0.45 },
  draw: { color: "#1d4ed8", width: 2 },
};
