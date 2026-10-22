import { unsupportedChars } from "../pdf/apply";
import { getTextRuns, renderPage, type TextRun } from "../pdf/engine";
import { editBounds, moveEdit, rgbToHex } from "../pdf/geometry";
import { FONT_CSS, LINE_HEIGHT, baselineRatio, guessFont } from "../fonts";
import { newId, state } from "../state";
import type { Bounds, Edit, ImageEdit, InkEdit, RectEdit, TextEdit } from "../types";
import { defaults } from "./defaults";
import { h, toast } from "./dialogs";

const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_CANVAS_PIXELS = 24_000_000;

class PageView {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  layer: HTMLDivElement;
  hits: HTMLDivElement;
  renderedScale = 0;
  wantedScale = 0;
  visible = false;
  runs: TextRun[] | null = null;
  private rendering = false;

  constructor(public index: number, private version: number, private viewer: Viewer) {
    this.canvas = h("canvas", { class: "page-canvas" });
    this.hits = h("div", { class: "hit-layer" });
    this.layer = h("div", { class: "edit-layer" });
    this.el = h("div", { class: "page" }, [this.canvas, this.hits, this.layer]);
    this.el.dataset.index = String(index);
    this.el.setAttribute("aria-label", `Page ${index + 1}`);
  }

  /** Renders (or re-renders at the new zoom) on a fresh canvas, then swaps it in. */
  async ensureRendered() {
    const info = state.pages[this.index];
    let scale = this.viewer.zoom * (window.devicePixelRatio || 1);
    const area = info.width * info.height * scale * scale;
    if (area > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / area);
    this.wantedScale = scale;
    if (this.rendering || Math.abs(this.renderedScale - scale) < 0.01 || !state.pdf) return;

    this.rendering = true;
    try {
      const page = await state.pdf.getPage(this.index + 1);
      const canvas = h("canvas", { class: "page-canvas" });
      await renderPage(page, canvas, scale);
      if (this.version !== this.viewer.version) return; // document changed meanwhile
      this.canvas.replaceWith(canvas);
      this.canvas.width = this.canvas.height = 0;
      this.canvas = canvas;
      this.renderedScale = scale;
      if (state.tool === "edittext") void this.viewer.syncHits(this);
    } catch (err) {
      console.error("Render failed", err);
    } finally {
      this.rendering = false;
    }
    if (Math.abs(this.wantedScale - this.renderedScale) > 0.01 && this.visible) void this.ensureRendered();
  }
}

interface ActiveText {
  el: HTMLElement;
  edit: TextEdit;
}

export class Viewer {
  zoom = 1;
  version = 0;
  views: PageView[] = [];
  private container: HTMLDivElement;
  private observer: IntersectionObserver;
  private editing: ActiveText | null = null;
  private warnedCharset = false;

  constructor(private scroller: HTMLElement) {
    this.container = h("div", { class: "pages" });
    scroller.append(this.container);
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const view = this.views[Number((entry.target as HTMLElement).dataset.index)];
          if (!view) continue;
          view.visible = entry.isIntersecting;
          if (entry.isIntersecting) void view.ensureRendered();
        }
      },
      { root: scroller, rootMargin: "800px 0px" },
    );
    scroller.addEventListener("scroll", () => this.trackCurrentPage(), { passive: true });
    this.container.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.container.addEventListener("dblclick", (e) => this.onDoubleClick(e));

    state.on((change) => {
      if (change === "document") this.rebuild();
      else if (change === "edits" || change === "selection") this.syncAllLayers();
      else if (change === "tool") {
        this.finishTextEditing();
        this.scroller.dataset.tool = state.tool;
        this.syncAllLayers();
        this.views.forEach((v) => void this.syncHits(v));
      }
    });
  }

  // ---------- layout & rendering ----------

  private rebuild() {
    this.editing = null;
    this.version++;
    this.observer.disconnect();
    this.container.replaceChildren();
    this.views = state.pages.map((_, i) => new PageView(i, this.version, this));
    this.container.append(...this.views.map((v) => v.el));
    this.layout();
    this.views.forEach((v) => this.observer.observe(v.el));
    this.syncAllLayers();
    requestAnimationFrame(() => this.scrollToPage(state.currentPage, false));
  }

  private layout() {
    for (const v of this.views) {
      const info = state.pages[v.index];
      v.el.style.width = `${info.width * this.zoom}px`;
      v.el.style.height = `${info.height * this.zoom}px`;
    }
  }

  setZoom(zoom: number) {
    const next = Math.min(4, Math.max(0.25, Math.round(zoom * 100) / 100));
    if (next === this.zoom) return;
    const anchor = this.scroller.scrollTop / Math.max(1, this.scroller.scrollHeight);
    this.finishTextEditing();
    this.zoom = next;
    this.layout();
    this.scroller.scrollTop = anchor * this.scroller.scrollHeight;
    this.syncAllLayers();
    for (const v of this.views) {
      if (v.visible) void v.ensureRendered();
      if (state.tool === "edittext") void this.syncHits(v);
    }
    this.scroller.dispatchEvent(new CustomEvent("zoomchange"));
  }

  fitWidth() {
    if (!state.pages.length) return;
    const widest = Math.max(...state.pages.map((p) => p.width));
    this.setZoom((this.scroller.clientWidth - 64) / widest);
  }

  scrollToPage(index: number, smooth = true) {
    const view = this.views[index];
    if (!view) return;
    this.scroller.scrollTo({ top: view.el.offsetTop - 16, behavior: smooth ? "smooth" : "auto" });
  }

  private trackCurrentPage() {
    const line = this.scroller.scrollTop + this.scroller.clientHeight * 0.35;
    let current = 0;
    for (const v of this.views) if (v.el.offsetTop <= line) current = v.index;
    state.setCurrentPage(current);
  }

  // ---------- edit layer ----------

  private syncAllLayers() {
    this.views.forEach((v) => this.syncLayer(v));
  }

  private syncLayer(view: PageView) {
    const existing = new Map<string, HTMLElement>();
    for (const el of [...view.layer.children] as HTMLElement[]) if (el.dataset.id) existing.set(el.dataset.id, el);
    for (const edit of state.edits) {
      if (edit.page !== view.index) continue;
      let el = existing.get(edit.id);
      if (el) existing.delete(edit.id);
      else {
        el = this.createEditEl(edit);
        view.layer.append(el);
      }
      this.updateEditEl(el, edit);
    }
    existing.forEach((el) => {
      if (this.editing?.el === el) this.editing = null;
      el.remove();
    });
  }

  private createEditEl(edit: Edit): HTMLElement {
    const el = h("div", { class: `edit edit-${edit.kind}${edit.kind === "rect" ? ` ${edit.mode}` : ""}` });
    el.dataset.id = edit.id;
    if (edit.kind === "image") el.append(h("img", { src: edit.src, alt: "", draggable: false }));
    if (edit.kind === "ink") {
      const svg = document.createElementNS(SVG_NS, "svg");
      for (const cls of ["ink-hit", "ink-line"]) {
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("class", cls);
        svg.append(path);
      }
      el.append(svg);
    }
    if (edit.kind !== "ink") el.append(h("span", { class: "handle", title: "Drag to resize" }));
    if (edit.kind === "text") el.spellcheck = false;
    return el;
  }

  private updateEditEl(el: HTMLElement, edit: Edit) {
    const z = this.zoom;
    el.classList.toggle("selected", state.selectedId === edit.id);
    switch (edit.kind) {
      case "text": {
        Object.assign(el.style, {
          left: `${edit.x * z}px`,
          top: `${edit.y * z}px`,
          fontFamily: FONT_CSS[edit.font],
          fontSize: `${edit.size * z}px`,
          lineHeight: String(LINE_HEIGHT),
          fontWeight: edit.bold ? "700" : "400",
          fontStyle: edit.italic ? "italic" : "normal",
          color: edit.color,
        });
        if (this.editing?.el !== el) {
          el.textContent = edit.text;
          el.append(h("span", { class: "handle", title: "Drag to resize" }));
        }
        break;
      }
      case "rect":
        Object.assign(el.style, {
          left: `${edit.x * z}px`,
          top: `${edit.y * z}px`,
          width: `${edit.w * z}px`,
          height: `${edit.h * z}px`,
          background: edit.color,
          opacity: String(edit.opacity),
        });
        break;
      case "image":
        Object.assign(el.style, { left: `${edit.x * z}px`, top: `${edit.y * z}px`, width: `${edit.w * z}px`, height: `${edit.h * z}px` });
        break;
      case "ink": {
        const b = editBounds(edit);
        Object.assign(el.style, { left: `${b.x * z}px`, top: `${b.y * z}px`, width: `${b.w * z}px`, height: `${b.h * z}px` });
        const svg = el.querySelector("svg")!;
        svg.setAttribute("viewBox", `${b.x} ${b.y} ${b.w} ${b.h}`);
        const d = inkPath(edit.points);
        for (const path of svg.querySelectorAll("path")) {
          path.setAttribute("d", d);
          const hit = path.classList.contains("ink-hit");
          path.setAttribute("stroke", hit ? "transparent" : edit.color);
          path.setAttribute("stroke-width", String(hit ? Math.max(edit.width, 10 / z) : edit.width));
        }
        break;
      }
    }
  }

  private elFor(id: string) {
    return this.container.querySelector<HTMLElement>(`.edit[data-id="${id}"]`);
  }

  // ---------- pointer interaction ----------

  private viewFor(target: EventTarget | null) {
    const pageEl = (target as HTMLElement | null)?.closest?.(".page") as HTMLElement | null;
    return pageEl ? this.views[Number(pageEl.dataset.index)] : null;
  }

  private toPage(e: PointerEvent | MouseEvent, view: PageView) {
    const r = view.el.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.zoom, y: (e.clientY - r.top) / this.zoom };
  }

  private onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const view = this.viewFor(e.target);
    if (!view) return;
    const target = e.target as HTMLElement;
    const editEl = target.closest<HTMLElement>(".edit");
    const edit = editEl ? state.getEdit(editEl.dataset.id ?? null) : null;

    if (editEl && editEl.isContentEditable) return; // let the caret/selection work while typing

    if (edit && editEl && (state.tool === "select" || state.tool === "text" || state.tool === "edittext")) {
      e.preventDefault();
      this.finishTextEditing();
      if (state.tool === "text" && edit.kind === "text") {
        this.beginTextEditing(editEl, edit, false);
        return;
      }
      state.select(edit.id);
      if (target.classList.contains("handle")) this.startResize(e, edit);
      else this.startDrag(e, edit);
      return;
    }

    this.finishTextEditing();
    const pt = this.toPage(e, view);
    switch (state.tool) {
      case "select":
        state.select(null);
        break;
      case "text":
        e.preventDefault();
        this.createText(view, pt);
        break;
      case "whiteout":
      case "highlight":
        e.preventDefault();
        this.rubberBand(e, view, pt, state.tool);
        break;
      case "draw":
        e.preventDefault();
        this.drawInk(e, view, pt);
        break;
      case "edittext": {
        const hit = target.closest<HTMLElement>(".hit");
        if (hit && view.runs) {
          e.preventDefault();
          this.replaceRun(view, view.runs[Number(hit.dataset.run)]);
        }
        break;
      }
    }
  }

  private onDoubleClick(e: MouseEvent) {
    const editEl = (e.target as HTMLElement).closest<HTMLElement>(".edit-text");
    const edit = editEl ? state.getEdit(editEl.dataset.id ?? null) : null;
    if (editEl && edit?.kind === "text" && !editEl.isContentEditable) this.beginTextEditing(editEl, edit, true);
  }

  /** Tracks a pointer drag in page units until release. */
  private track(e: PointerEvent, onMove: (dx: number, dy: number, ev: PointerEvent) => void, onEnd: (moved: boolean) => void) {
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / this.zoom;
      const dy = (ev.clientY - sy) / this.zoom;
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
      moved = true;
      onMove(dx, dy, ev);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      onEnd(moved);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  private startDrag(e: PointerEvent, edit: Edit) {
    let last = { x: 0, y: 0 };
    let started = false;
    this.track(
      e,
      (dx, dy) => {
        if (!started) {
          state.checkpoint();
          started = true;
        }
        moveEdit(edit, dx - last.x, dy - last.y);
        last = { x: dx, y: dy };
        const el = this.elFor(edit.id);
        if (el) this.updateEditEl(el, edit);
      },
      (moved) => moved && state.editsChanged(),
    );
  }

  private startResize(e: PointerEvent, edit: Edit) {
    const el = this.elFor(edit.id);
    if (!el) return;
    const start =
      edit.kind === "text"
        ? { w: el.offsetWidth / this.zoom, h: el.offsetHeight / this.zoom, size: edit.size }
        : edit.kind === "ink"
          ? null
          : { w: edit.w, h: edit.h, size: 0 };
    if (!start) return;
    let started = false;
    this.track(
      e,
      (dx, dy) => {
        if (!started) {
          state.checkpoint();
          started = true;
        }
        if (edit.kind === "text") {
          edit.size = Math.max(4, Math.round(start.size * ((start.h + dy) / start.h) * 2) / 2);
        } else if (edit.kind === "image") {
          // Images keep their aspect ratio.
          const ratio = start.h / start.w;
          edit.w = Math.max(8, start.w + dx);
          edit.h = edit.w * ratio;
        } else if (edit.kind === "rect") {
          edit.w = Math.max(2, start.w + dx);
          edit.h = Math.max(2, start.h + dy);
        }
        this.updateEditEl(el, edit);
      },
      (moved) => moved && state.editsChanged(),
    );
  }

  private rubberBand(e: PointerEvent, view: PageView, origin: { x: number; y: number }, mode: "whiteout" | "highlight") {
    const preview = h("div", { class: `edit edit-rect ${mode} preview` });
    view.layer.append(preview);
    let rect: Bounds = { x: origin.x, y: origin.y, w: 0, h: 0 };
    const z = this.zoom;
    this.track(
      e,
      (dx, dy) => {
        rect = { x: Math.min(origin.x, origin.x + dx), y: Math.min(origin.y, origin.y + dy), w: Math.abs(dx), h: Math.abs(dy) };
        Object.assign(preview.style, {
          left: `${rect.x * z}px`,
          top: `${rect.y * z}px`,
          width: `${rect.w * z}px`,
          height: `${rect.h * z}px`,
          background: mode === "highlight" ? defaults.highlight.color : "#ffffff",
          opacity: mode === "highlight" ? String(defaults.highlight.opacity) : "1",
        });
      },
      () => {
        preview.remove();
        if (rect.w < 2 || rect.h < 2) return;
        const edit: RectEdit =
          mode === "highlight"
            ? { id: newId(), page: view.index, kind: "rect", mode, ...rect, ...defaults.highlight }
            : { id: newId(), page: view.index, kind: "rect", mode, ...rect, color: this.sampleBackground(view, rect), opacity: 1 };
        state.addEdit(edit);
      },
    );
  }

  private drawInk(e: PointerEvent, view: PageView, origin: { x: number; y: number }) {
    const points: [number, number][] = [[origin.x, origin.y]];
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "ink-preview");
    const info = state.pages[view.index];
    svg.setAttribute("viewBox", `0 0 ${info.width} ${info.height}`);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("stroke", defaults.draw.color);
    path.setAttribute("stroke-width", String(defaults.draw.width));
    svg.append(path);
    view.layer.append(svg);
    this.track(
      e,
      (dx, dy) => {
        const p: [number, number] = [origin.x + dx, origin.y + dy];
        const last = points[points.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.6) return;
        points.push(p);
        path.setAttribute("d", inkPath(points));
      },
      () => {
        svg.remove();
        const ink: InkEdit = { id: newId(), page: view.index, kind: "ink", points, ...defaults.draw };
        state.addEdit(ink, false);
      },
    );
  }

  // ---------- text editing ----------

  private createText(view: PageView, pt: { x: number; y: number }) {
    const d = defaults.text;
    const edit: TextEdit = { id: newId(), page: view.index, kind: "text", x: pt.x, y: pt.y - d.size * 0.6, text: "", ...d };
    state.addEdit(edit);
    const el = this.elFor(edit.id);
    if (el) this.beginTextEditing(el, edit, false, false);
  }

  private beginTextEditing(el: HTMLElement, edit: TextEdit, selectAll: boolean, checkpoint = true) {
    if (this.editing?.el === el) return;
    this.finishTextEditing();
    if (checkpoint) state.checkpoint();
    state.select(edit.id);
    this.editing = { el, edit };
    el.querySelector(".handle")?.remove();
    el.contentEditable = "plaintext-only";
    el.classList.add("editing");
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    if (!selectAll) range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const onInput = () => {
      edit.text = el.innerText.replace(/\n$/, "");
      state.dirty = true;
      const bad = unsupportedChars(edit.text);
      el.classList.toggle("charset-warning", bad);
      if (bad && !this.warnedCharset) {
        this.warnedCharset = true;
        toast("Some characters (e.g. non-Latin scripts or emoji) can't be saved with the built-in fonts and will show as “?”.", "error", 6000);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        el.blur();
      }
    };
    const onBlur = () => {
      el.removeEventListener("input", onInput);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("blur", onBlur);
      this.endTextEditing(el, edit);
    };
    el.addEventListener("input", onInput);
    el.addEventListener("keydown", onKey);
    el.addEventListener("blur", onBlur);
  }

  private endTextEditing(el: HTMLElement, edit: TextEdit) {
    if (this.editing?.el !== el) return;
    this.editing = null;
    el.contentEditable = "false";
    el.classList.remove("editing");
    if (!edit.text.trim()) {
      state.edits = state.edits.filter((e) => e.id !== edit.id);
      if (state.selectedId === edit.id) state.selectedId = null;
    }
    state.editsChanged();
  }

  finishTextEditing() {
    this.editing?.el.blur();
  }

  get isEditingText() {
    return this.editing !== null;
  }

  /** "Edit text": hide the original words behind a matched-colour patch and put an editable copy on top. */
  private replaceRun(view: PageView, run: TextRun) {
    const style = guessFont(run.realName, run.fontFamily, run);
    const pad = Math.max(0.6, run.size * 0.06);
    const box: Bounds = { x: run.x - pad, y: run.y - pad, w: run.w + pad * 2, h: run.h + pad * 2 };
    const bg = this.sampleBackground(view, box);
    const size = Math.round(run.size * 10) / 10;
    const cover: RectEdit = { id: newId(), page: view.index, kind: "rect", mode: "whiteout", ...box, color: bg, opacity: 1 };
    const text: TextEdit = {
      id: newId(),
      page: view.index,
      kind: "text",
      x: run.x,
      y: run.baseline - baselineRatio(style.font, style.bold, style.italic) * size,
      text: run.str,
      size,
      ...style,
      color: this.sampleTextColor(view, box, bg),
    };
    state.checkpoint();
    state.edits.push(cover, text);
    state.selectedId = text.id;
    state.editsChanged();
    const el = this.elFor(text.id);
    if (el) this.beginTextEditing(el, text, true, false);
  }

  async syncHits(view: PageView) {
    if (state.tool !== "edittext") {
      view.hits.replaceChildren();
      return;
    }
    if (!view.runs && state.pdf) {
      const version = this.version;
      const runs = await getTextRuns(await state.pdf.getPage(view.index + 1));
      if (version !== this.version) return;
      view.runs = runs;
    }
    if (state.tool !== "edittext" || !view.runs) return;
    const z = this.zoom;
    view.hits.replaceChildren(
      ...view.runs.map((run, i) => {
        const el = h("div", { class: "hit", title: "Click to edit this text" });
        el.dataset.run = String(i);
        Object.assign(el.style, { left: `${run.x * z}px`, top: `${run.y * z}px`, width: `${run.w * z}px`, height: `${run.h * z}px` });
        return el;
      }),
    );
  }

  // ---------- images & signatures ----------

  async placeImage(src: string, maxWidth = 240) {
    const view = this.views[state.currentPage];
    if (!view) return;
    const img = new Image();
    img.src = src;
    await img.decode();
    const info = state.pages[view.index];
    const naturalW = img.naturalWidth * 0.75; // px → pt
    const w = Math.min(naturalW, maxWidth, info.width * 0.8);
    const hgt = (w * img.naturalHeight) / img.naturalWidth;
    const visibleTop = Math.max(0, (this.scroller.scrollTop - view.el.offsetTop) / this.zoom);
    const visibleMid = visibleTop + Math.min(info.height - visibleTop, this.scroller.clientHeight / this.zoom) / 2;
    const edit: ImageEdit = {
      id: newId(),
      page: view.index,
      kind: "image",
      x: (info.width - w) / 2,
      y: Math.min(info.height - hgt, Math.max(0, visibleMid - hgt / 2)),
      w,
      h: hgt,
      src,
    };
    if (state.tool !== "select") state.setTool("select");
    state.addEdit(edit);
  }

  // ---------- colour sampling from the rendered page ----------

  private pixels(view: PageView, box: Bounds) {
    const s = view.renderedScale;
    if (!s) return null;
    const ctx = view.canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const x = Math.max(0, Math.floor(box.x * s));
    const y = Math.max(0, Math.floor(box.y * s));
    const w = Math.min(view.canvas.width - x, Math.ceil(box.w * s));
    const hgt = Math.min(view.canvas.height - y, Math.ceil(box.h * s));
    if (w <= 0 || hgt <= 0) return null;
    return { data: ctx.getImageData(x, y, w, hgt).data, w, h: hgt };
  }

  private sampleBackground(view: PageView, box: Bounds): string {
    const px = this.pixels(view, box);
    if (!px) return "#ffffff";
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    const take = (x: number, y: number) => {
      const i = (y * px.w + x) * 4;
      rs.push(px.data[i]);
      gs.push(px.data[i + 1]);
      bs.push(px.data[i + 2]);
    };
    for (let x = 0; x < px.w; x++) {
      take(x, 0);
      take(x, px.h - 1);
    }
    for (let y = 0; y < px.h; y++) {
      take(0, y);
      take(px.w - 1, y);
    }
    const median = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
    return rgbToHex(median(rs), median(gs), median(bs));
  }

  private sampleTextColor(view: PageView, box: Bounds, bgHex: string): string {
    const px = this.pixels(view, box);
    if (!px) return "#000000";
    const bg = parseInt(bgHex.slice(1), 16);
    const br = (bg >> 16) & 255, bgG = (bg >> 8) & 255, bb = bg & 255;
    let best = 0, color = [0, 0, 0];
    for (let i = 0; i < px.data.length; i += 4) {
      const d = Math.abs(px.data[i] - br) + Math.abs(px.data[i + 1] - bgG) + Math.abs(px.data[i + 2] - bb);
      if (d > best) {
        best = d;
        color = [px.data[i], px.data[i + 1], px.data[i + 2]];
      }
    }
    return best < 90 ? "#000000" : rgbToHex(color[0], color[1], color[2]);
  }
}

function inkPath(points: [number, number][]) {
  if (points.length === 1) return `M${points[0][0]} ${points[0][1]} l0.01 0`;
  return points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
}
