import {
  BlendMode,
  LineCapStyle,
  LineJoinStyle,
  PDFDocument,
  StandardFonts,
  concatTransformationMatrix,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import { LINE_HEIGHT, baselineRatio } from "../fonts";
import type { Edit, FontKey, PageInfo, TextEdit } from "../types";
import { displayToPdfMatrix, hexToRgb01 } from "./geometry";

const STANDARD: Record<FontKey, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  // regular, bold, italic, bold-italic
  Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  Courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

export async function openForWrite(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
}

/** Burns the edits into the PDF content and returns the new file bytes. */
export async function applyEdits(bytes: Uint8Array, edits: Edit[], pages: PageInfo[]): Promise<Uint8Array> {
  if (edits.length === 0) return bytes;
  const doc = await openForWrite(bytes);
  await drawEdits(doc, edits, pages);
  return doc.save();
}

export async function drawEdits(doc: PDFDocument, edits: Edit[], pages: PageInfo[]) {
  const fonts = new Map<string, PDFFont>();
  const images = new Map<string, PDFImage>();
  const font = async (e: TextEdit) => {
    const name = STANDARD[e.font][(e.bold ? 1 : 0) + (e.italic ? 2 : 0)];
    if (!fonts.has(name)) fonts.set(name, await doc.embedFont(name));
    return fonts.get(name)!;
  };
  const image = async (src: string) => {
    if (!images.has(src)) {
      const data = await (await fetch(src)).arrayBuffer();
      const isPng = src.startsWith("data:image/png");
      images.set(src, isPng ? await doc.embedPng(data) : await doc.embedJpg(data));
    }
    return images.get(src)!;
  };

  const byPage = new Map<number, Edit[]>();
  for (const e of edits) byPage.set(e.page, [...(byPage.get(e.page) ?? []), e]);

  for (const [index, pageEdits] of byPage) {
    const info = pages[index];
    if (!info) continue;
    const page = doc.getPage(index);
    const H = info.height;
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...displayToPdfMatrix(info)));

    // Whiteouts first so replacement text and drawings sit on top of them.
    const ordered = [...pageEdits].sort((a, b) => rank(a) - rank(b));
    for (const e of ordered) {
      switch (e.kind) {
        case "rect": {
          const [r, g, b] = hexToRgb01(e.color);
          page.drawRectangle({
            x: e.x,
            y: H - e.y - e.h,
            width: e.w,
            height: e.h,
            color: rgb(r, g, b),
            opacity: e.opacity,
            borderWidth: 0,
            blendMode: e.mode === "highlight" ? BlendMode.Multiply : undefined,
          });
          break;
        }
        case "text": {
          const f = await font(e);
          const [r, g, b] = hexToRgb01(e.color);
          const firstBaseline = e.y + baselineRatio(e.font, e.bold, e.italic) * e.size;
          e.text.split("\n").forEach((line, i) => {
            const safe = encodable(f, line);
            if (!safe) return;
            page.drawText(safe, {
              x: e.x,
              y: H - (firstBaseline + i * e.size * LINE_HEIGHT),
              size: e.size,
              font: f,
              color: rgb(r, g, b),
            });
          });
          break;
        }
        case "ink":
          drawInk(page, e.points, e.color, e.width, H);
          break;
        case "image": {
          const img = await image(e.src);
          page.drawImage(img, { x: e.x, y: H - e.y - e.h, width: e.w, height: e.h });
          break;
        }
      }
    }
    page.pushOperators(popGraphicsState());
  }
}

function rank(e: Edit) {
  return e.kind === "rect" && e.mode === "whiteout" ? 0 : 1;
}

function drawInk(page: PDFPage, points: [number, number][], color: string, width: number, H: number) {
  if (points.length === 0) return;
  const [r, g, b] = hexToRgb01(color);
  const pts = points.length === 1 ? [points[0], [points[0][0] + 0.01, points[0][1]] as [number, number]] : points;
  page.pushOperators(
    pushGraphicsState(),
    setStrokingRgbColor(r, g, b),
    setLineWidth(width),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
    moveTo(pts[0][0], H - pts[0][1]),
    ...pts.slice(1).map(([x, y]) => lineTo(x, H - y)),
    stroke(),
    popGraphicsState(),
  );
}

/** Standard PDF fonts only cover Latin (WinAnsi) characters; replace the rest. */
function encodable(font: PDFFont, text: string): string {
  const supported = new Set(font.getCharacterSet());
  return [...text.replace(/\t/g, "    ")]
    .map((ch) => (supported.has(ch.codePointAt(0)!) ? ch : "?"))
    .join("");
}

export function unsupportedChars(text: string): boolean {
  // WinAnsi covers Latin-1 plus a few typographic characters.
  return /[^\u0000-ÿ–—‘’‚“”„†‡•…‰‹›€™ŒœŠšŸŽžƒˆ˜]/.test(text);
}
