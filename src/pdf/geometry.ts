import type { Bounds, Edit, PageInfo } from "../types";

export type Matrix = [number, number, number, number, number, number];

/** Returns outer ∘ inner: applies `inner` first, then `outer` (PDF row-vector form). */
export function compose(outer: number[], inner: number[]): Matrix {
  const [a1, b1, c1, d1, e1, f1] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function invert(m: number[]): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * Matrix that maps "upright display space" (page units with y pointing up,
 * origin bottom-left of the displayed page) into the page's PDF user space.
 * Drawing in this space makes edits land exactly where they were placed on
 * screen, including on rotated pages and pages with an offset crop box.
 */
export function displayToPdfMatrix(page: PageInfo): Matrix {
  const flip: Matrix = [1, 0, 0, -1, 0, page.height];
  return compose(invert(page.transform), flip);
}

export function editBounds(edit: Edit, measureText?: (e: Edit) => Bounds): Bounds {
  switch (edit.kind) {
    case "rect":
    case "image":
      return { x: edit.x, y: edit.y, w: edit.w, h: edit.h };
    case "ink": {
      const xs = edit.points.map((p) => p[0]);
      const ys = edit.points.map((p) => p[1]);
      const pad = edit.width / 2;
      const x = Math.min(...xs) - pad;
      const y = Math.min(...ys) - pad;
      return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
    }
    case "text":
      return measureText ? measureText(edit) : { x: edit.x, y: edit.y, w: 0, h: edit.size * 1.2 };
  }
}

export function moveEdit(edit: Edit, dx: number, dy: number): void {
  if (edit.kind === "ink") {
    edit.points = edit.points.map(([x, y]) => [x + dx, y + dy]);
  } else {
    edit.x += dx;
    edit.y += dy;
  }
}

export function hexToRgb01(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}
