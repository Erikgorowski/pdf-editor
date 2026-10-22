import { loadPdf } from "../pdf/engine";
import type { OutputFile } from "../platform";

export interface PngOptions {
  dpi: number;
  pages: number[]; // zero-based page indexes
}

export async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not encode the page image.");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Renders the chosen pages of `bytes` to PNG files named "<base>-page-N.png". */
export async function pdfToPngs(
  bytes: Uint8Array,
  baseName: string,
  options: PngOptions,
  onProgress: (done: number, total: number) => void,
): Promise<OutputFile[]> {
  const pdf = await loadPdf(bytes);
  const files: OutputFile[] = [];
  const pad = String(pdf.numPages).length;
  try {
    for (const [i, index] of options.pages.entries()) {
      onProgress(i, options.pages.length);
      const page = await pdf.getPage(index + 1);
      const viewport = page.getViewport({ scale: options.dpi / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport, background: "#ffffff" }).promise;
      files.push({ name: `${baseName}-page-${String(index + 1).padStart(pad, "0")}.png`, bytes: await canvasToPng(canvas) });
      canvas.width = canvas.height = 0; // release the bitmap memory right away
      page.cleanup();
    }
    onProgress(options.pages.length, options.pages.length);
    return files;
  } finally {
    await pdf.loadingTask.destroy();
  }
}
