import { PDFDocument, degrees } from "pdf-lib";

export type PageOp =
  | { type: "rotate"; index: number; delta: 90 | -90 }
  | { type: "delete"; index: number }
  | { type: "move"; index: number; to: number }
  | { type: "insertBlank"; after: number }
  | { type: "merge"; bytes: Uint8Array };

/** Applies a structural page operation and returns the page that should be selected afterwards. */
export async function applyPageOp(doc: PDFDocument, op: PageOp): Promise<number> {
  switch (op.type) {
    case "rotate": {
      const page = doc.getPage(op.index);
      page.setRotation(degrees((((page.getRotation().angle + op.delta) % 360) + 360) % 360));
      return op.index;
    }
    case "delete": {
      if (doc.getPageCount() <= 1) throw new Error("A PDF must keep at least one page.");
      doc.removePage(op.index);
      return Math.min(op.index, doc.getPageCount() - 1);
    }
    case "move": {
      const to = Math.max(0, Math.min(doc.getPageCount() - 1, op.to));
      if (to === op.index) return to;
      const [copy] = await doc.copyPages(doc, [op.index]);
      doc.removePage(op.index);
      doc.insertPage(to, copy);
      return to;
    }
    case "insertBlank": {
      const ref = doc.getPage(op.after);
      const { width, height } = ref.getSize();
      const rotated = ref.getRotation().angle % 180 !== 0;
      doc.insertPage(op.after + 1, rotated ? [height, width] : [width, height]);
      return op.after + 1;
    }
    case "merge": {
      const other = await PDFDocument.load(op.bytes, { ignoreEncryption: true });
      const first = doc.getPageCount();
      const copied = await doc.copyPages(other, other.getPageIndices());
      copied.forEach((p) => doc.addPage(p));
      return first;
    }
  }
}
