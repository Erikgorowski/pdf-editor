// All edit coordinates are in "page units": the page as displayed at 100%
// zoom (1 unit = 1 PDF point), origin at the top-left, y pointing down.
// The viewer multiplies by the zoom factor; apply.ts maps them into PDF space.

export type FontKey = "Helvetica" | "Times" | "Courier";

interface BaseEdit {
  id: string;
  page: number;
}

export interface TextEdit extends BaseEdit {
  kind: "text";
  x: number;
  y: number; // top of the text box
  text: string;
  size: number;
  font: FontKey;
  bold: boolean;
  italic: boolean;
  color: string; // #rrggbb
}

export interface RectEdit extends BaseEdit {
  kind: "rect";
  mode: "whiteout" | "highlight";
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  opacity: number;
}

export interface InkEdit extends BaseEdit {
  kind: "ink";
  points: [number, number][];
  color: string;
  width: number;
}

export interface ImageEdit extends BaseEdit {
  kind: "image";
  x: number;
  y: number;
  w: number;
  h: number;
  src: string; // data: URL (PNG or JPEG)
}

export type Edit = TextEdit | RectEdit | InkEdit | ImageEdit;

export interface PageInfo {
  index: number;
  width: number; // displayed width at 100% (respects /Rotate)
  height: number;
  rotate: number;
  transform: number[]; // pdf.js viewport transform at scale 1 (PDF space -> page units)
}

export type Tool = "select" | "edittext" | "text" | "whiteout" | "highlight" | "draw";

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}
