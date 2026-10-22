// PDF → Word (.docx), done entirely on the user's machine.
//
// "editable" mode rebuilds the text as real Word paragraphs: text runs are
// grouped into lines, lines into paragraphs (reflowed so they can be edited),
// and embedded pictures are cropped from a rendering of the page and placed
// in reading order. Pages with no extractable text (scans) fall back to an
// image of the page. Tables and multi-column layouts come out as plain text.
//
// "layout" mode places a high-resolution image of each page, which looks
// identical to the PDF but is not editable.

import {
  AlignmentType,
  Document,
  HorizontalPositionRelativeFrom,
  ImageRun,
  Packer,
  PageOrientation,
  Paragraph,
  TextRun,
  TextWrappingType,
  VerticalPositionRelativeFrom,
  type ISectionOptions,
} from "docx";
import { guessFont } from "../fonts";
import { fontInfo, loadPdf, pdfjs, type PDFPageProxy } from "../pdf/engine";
import { canvasToPng } from "./png";

export type DocxMode = "editable" | "layout";

const TWIP = 20; // twips per point
const PX = 96 / 72; // docx image sizes are in 96-dpi pixels

const WORD_FONT = { Helvetica: "Arial", Times: "Times New Roman", Courier: "Courier New" } as const;

interface Run {
  text: string;
  x: number;
  right: number;
  baseline: number;
  size: number;
  font: keyof typeof WORD_FONT;
  bold: boolean;
  italic: boolean;
}

interface Line {
  runs: Run[];
  baseline: number;
  size: number;
  x: number;
  right: number;
}

interface Block {
  top: number;
  paragraph: Paragraph;
}

export async function pdfToDocx(
  bytes: Uint8Array,
  mode: DocxMode,
  onProgress: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const pdf = await loadPdf(bytes);
  const sections: ISectionOptions[] = [];
  try {
    for (let i = 0; i < pdf.numPages; i++) {
      onProgress(i, pdf.numPages);
      const page = await pdf.getPage(i + 1);
      sections.push(mode === "layout" ? await layoutSection(page) : await editableSection(page));
      page.cleanup();
    }
    onProgress(pdf.numPages, pdf.numPages);
  } finally {
    await pdf.loadingTask.destroy();
  }
  const doc = new Document({
    creator: "PDF Editor",
    styles: { default: { document: { run: { font: "Arial" } } } },
    sections,
  });
  return new Uint8Array(await (await Packer.toBlob(doc)).arrayBuffer());
}

function pageProperties(width: number, height: number, margins: { top: number; right: number; bottom: number; left: number }) {
  const landscape = width > height;
  return {
    page: {
      size: {
        width: Math.round(Math.min(width, height) * TWIP),
        height: Math.round(Math.max(width, height) * TWIP),
        orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
      },
      margin: {
        top: Math.round(margins.top * TWIP),
        right: Math.round(margins.right * TWIP),
        bottom: Math.round(margins.bottom * TWIP),
        left: Math.round(margins.left * TWIP),
      },
    },
  };
}

async function renderCanvas(page: PDFPageProxy, dpi: number) {
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport, background: "#ffffff" }).promise;
  return canvas;
}

async function layoutSection(page: PDFPageProxy): Promise<ISectionOptions> {
  const vp = page.getViewport({ scale: 1 });
  const canvas = await renderCanvas(page, 150);
  const png = await canvasToPng(canvas);
  canvas.width = canvas.height = 0;
  return {
    properties: pageProperties(vp.width, vp.height, { top: 0, right: 0, bottom: 0, left: 0 }),
    children: [
      new Paragraph({
        children: [
          new ImageRun({
            type: "png",
            data: png,
            transformation: { width: vp.width * PX, height: vp.height * PX },
            floating: {
              horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 0 },
              verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: 0 },
              wrap: { type: TextWrappingType.NONE },
              behindDocument: true,
            },
          }),
        ],
      }),
    ],
  };
}

async function editableSection(page: PDFPageProxy): Promise<ISectionOptions> {
  const vp = page.getViewport({ scale: 1 });
  // The operator list loads the page's fonts (for bold/italic detection) and
  // tells us where pictures are drawn.
  const ops = await page.getOperatorList();
  const runs = await collectRuns(page, vp.transform);
  const textChars = runs.reduce((n, r) => n + r.text.trim().length, 0);

  if (textChars < 3) {
    // Scanned page or pure graphics: keep it as a picture so nothing is lost.
    return layoutSection(page);
  }

  const lines = groupLines(runs);
  const left = Math.min(...lines.map((l) => l.x));
  const right = Math.max(...lines.map((l) => l.right));
  const top = Math.max(0, Math.min(...lines.map((l) => l.baseline - l.size)));
  const margins = {
    left: clamp(left, 18, 108),
    right: clamp(vp.width - right, 18, 108),
    top: clamp(top, 18, 108),
    bottom: 36,
  };

  const blocks: Block[] = buildParagraphs(lines, left, right, vp.width);
  blocks.push(...(await pictureBlocks(page, ops, vp, margins)));
  blocks.sort((a, b) => a.top - b.top);

  return {
    properties: pageProperties(vp.width, vp.height, margins),
    children: blocks.map((b) => b.paragraph),
  };
}

async function collectRuns(page: PDFPageProxy, transform: number[]): Promise<Run[]> {
  const content = await page.getTextContent();
  const runs: Run[] = [];
  for (const item of content.items) {
    if (!("str" in item) || item.str.length === 0) continue;
    const tx = pdfjs.Util.transform(transform, item.transform);
    if (Math.abs(tx[1]) > 0.01 || Math.abs(tx[2]) > 0.01) continue; // rotated text
    const size = Math.abs(tx[3]) || Math.hypot(tx[2], tx[3]);
    if (size < 1) continue;
    const font = fontInfo(page, item.fontName);
    const style = guessFont(font.name, content.styles[item.fontName]?.fontFamily, font);
    runs.push({
      text: item.str,
      x: tx[4],
      right: tx[4] + item.width,
      baseline: tx[5],
      size,
      ...style,
    });
  }
  return runs;
}

function groupLines(runs: Run[]): Line[] {
  const sorted = [...runs].sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const lines: Line[] = [];
  for (const run of sorted) {
    const line = lines.find((l) => Math.abs(l.baseline - run.baseline) < Math.min(l.size, run.size) * 0.5);
    if (line) {
      line.runs.push(run);
      line.size = Math.max(line.size, run.size);
    } else {
      lines.push({ runs: [run], baseline: run.baseline, size: run.size, x: 0, right: 0 });
    }
  }
  for (const line of lines) {
    line.runs.sort((a, b) => a.x - b.x);
    line.x = line.runs[0].x;
    line.right = Math.max(...line.runs.map((r) => r.right));
  }
  return lines.sort((a, b) => a.baseline - b.baseline);
}

/** Joins the runs of a line, inserting spaces where the PDF only left a gap. */
function lineRuns(line: Line): Run[] {
  const out: Run[] = [];
  let prev: Run | null = null;
  for (const run of line.runs) {
    let text = run.text;
    if (prev) {
      const gap = run.x - prev.right;
      const needsSpace = !/\s$/.test(prev.text) && !/^\s/.test(text);
      if (gap > run.size * 2.5) text = "    " + text.trimStart();
      else if (gap > run.size * 0.15 && needsSpace) text = " " + text;
    }
    const last = out[out.length - 1];
    if (last && last.bold === run.bold && last.italic === run.italic && last.font === run.font && Math.abs(last.size - run.size) < 0.6) {
      last.text += text;
      last.right = run.right;
    } else {
      out.push({ ...run, text });
    }
    prev = run;
  }
  return out;
}

function buildParagraphs(lines: Line[], left: number, right: number, pageWidth: number): Block[] {
  const blocks: Block[] = [];
  const width = right - left;
  let current: { lines: Line[]; top: number } | null = null;

  const flush = () => {
    if (!current) return;
    const first = current.lines[0];
    const runs: Run[] = [];
    current.lines.forEach((line, i) => {
      const parts = lineRuns(line);
      if (i > 0 && parts.length) {
        const prev = runs[runs.length - 1];
        if (prev && /[A-Za-z]-$/.test(prev.text) && /^[a-z]/.test(parts[0].text)) {
          prev.text = prev.text.slice(0, -1); // re-join a hyphenated word
        } else if (prev && !/\s$/.test(prev.text)) {
          parts[0] = { ...parts[0], text: " " + parts[0].text.trimStart() };
        }
      }
      runs.push(...parts);
    });

    const center = (first.x + Math.max(...current.lines.map((l) => l.right))) / 2;
    const centered = Math.abs(center - pageWidth / 2) < pageWidth * 0.04 && first.x - left > width * 0.12;
    const indent = centered ? 0 : Math.max(0, first.x - left);
    const prevBlock = blocks[blocks.length - 1];
    const spaceBefore = prevBlock ? Math.max(0, current.top - prevBlock.top) : 0;

    blocks.push({
      top: current.top,
      paragraph: new Paragraph({
        alignment: centered ? AlignmentType.CENTER : AlignmentType.LEFT,
        indent: indent > 4 ? { left: Math.round(indent * TWIP) } : undefined,
        spacing: { before: Math.round(Math.min(spaceBefore * 0.15, 18) * TWIP), after: 0, line: 276 },
        children: runs.map(
          (r) =>
            new TextRun({
              text: r.text,
              bold: r.bold,
              italics: r.italic,
              size: Math.round(r.size * 2), // half-points
              font: WORD_FONT[r.font],
            }),
        ),
      }),
    });
    current = null;
  };

  let prev: Line | null = null;
  for (const line of lines) {
    const top = line.baseline - line.size;
    if (prev && current) {
      const gap = line.baseline - prev.baseline;
      const sizeChange = Math.abs(line.size - prev.size) > prev.size * 0.15;
      const bigGap = gap > prev.size * 1.6;
      const prevShort = prev.right < left + width * 0.75;
      const indented = line.x - left > prev.size * 1.5 && Math.abs(line.x - prev.x) > prev.size;
      const bullet = /^\s*([•\-–*]|\d+[.)])\s/.test(line.runs[0].text);
      if (sizeChange || bigGap || prevShort || indented || bullet) flush();
    }
    if (!current) current = { lines: [], top };
    current.lines.push(line);
    prev = line;
  }
  flush();
  return blocks;
}

/** Finds pictures in the operator list and crops them from a page rendering. */
async function pictureBlocks(
  page: PDFPageProxy,
  ops: { fnArray: number[]; argsArray: unknown[][] },
  vp: { width: number; height: number; transform: number[] },
  margins: { left: number; right: number },
): Promise<Block[]> {
  const { OPS } = pdfjs;
  const boxes: { x: number; y: number; w: number; h: number }[] = [];
  const stack: number[][] = [];
  let ctm = [1, 0, 0, 1, 0, 0];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = pdfjs.Util.transform(ctm, args as number[]);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const matrix = args?.[0] as number[] | null;
      if (Array.isArray(matrix) && matrix.length === 6) ctm = pdfjs.Util.transform(ctm, matrix);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
      const m = pdfjs.Util.transform(vp.transform, ctm);
      const xs = [m[4], m[4] + m[0], m[4] + m[2], m[4] + m[0] + m[2]];
      const ys = [m[5], m[5] + m[1], m[5] + m[3], m[5] + m[1] + m[3]];
      const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      const area = box.w * box.h;
      // Ignore specks and full-page backgrounds (which sit behind the text).
      if (box.w > 24 && box.h > 24 && area < vp.width * vp.height * 0.7) boxes.push(box);
    }
  }
  if (boxes.length === 0) return [];

  const dpi = 150;
  const scale = dpi / 72;
  const canvas = await renderCanvas(page, dpi);
  const maxWidth = vp.width - margins.left - margins.right;
  const blocks: Block[] = [];
  for (const box of dedupe(boxes)) {
    const crop = document.createElement("canvas");
    crop.width = Math.max(1, Math.round(box.w * scale));
    crop.height = Math.max(1, Math.round(box.h * scale));
    crop.getContext("2d")!.drawImage(canvas, box.x * scale, box.y * scale, box.w * scale, box.h * scale, 0, 0, crop.width, crop.height);
    const fit = Math.min(1, maxWidth / box.w);
    blocks.push({
      top: box.y,
      paragraph: new Paragraph({
        indent: { left: Math.round(Math.max(0, box.x - margins.left) * fit * TWIP) },
        children: [
          new ImageRun({
            type: "png",
            data: await canvasToPng(crop),
            transformation: { width: box.w * fit * PX, height: box.h * fit * PX },
          }),
        ],
      }),
    });
  }
  canvas.width = canvas.height = 0;
  return blocks;
}

function dedupe(boxes: { x: number; y: number; w: number; h: number }[]) {
  return boxes.filter(
    (b, i) =>
      !boxes.some(
        (o, j) => j !== i && o.w * o.h > b.w * b.h && b.x >= o.x - 1 && b.y >= o.y - 1 && b.x + b.w <= o.x + o.w + 1 && b.y + b.h <= o.y + o.h + 1,
      ),
  );
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
