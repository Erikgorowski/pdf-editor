import "./styles.css";
import { pdfToDocx, type DocxMode } from "./convert/docx";
import { pdfToPngs } from "./convert/png";
import { PasswordRequiredError } from "./pdf/engine";
import {
  canSaveInPlace,
  confirmDiscard,
  guardClose,
  isDesktop,
  isInstalledWebApp,
  launchFile,
  onWebAppLaunch,
  openPdf,
  pickImage,
  readFileObject,
  readHandle,
  saveFile,
  saveMany,
  type OpenedFile,
} from "./platform";
import { state } from "./state";
import type { Tool } from "./types";
import { h, modal, progress, signaturePad, toast } from "./ui/dialogs";
import { icon, type IconName } from "./ui/icons";
import { PropsBar } from "./ui/props";
import { Thumbs } from "./ui/thumbs";
import { Viewer } from "./ui/viewer";

const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

// ---------- shell ----------

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header class="toolbar">
    <div class="brand"><img src="icons/icon.svg" alt="" width="22" height="22" /><span>PDF Editor</span></div>
    <div class="group" data-group="file"></div>
    <div class="group" data-group="history"></div>
    <div class="group tools" role="toolbar" aria-label="Editing tools" data-group="tools"></div>
    <div class="group" data-group="insert"></div>
    <div class="spacer"></div>
    <div class="group" data-group="convert"></div>
  </header>
  <div class="propsbar" id="props"></div>
  <div class="workspace">
    <aside class="sidebar" aria-label="Pages">
      <div class="page-actions" data-group="pages"></div>
      <div class="thumbs" id="thumbs"></div>
    </aside>
    <main class="scroller" id="scroller" data-tool="select">
      <div class="empty" id="empty">
        <div class="empty-card">
          <img class="empty-logo" src="icons/icon.svg" alt="" width="84" height="84" />
          <h1>Open a PDF to get started</h1>
          <p>Edit text, white out, highlight, draw, add images and signatures,<br>reorganise pages, and convert to Word or PNG — all on this computer.</p>
          <button class="btn primary large" id="empty-open" type="button">${icon("open")}<span>Open PDF…</span></button>
          <p class="muted small">or drag a PDF file anywhere into this window</p>
          <div class="get-app" id="get-app" hidden>
            <button class="btn" id="empty-install" type="button" hidden>${icon("download")}<span>Install as an app</span></button>
            <a class="btn" id="empty-download" hidden>${icon("download")}<span>Download for Windows</span></a>
          </div>
        </div>
      </div>
    </main>
  </div>
  <footer class="statusbar">
    <span id="status-file" class="status-file">No document</span>
    <span id="status-page"></span>
    <span class="spacer"></span>
    <span class="muted">${isDesktop ? "Desktop app" : isInstalledWebApp ? "Installed app" : "Web version"}</span>
    <div class="zoom" data-group="zoom"></div>
  </footer>
  <div class="drop-overlay" id="drop-overlay"><div>${icon("open", 36)}<p>Drop PDF to open</p></div></div>
`;

const scroller = document.querySelector<HTMLElement>("#scroller")!;
const viewer = new Viewer(scroller);
new Thumbs(document.querySelector<HTMLElement>("#thumbs")!, viewer);
new PropsBar(document.querySelector<HTMLElement>("#props")!);

interface ButtonSpec {
  id: string;
  icon: IconName;
  label: string;
  shortcut?: string;
  showLabel?: boolean;
  needsDoc?: boolean;
  run: () => unknown;
}

const buttons = new Map<string, HTMLButtonElement>();

function addButtons(group: string, specs: ButtonSpec[]) {
  const host = document.querySelector<HTMLElement>(`[data-group="${group}"]`)!;
  for (const spec of specs) {
    const btn = h("button", {
      type: "button",
      class: spec.showLabel ? "btn subtle" : "icon-btn",
      html: spec.showLabel ? `${icon(spec.icon)}<span>${spec.label}</span>` : icon(spec.icon),
      title: spec.shortcut ? `${spec.label} (${spec.shortcut})` : spec.label,
    });
    btn.setAttribute("aria-label", spec.label);
    btn.dataset.needsDoc = String(spec.needsDoc !== false);
    btn.addEventListener("click", () => void guarded(spec.run));
    buttons.set(spec.id, btn);
    host.append(btn);
  }
}

async function guarded(fn: () => unknown) {
  try {
    await fn();
  } catch (err) {
    console.error(err);
    toast(err instanceof Error ? err.message : String(err), "error", 6000);
  }
}

const toolSpecs: { tool: Tool; icon: IconName; label: string; key: string }[] = [
  { tool: "select", icon: "select", label: "Select & move", key: "V" },
  { tool: "edittext", icon: "editText", label: "Edit existing text", key: "E" },
  { tool: "text", icon: "addText", label: "Add text", key: "T" },
  { tool: "whiteout", icon: "whiteout", label: "Whiteout", key: "W" },
  { tool: "highlight", icon: "highlight", label: "Highlight", key: "H" },
  { tool: "draw", icon: "draw", label: "Draw", key: "D" },
];

addButtons("file", [
  { id: "open", icon: "open", label: "Open", shortcut: `${mod}O`, needsDoc: false, run: openDocument },
  { id: "save", icon: "save", label: "Save", shortcut: `${mod}S`, run: () => saveDocument(false) },
  { id: "saveAs", icon: "saveAs", label: "Save as", shortcut: `${mod}Shift+S`, run: () => saveDocument(true) },
]);
addButtons("history", [
  { id: "undo", icon: "undo", label: "Undo", shortcut: `${mod}Z`, run: () => state.undo() },
  { id: "redo", icon: "redo", label: "Redo", shortcut: `${mod}Y`, run: () => state.redo() },
]);
addButtons(
  "tools",
  toolSpecs.map((t) => ({ id: `tool-${t.tool}`, icon: t.icon, label: t.label, shortcut: t.key, run: () => state.setTool(t.tool) })),
);
addButtons("insert", [
  { id: "image", icon: "image", label: "Insert image", run: insertImage },
  { id: "sign", icon: "sign", label: "Add signature", run: insertSignature },
]);
addButtons("convert", [
  { id: "install", icon: "download", label: "Install app", showLabel: true, needsDoc: false, run: installApp },
  { id: "merge", icon: "merge", label: "Merge PDF", showLabel: true, run: mergeDocument },
  { id: "toWord", icon: "word", label: "To Word", showLabel: true, run: exportWord },
  { id: "toPng", icon: "png", label: "To PNG", showLabel: true, run: exportPng },
]);
addButtons("pages", [
  { id: "rotL", icon: "rotateLeft", label: "Rotate page left", run: () => state.pageOp({ type: "rotate", index: state.currentPage, delta: -90 }) },
  { id: "rotR", icon: "rotateRight", label: "Rotate page right", run: () => state.pageOp({ type: "rotate", index: state.currentPage, delta: 90 }) },
  { id: "up", icon: "up", label: "Move page up", run: () => state.pageOp({ type: "move", index: state.currentPage, to: state.currentPage - 1 }) },
  { id: "down", icon: "down", label: "Move page down", run: () => state.pageOp({ type: "move", index: state.currentPage, to: state.currentPage + 1 }) },
  { id: "blank", icon: "addPage", label: "Insert blank page after", run: () => state.pageOp({ type: "insertBlank", after: state.currentPage }) },
  { id: "delete", icon: "trash", label: "Delete page", run: deletePage },
]);
addButtons("zoom", [
  { id: "zoomOut", icon: "zoomOut", label: "Zoom out", shortcut: `${mod}-`, run: () => viewer.setZoom(viewer.zoom / 1.2) },
]);
const zoomLabel = h("button", { class: "zoom-label", type: "button", title: "Reset to 100%", textContent: "100%" });
zoomLabel.addEventListener("click", () => viewer.setZoom(1));
document.querySelector('[data-group="zoom"]')!.append(zoomLabel);
addButtons("zoom", [
  { id: "zoomIn", icon: "zoomIn", label: "Zoom in", shortcut: `${mod}+`, run: () => viewer.setZoom(viewer.zoom * 1.2) },
  { id: "fit", icon: "fit", label: "Fit width", run: () => viewer.fitWidth() },
]);
document.querySelector("#empty-open")!.addEventListener("click", () => void guarded(openDocument));

// ---------- state → UI ----------

function refreshChrome() {
  const has = state.hasDocument;
  document.querySelector("#empty")!.toggleAttribute("hidden", has);
  document.body.classList.toggle("has-doc", has);
  for (const btn of buttons.values()) btn.disabled = btn.dataset.needsDoc === "true" && !has;
  buttons.get("undo")!.disabled = !has || !state.canUndo;
  buttons.get("redo")!.disabled = !has || !state.canRedo;
  buttons.get("up")!.disabled = !has || state.currentPage === 0;
  buttons.get("down")!.disabled = !has || state.currentPage >= state.pages.length - 1;
  buttons.get("delete")!.disabled = !has || state.pages.length <= 1;
  for (const t of toolSpecs) buttons.get(`tool-${t.tool}`)!.setAttribute("aria-pressed", String(state.tool === t.tool));
  document.querySelector("#status-file")!.textContent = has ? `${state.fileName}${state.dirty ? " • unsaved changes" : ""}` : "No document";
  document.querySelector("#status-page")!.textContent = has ? `Page ${state.currentPage + 1} of ${state.pages.length}` : "";
  zoomLabel.textContent = `${Math.round(viewer.zoom * 100)}%`;
  document.title = has ? `${state.dirty ? "• " : ""}${state.fileName} — PDF Editor` : "PDF Editor";
}
state.on(() => refreshChrome());
scroller.addEventListener("zoomchange", refreshChrome);
refreshChrome();

// ---------- file actions ----------

async function loadOpened(file: OpenedFile) {
  const busy = progress(`Opening ${file.name}…`);
  try {
    await state.open(file.bytes, file.name, file.path, file.handle);
    state.setTool("select");
    requestAnimationFrame(() => viewer.fitWidth());
  } catch (err) {
    if (err instanceof PasswordRequiredError) toast("Password-protected PDFs aren't supported in this prototype yet.", "error", 6000);
    else toast(`Couldn't open ${file.name}: it doesn't look like a valid PDF.`, "error", 6000);
    console.error(err);
  } finally {
    busy.close();
  }
}

async function openDocument() {
  if (state.dirty && !(await confirmDiscard("You have unsaved changes. Open another file and discard them?"))) return;
  const file = await openPdf();
  if (file) await loadOpened(file);
}

async function saveDocument(saveAs: boolean) {
  viewer.finishTextEditing();
  const bytes = await state.exportBytes();
  const name = state.fileName.toLowerCase().endsWith(".pdf") ? state.fileName : `${state.fileName}.pdf`;
  const saved = await saveFile(
    { name, bytes },
    { name: "PDF document", ext: "pdf", mime: "application/pdf" },
    saveAs ? null : { path: state.filePath, handle: state.fileHandle },
  );
  if (!saved) return;
  state.markSaved(saved.name, saved.path, saved.handle);
  toast(canSaveInPlace ? `Saved ${saved.path ?? saved.name}` : `Downloaded ${saved.name}`, "success");
}

async function mergeDocument() {
  const file = await openPdf();
  if (!file) return;
  await state.pageOp({ type: "merge", bytes: file.bytes });
  viewer.scrollToPage(state.currentPage);
  toast(`Added the pages of ${file.name} at the end.`, "success");
}

async function deletePage() {
  if (state.pages.length <= 1) return;
  await state.pageOp({ type: "delete", index: state.currentPage });
}

async function insertImage() {
  const src = await pickImage();
  if (src) await viewer.placeImage(src);
}

async function insertSignature() {
  const src = await signaturePad();
  if (src) await viewer.placeImage(src, 170);
}

const stem = () => state.fileName.replace(/\.pdf$/i, "") || "document";

function radio(name: string, value: string, label: string, detail: string, checked = false) {
  const input = h("input", { type: "radio", name, value, checked });
  return h("label", { class: "choice" }, [input, h("span", {}, [h("strong", { textContent: label }), h("small", { textContent: detail })])]);
}

async function exportWord() {
  viewer.finishTextEditing();
  const body = h("div", { class: "choices" }, [
    radio("docx-mode", "editable", "Editable text", "Rebuilds paragraphs, fonts and pictures so you can edit in Word. Complex layouts and tables may need tidying.", true),
    radio("docx-mode", "layout", "Exact look", "Each page becomes a picture in Word. Looks identical, but the text can't be edited."),
  ]);
  modal("Convert to Word (.docx)", body, [
    { label: "Cancel", onClick: () => {} },
    {
      label: "Convert",
      primary: true,
      onClick: () => {
        const mode = (body.querySelector<HTMLInputElement>("input:checked")?.value ?? "editable") as DocxMode;
        void guarded(async () => {
          const busy = progress("Converting to Word…");
          try {
            const bytes = await pdfToDocx(await state.exportBytes(), mode, (d, t) => busy.update(d, t, `Converting page ${Math.min(d + 1, t)} of ${t}…`));
            busy.close();
            const saved = await saveFile(
              { name: `${stem()}.docx`, bytes },
              { name: "Word document", ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
            );
            if (saved) toast(`Word document saved: ${saved.path ?? saved.name}`, "success");
          } finally {
            busy.close();
          }
        });
      },
    },
  ]);
}

function parseRange(text: string, count: number): number[] | null {
  const pages = new Set<number>();
  for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > count || a > b) return null;
    for (let i = a; i <= b; i++) pages.add(i - 1);
  }
  return pages.size ? [...pages].sort((x, y) => x - y) : null;
}

async function exportPng() {
  viewer.finishTextEditing();
  const dpi = h("select", { class: "input" }, [
    h("option", { value: "96", textContent: "Screen — 96 DPI" }),
    h("option", { value: "150", textContent: "Standard — 150 DPI", selected: true }),
    h("option", { value: "300", textContent: "Print quality — 300 DPI" }),
  ]);
  const range = h("input", { class: "input", placeholder: "e.g. 1-3, 5", disabled: true });
  const body = h("div", { class: "choices" }, [
    h("label", { class: "field stacked" }, [h("span", { textContent: "Resolution" }), dpi]),
    radio("png-pages", "all", "All pages", `${state.pages.length} page${state.pages.length === 1 ? "" : "s"}`, true),
    radio("png-pages", "current", "Current page", `Page ${state.currentPage + 1}`),
    radio("png-pages", "range", "Page range", "Choose specific pages"),
    range,
  ]);
  body.addEventListener("change", () => {
    range.disabled = body.querySelector<HTMLInputElement>('input[name="png-pages"]:checked')?.value !== "range";
    if (!range.disabled) range.focus();
  });
  modal("Convert to PNG images", body, [
    { label: "Cancel", onClick: () => {} },
    {
      label: "Convert",
      primary: true,
      onClick: () => {
        const choice = body.querySelector<HTMLInputElement>('input[name="png-pages"]:checked')?.value;
        const pages =
          choice === "current"
            ? [state.currentPage]
            : choice === "range"
              ? parseRange(range.value, state.pages.length)
              : state.pages.map((_, i) => i);
        if (!pages) {
          toast(`Enter pages between 1 and ${state.pages.length}, like "1-3, 5".`, "error");
          return false;
        }
        void guarded(async () => {
          const busy = progress("Creating images…");
          try {
            const files = await pdfToPngs(await state.exportBytes(), stem(), { dpi: Number(dpi.value), pages }, (d, t) =>
              busy.update(d, t, `Rendering page ${Math.min(d + 1, t)} of ${t}…`),
            );
            busy.close();
            const saved =
              files.length === 1
                ? await saveFile(files[0], { name: "PNG image", ext: "png", mime: "image/png" }).then((f) => f && (f.path ?? f.name))
                : await saveMany(files, `${stem()}-png.zip`);
            if (saved) toast(`${files.length} image${files.length === 1 ? "" : "s"} saved: ${saved}`, "success");
          } finally {
            busy.close();
          }
        });
      },
    },
  ]);
}

// ---------- keyboard ----------

document.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  const typing = target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
  const cmd = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (cmd && key === "o") {
    e.preventDefault();
    void guarded(openDocument);
    return;
  }
  if (!state.hasDocument) return;
  if (cmd && key === "s") {
    e.preventDefault();
    void guarded(() => saveDocument(e.shiftKey));
    return;
  }
  if (typing) return;
  if (cmd && key === "z") {
    e.preventDefault();
    void guarded(() => (e.shiftKey ? state.redo() : state.undo()));
  } else if (cmd && key === "y") {
    e.preventDefault();
    void guarded(() => state.redo());
  } else if (cmd && (key === "=" || key === "+")) {
    e.preventDefault();
    viewer.setZoom(viewer.zoom * 1.2);
  } else if (cmd && key === "-") {
    e.preventDefault();
    viewer.setZoom(viewer.zoom / 1.2);
  } else if ((e.key === "Delete" || e.key === "Backspace") && state.selectedId) {
    e.preventDefault();
    state.removeEdit(state.selectedId);
  } else if (e.key === "Escape") {
    if (state.selectedId) state.select(null);
    else state.setTool("select");
  } else if (!cmd && !e.altKey) {
    const spec = toolSpecs.find((t) => t.key.toLowerCase() === key);
    if (spec) state.setTool(spec.tool);
  }
});

// Ctrl + mouse wheel zoom, like Office and browsers.
scroller.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey || !state.hasDocument) return;
    e.preventDefault();
    viewer.setZoom(viewer.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  },
  { passive: false },
);

// ---------- drag & drop ----------

const dropOverlay = document.querySelector<HTMLElement>("#drop-overlay")!;
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  dropOverlay.classList.add("visible");
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropOverlay.classList.remove("visible");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove("visible");
  const isPdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  const index = [...(e.dataTransfer?.files ?? [])].findIndex(isPdf);
  const file = e.dataTransfer?.files[index];
  if (!file) {
    toast("Drop a .pdf file to open it.", "error");
    return;
  }
  // In Edge/Chrome a dropped file also gives a handle, so Save can write back to it.
  // The handle must be requested synchronously, while the drop event is being handled.
  const handle = e.dataTransfer?.items[index]?.getAsFileSystemHandle?.() ?? Promise.resolve(null);
  void guarded(async () => {
    if (state.dirty && !(await confirmDiscard("You have unsaved changes. Open the dropped file and discard them?"))) return;
    const h = await handle.catch(() => null);
    await loadOpened(h?.kind === "file" ? await readHandle(h as FileSystemFileHandle) : await readFileObject(file));
  });
});

// ---------- installing the web version as an app ----------

let installPrompt: BeforeInstallPromptEvent | null = null;
const installButtons = [buttons.get("install")!, document.querySelector<HTMLElement>("#empty-install")!];
const showInstall = (visible: boolean) => {
  installButtons.forEach((b) => (b.hidden = !visible));
  document.querySelector<HTMLElement>("#get-app")!.hidden = !visible && !installerUrl;
};

async function installApp() {
  if (!installPrompt) return;
  await installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  showInstall(false);
  if (outcome === "accepted") toast("Installed. Open PDF Editor from the Start menu or desktop.", "success", 6000);
}

// Optional link to the Windows installer, set at build time: VITE_WINDOWS_INSTALLER_URL=https://…
const installerUrl: string | undefined = import.meta.env.VITE_WINDOWS_INSTALLER_URL;
if (installerUrl && !isDesktop) {
  const link = document.querySelector<HTMLAnchorElement>("#empty-download")!;
  link.href = installerUrl;
  link.hidden = false;
}
showInstall(false);
document.querySelector("#empty-install")!.addEventListener("click", () => void guarded(installApp));

if (!isDesktop) {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // show our own Install button instead of the browser's mini-bar
    installPrompt = e as BeforeInstallPromptEvent;
    showInstall(true);
  });
  window.addEventListener("appinstalled", () => showInstall(false));
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("Offline support unavailable", err));
    });
  }
  // PDFs opened through Explorer's "Open with → PDF Editor" once the web app is installed.
  onWebAppLaunch((file) =>
    void guarded(async () => {
      if (state.dirty && !(await confirmDiscard("You have unsaved changes. Open the new file and discard them?"))) return;
      await loadOpened(file);
    }),
  );
}

// ---------- startup ----------

void guardClose(() => state.dirty);
void guarded(async () => {
  const file = await launchFile();
  if (file) await loadOpened(file);
});

// Expose for automated checks in development builds only.
if (import.meta.env.DEV) Object.assign(window, { __pdfEditor: { state, viewer } });
