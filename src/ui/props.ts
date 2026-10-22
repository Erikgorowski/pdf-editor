import { FONT_LABEL } from "../fonts";
import { state } from "../state";
import type { Edit, FontKey } from "../types";
import { defaults } from "./defaults";
import { h } from "./dialogs";
import { icon } from "./icons";

const TOOL_HINTS: Record<string, string> = {
  select: "Click an edit to select it, drag to move, double-click text to change it. Press Delete to remove.",
  edittext: "Click any line of text in the PDF to change it.",
  text: "Click anywhere on the page to add text.",
  whiteout: "Drag over content to cover it with the page colour.",
  highlight: "Drag over text to highlight it.",
  draw: "Draw freehand on the page.",
};

/** Context-sensitive formatting controls for the selected edit or active tool. */
export class PropsBar {
  private key = "";

  constructor(private root: HTMLElement) {
    state.on((change) => {
      if (change === "edits") this.refreshValues();
      else this.render();
    });
    this.render();
  }

  private target(): Edit | null {
    return state.getEdit(state.selectedId);
  }

  /** Applies a change to the selected edit (undoable) and remembers it as the new default. */
  private change(fn: (e: Edit) => void, rememberDefault: () => void) {
    rememberDefault();
    const edit = this.target();
    if (!edit) return;
    state.checkpoint();
    fn(edit);
    state.editsChanged();
  }

  private render() {
    const edit = this.target();
    const kind = edit ? (edit.kind === "rect" ? edit.mode : edit.kind) : state.tool;
    const key = `${state.hasDocument}|${edit?.id ?? ""}|${kind}`;
    if (key === this.key) return this.refreshValues();
    this.key = key;
    this.root.replaceChildren();
    if (!state.hasDocument) return;

    const controls: HTMLElement[] = [];
    if (kind === "text") controls.push(...this.textControls());
    else if (kind === "highlight") controls.push(...this.highlightControls());
    else if (kind === "whiteout" && edit) controls.push(this.colorControl("Fill", (e) => (e as { color: string }).color, (v) => ({ color: v }), () => {}));
    else if (kind === "ink" || kind === "draw") controls.push(...this.drawControls());

    if (edit) {
      const del = h("button", { class: "btn subtle danger", type: "button", html: `${icon("trash", 16)}<span>Delete</span>`, title: "Delete (Del)" });
      del.addEventListener("click", () => state.removeEdit(edit.id));
      controls.push(h("div", { class: "sep" }), del);
    }
    const hint = h("span", { class: "hint", textContent: edit ? "" : TOOL_HINTS[state.tool] ?? "" });
    this.root.append(...controls, hint);
  }

  private refreshValues() {
    const edit = this.target();
    for (const input of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-field]")) {
      if (document.activeElement === input) continue;
      const source = (edit ?? this.defaultsFor()) as unknown as Record<string, unknown>;
      const value = source[input.dataset.field!];
      if (value === undefined) continue;
      if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = Boolean(value);
      else input.value = String(value);
    }
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>("[data-toggle]")) {
      const source = (edit ?? this.defaultsFor()) as unknown as Record<string, unknown>;
      btn.setAttribute("aria-pressed", String(Boolean(source[btn.dataset.toggle!])));
    }
  }

  private defaultsFor() {
    if (state.tool === "highlight") return defaults.highlight;
    if (state.tool === "draw") return defaults.draw;
    return defaults.text;
  }

  private textControls(): HTMLElement[] {
    const edit = this.target();
    const cur = edit?.kind === "text" ? edit : defaults.text;

    const font = h("select", { class: "input", title: "Font" });
    font.dataset.field = "font";
    for (const key of Object.keys(FONT_LABEL) as FontKey[]) font.append(h("option", { value: key, textContent: FONT_LABEL[key] }));
    font.value = cur.font;
    font.addEventListener("change", () =>
      this.change((e) => e.kind === "text" && (e.font = font.value as FontKey), () => (defaults.text.font = font.value as FontKey)),
    );

    const size = h("input", { class: "input narrow", type: "number", min: "4", max: "200", step: "0.5", title: "Font size (pt)" });
    size.dataset.field = "size";
    size.value = String(cur.size);
    size.addEventListener("change", () => {
      const v = Math.min(200, Math.max(4, Number(size.value) || 12));
      this.change((e) => e.kind === "text" && (e.size = v), () => (defaults.text.size = v));
    });

    const toggle = (field: "bold" | "italic") => {
      const btn = h("button", { class: "icon-btn toggle", type: "button", html: icon(field, 16), title: field === "bold" ? "Bold" : "Italic" });
      btn.dataset.toggle = field;
      btn.setAttribute("aria-pressed", String(cur[field]));
      btn.addEventListener("click", () => {
        const next = btn.getAttribute("aria-pressed") !== "true";
        btn.setAttribute("aria-pressed", String(next));
        this.change((e) => e.kind === "text" && (e[field] = next), () => (defaults.text[field] = next));
      });
      return btn;
    };

    return [
      h("label", { class: "field" }, [h("span", { textContent: "Font" }), font]),
      h("label", { class: "field" }, [h("span", { textContent: "Size" }), size]),
      toggle("bold"),
      toggle("italic"),
      this.colorControl("Colour", () => cur.color, (v) => ({ color: v }), (v) => (defaults.text.color = v)),
    ];
  }

  private highlightControls(): HTMLElement[] {
    const edit = this.target();
    const cur = edit?.kind === "rect" ? edit : defaults.highlight;
    const opacity = h("input", { class: "range", type: "range", min: "0.15", max: "0.8", step: "0.05", title: "Opacity" });
    opacity.dataset.field = "opacity";
    opacity.value = String(cur.opacity);
    opacity.addEventListener("change", () => {
      const v = Number(opacity.value);
      this.change((e) => e.kind === "rect" && (e.opacity = v), () => (defaults.highlight.opacity = v));
    });
    return [
      this.colorControl("Colour", () => cur.color, (v) => ({ color: v }), (v) => (defaults.highlight.color = v)),
      h("label", { class: "field" }, [h("span", { textContent: "Opacity" }), opacity]),
    ];
  }

  private drawControls(): HTMLElement[] {
    const edit = this.target();
    const cur = edit?.kind === "ink" ? edit : defaults.draw;
    const width = h("input", { class: "input narrow", type: "number", min: "0.5", max: "30", step: "0.5", title: "Line width (pt)" });
    width.dataset.field = "width";
    width.value = String(cur.width);
    width.addEventListener("change", () => {
      const v = Math.min(30, Math.max(0.5, Number(width.value) || 2));
      this.change((e) => e.kind === "ink" && (e.width = v), () => (defaults.draw.width = v));
    });
    return [
      this.colorControl("Colour", () => cur.color, (v) => ({ color: v }), (v) => (defaults.draw.color = v)),
      h("label", { class: "field" }, [h("span", { textContent: "Width" }), width]),
    ];
  }

  private colorControl(label: string, get: (e: Edit) => string, patch: (v: string) => object, remember: (v: string) => void) {
    const edit = this.target();
    const input = h("input", { class: "swatch", type: "color", title: label });
    input.dataset.field = "color";
    input.value = edit ? get(edit) : (this.defaultsFor() as { color: string }).color;
    input.addEventListener("change", () => this.change((e) => Object.assign(e, patch(input.value)), () => remember(input.value)));
    return h("label", { class: "field" }, [h("span", { textContent: label }), input]);
  }
}
