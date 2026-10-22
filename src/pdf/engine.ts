import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PageInfo } from "../types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const assetUrl = (path: string) => new URL(`pdfjs/${path}/`, document.baseURI).href;

export class PasswordRequiredError extends Error {}

export async function loadPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  // pdf.js transfers the buffer to its worker, so always hand it a copy.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    password,
    cMapUrl: assetUrl("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: assetUrl("standard_fonts"),
    wasmUrl: assetUrl("wasm"),
    iccUrl: assetUrl("iccs"),
    // Keeps real font names (e.g. "Calibri-Bold") so edits and Word export can match the font.
    fontExtraProperties: true,
  });
  try {
    return await task.promise;
  } catch (err) {
    if (err instanceof Error && err.name === "PasswordException") {
      throw new PasswordRequiredError("This PDF is password protected.");
    }
    throw err;
  }
}

export async function readPageInfos(pdf: PDFDocumentProxy): Promise<PageInfo[]> {
  const infos: PageInfo[] = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    infos.push({ index: i, width: vp.width, height: vp.height, rotate: page.rotate, transform: [...vp.transform] });
  }
  return infos;
}

/** Renders a page into `canvas` at `scale` (CSS zoom × device pixel ratio). */
export async function renderPage(page: PDFPageProxy, canvas: HTMLCanvasElement, scale: number) {
  const viewport = page.getViewport({ scale });
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const task = page.render({ canvas, viewport });
  await task.promise;
  return task;
}

export interface TextRun {
  str: string;
  x: number; // page units, left
  y: number; // page units, top
  w: number;
  h: number;
  baseline: number;
  size: number;
  fontName: string;
  fontFamily: string;
  realName: string;
  bold: boolean;
  italic: boolean;
}

/** Real font name and style of a pdf.js font id (available once the page has been parsed). */
export function fontInfo(page: PDFPageProxy, fontId: string): { name: string; bold: boolean; italic: boolean } {
  try {
    const font = page.commonObjs.has(fontId) ? page.commonObjs.get(fontId) : null;
    return { name: font?.name ?? font?.fallbackName ?? "", bold: Boolean(font?.bold || font?.black), italic: Boolean(font?.italic) };
  } catch {
    return { name: "", bold: false, italic: false };
  }
}

/** Horizontal text runs on a page, positioned in page units (100% zoom, y down). */
export async function getTextRuns(page: PDFPageProxy): Promise<TextRun[]> {
  const vp = page.getViewport({ scale: 1 });
  await page.getOperatorList(); // loads the page's fonts into commonObjs
  const content = await page.getTextContent();
  const runs: TextRun[] = [];
  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const tx = pdfjs.Util.transform(vp.transform, item.transform);
    // Skip rotated or vertical text: only horizontal runs can be edited in place.
    if (Math.abs(tx[1]) > 0.01 || Math.abs(tx[2]) > 0.01 || tx[0] <= 0) continue;
    const size = Math.hypot(tx[2], tx[3]) || Math.abs(tx[3]);
    const style = content.styles[item.fontName];
    const ascent = style?.ascent || 0.8;
    const descent = style?.descent ? Math.abs(style.descent) : 0.2;
    const font = fontInfo(page, item.fontName);
    runs.push({
      str: item.str,
      x: tx[4],
      y: tx[5] - size * ascent,
      w: item.width,
      h: size * (ascent + descent),
      baseline: tx[5],
      size,
      fontName: item.fontName,
      fontFamily: style?.fontFamily ?? "",
      realName: font.name,
      bold: font.bold,
      italic: font.italic,
    });
  }
  return runs;
}

export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy };
