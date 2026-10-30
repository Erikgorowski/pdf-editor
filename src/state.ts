import { applyEdits, drawEdits, openForWrite } from "./pdf/apply";
import { loadPdf, readPageInfos, type PDFDocumentProxy } from "./pdf/engine";
import { applyPageOp, type PageOp } from "./pdf/pages";
import type { Edit, PageInfo, Tool } from "./types";

interface Snapshot {
  bytes: Uint8Array;
  edits: Edit[];
}

type Listener = (change: "document" | "edits" | "selection" | "tool" | "meta") => void;

const clone = <T,>(v: T): T => structuredClone(v);

/**
 * Single source of truth for the open document.
 * `bytes` is the PDF as last committed; `edits` are live overlay edits that
 * stay movable until a page operation flattens them into `bytes`.
 */
export class DocState {
  bytes: Uint8Array | null = null;
  pdf: PDFDocumentProxy | null = null;
  pages: PageInfo[] = [];
  edits: Edit[] = [];
  fileName = "";
  filePath: string | null = null;
  /** Edge/Chrome web version: lets Save write back to the opened file. */
  fileHandle: FileSystemFileHandle | null = null;
  dirty = false;
  tool: Tool = "select";
  selectedId: string | null = null;
  currentPage = 0;

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private listeners = new Set<Listener>();

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(change: Parameters<Listener>[0]) {
    this.listeners.forEach((fn) => fn(change));
  }

  get hasDocument() {
    return this.pdf !== null;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  async open(bytes: Uint8Array, fileName: string, filePath: string | null, fileHandle: FileSystemFileHandle | null = null) {
    const pdf = await loadPdf(bytes);
    void this.pdf?.loadingTask.destroy();
    this.pdf = pdf;
    this.bytes = bytes;
    this.pages = await readPageInfos(pdf);
    this.edits = [];
    this.fileName = fileName;
    this.filePath = filePath;
    this.fileHandle = fileHandle;
    this.dirty = false;
    this.selectedId = null;
    this.currentPage = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.emit("document");
  }

  /** Records the current state so the next change can be undone. */
  checkpoint() {
    if (!this.bytes) return;
    this.undoStack.push({ bytes: this.bytes, edits: clone(this.edits) });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  addEdit(edit: Edit, select = true) {
    this.checkpoint();
    this.edits.push(edit);
    if (select) this.selectedId = edit.id;
    this.touch("edits");
  }

  /** Call after mutating an edit in place (the caller is responsible for checkpoint()). */
  editsChanged() {
    this.touch("edits");
  }

  /** Drops edits that turned out to change nothing, together with the undo step that created them. */
  discardEdits(ids: string[], wasDirty: boolean) {
    this.edits = this.edits.filter((e) => !ids.includes(e.id));
    if (this.selectedId && ids.includes(this.selectedId)) this.selectedId = null;
    this.undoStack.pop();
    this.dirty = wasDirty;
    this.emit("edits");
  }

  removeEdit(id: string) {
    const idx = this.edits.findIndex((e) => e.id === id);
    if (idx < 0) return;
    this.checkpoint();
    this.edits.splice(idx, 1);
    if (this.selectedId === id) this.selectedId = null;
    this.touch("edits");
  }

  getEdit(id: string | null) {
    return id ? this.edits.find((e) => e.id === id) ?? null : null;
  }

  select(id: string | null) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emit("selection");
  }

  setTool(tool: Tool) {
    this.tool = tool;
    this.selectedId = null;
    this.emit("tool");
  }

  setCurrentPage(index: number) {
    if (index === this.currentPage) return;
    this.currentPage = index;
    this.emit("meta");
  }

  async undo() {
    const snap = this.undoStack.pop();
    if (!snap || !this.bytes) return;
    this.redoStack.push({ bytes: this.bytes, edits: clone(this.edits) });
    await this.restore(snap);
  }

  async redo() {
    const snap = this.redoStack.pop();
    if (!snap || !this.bytes) return;
    this.undoStack.push({ bytes: this.bytes, edits: clone(this.edits) });
    await this.restore(snap);
  }

  private async restore(snap: Snapshot) {
    const bytesChanged = snap.bytes !== this.bytes;
    this.edits = snap.edits;
    this.selectedId = null;
    this.dirty = true;
    if (bytesChanged) {
      await this.reload(snap.bytes);
    } else {
      this.emit("edits");
    }
  }

  private async reload(bytes: Uint8Array) {
    const pdf = await loadPdf(bytes);
    void this.pdf?.loadingTask.destroy();
    this.pdf = pdf;
    this.bytes = bytes;
    this.pages = await readPageInfos(pdf);
    this.currentPage = Math.min(this.currentPage, this.pages.length - 1);
    this.emit("document");
  }

  /** Flattens live edits into the PDF, then applies a structural page operation. */
  async pageOp(op: PageOp) {
    if (!this.bytes) return;
    this.checkpoint();
    const doc = await openForWrite(this.bytes);
    if (this.edits.length) await drawEdits(doc, this.edits, this.pages);
    const select = await applyPageOp(doc, op);
    this.edits = [];
    this.selectedId = null;
    this.dirty = true;
    this.currentPage = select;
    await this.reload(await doc.save());
  }

  /** The PDF with all edits burned in, ready to be written to disk or converted. */
  async exportBytes(): Promise<Uint8Array> {
    if (!this.bytes) throw new Error("No document is open.");
    return applyEdits(this.bytes, this.edits, this.pages);
  }

  markSaved(fileName: string, filePath: string | null, fileHandle: FileSystemFileHandle | null) {
    this.fileName = fileName;
    this.filePath = filePath;
    this.fileHandle = fileHandle;
    this.dirty = false;
    this.emit("meta");
  }

  private touch(change: "edits") {
    this.dirty = true;
    this.emit(change);
  }
}

export const state = new DocState();

let counter = 0;
export const newId = () => `e${Date.now().toString(36)}${(counter++).toString(36)}`;
