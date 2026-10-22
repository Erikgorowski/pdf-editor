// One interface for file access, three implementations, best first:
//  1. Tauri desktop app: native dialogs, writes straight to disk.
//  2. Web in Edge/Chrome: File System Access API, so Save writes back to the
//     opened file and Save As shows a real "Save as" dialog, like a desktop app.
//  3. Other browsers: file inputs and downloads (a .zip for several files).
// The rest of the app never checks which one is in use.

import { zipSync } from "fflate";

export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const canSaveInPlace = isDesktop || (typeof window !== "undefined" && typeof window.showSaveFilePicker === "function");
export const isInstalledWebApp = typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches;

export interface OpenedFile {
  name: string;
  path: string | null;
  handle: FileSystemFileHandle | null;
  bytes: Uint8Array;
}

export interface OutputFile {
  name: string;
  bytes: Uint8Array;
}

/** Where a file lives once saved: a path on desktop, a file handle in Edge/Chrome. */
export interface FileLocation {
  name: string;
  path: string | null;
  handle: FileSystemFileHandle | null;
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

function pickWithInput(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener("change", () => resolve([...(input.files ?? [])]));
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

export async function readFileObject(file: File, handle: FileSystemFileHandle | null = null): Promise<OpenedFile> {
  return { name: file.name, path: null, handle, bytes: new Uint8Array(await file.arrayBuffer()) };
}

export async function readHandle(handle: FileSystemFileHandle): Promise<OpenedFile> {
  return readFileObject(await handle.getFile(), handle);
}

export async function openPdf(): Promise<OpenedFile | null> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({ multiple: false, filters: [{ name: "PDF documents", extensions: ["pdf"] }] });
    if (typeof path !== "string") return null;
    return { name: baseName(path), path, handle: null, bytes: await readFile(path) };
  }
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        id: "pdf",
        types: [{ description: "PDF documents", accept: { "application/pdf": [".pdf"] } }],
      });
      return readHandle(handle);
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
  }
  const [file] = await pickWithInput("application/pdf,.pdf");
  return file ? readFileObject(file) : null;
}

export async function openPath(path: string): Promise<OpenedFile> {
  const { readFile } = await import("@tauri-apps/plugin-fs");
  return { name: baseName(path), path, handle: null, bytes: await readFile(path) };
}

/** PDF the desktop app was launched with (double-clicked in Explorer), if any. */
export async function launchFile(): Promise<OpenedFile | null> {
  if (!isDesktop) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const path = await invoke<string | null>("launch_file");
  return path ? openPath(path) : null;
}

/** PDFs opened with the installed web app ("Open with → PDF Editor" in Explorer). */
export function onWebAppLaunch(open: (file: OpenedFile) => void) {
  window.launchQueue?.setConsumer(async ({ files }) => {
    const handle = files.find((f): f is FileSystemFileHandle => f.kind === "file");
    if (handle) open(await readHandle(handle));
  });
}

export async function pickImage(): Promise<string | null> {
  const [file] = await pickWithInput("image/png,image/jpeg");
  if (!file) return null;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function download(bytes: Uint8Array, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function writeHandle(handle: FileSystemFileHandle, bytes: Uint8Array) {
  if ((await handle.queryPermission?.({ mode: "readwrite" })) !== "granted") {
    if ((await handle.requestPermission?.({ mode: "readwrite" })) === "denied") {
      throw new Error("Permission to save this file was denied.");
    }
  }
  const writable = await handle.createWritable();
  await writable.write(bytes as BlobPart);
  await writable.close();
}

/**
 * Saves one file and returns where it went, or null if the user cancelled.
 * Passing `overwrite` (the file's current location) saves without a dialog.
 */
export async function saveFile(
  file: OutputFile,
  filter: { name: string; ext: string; mime: string },
  overwrite?: Partial<FileLocation> | null,
): Promise<FileLocation | null> {
  if (isDesktop) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path =
      overwrite?.path ?? (await save({ defaultPath: file.name, filters: [{ name: filter.name, extensions: [filter.ext] }] }));
    if (!path) return null;
    await writeFile(path, file.bytes);
    return { name: baseName(path), path, handle: null };
  }
  if (overwrite?.handle) {
    await writeHandle(overwrite.handle, file.bytes);
    return { name: overwrite.handle.name, path: null, handle: overwrite.handle };
  }
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        id: filter.ext,
        suggestedName: file.name,
        types: [{ description: filter.name, accept: { [filter.mime]: [`.${filter.ext}`] } }],
      });
      await writeHandle(handle, file.bytes);
      return { name: handle.name, path: null, handle };
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
  }
  download(file.bytes, file.name, filter.mime);
  return { name: file.name, path: null, handle: null };
}

/** Saves several files into a folder the user picks (a .zip download in older browsers). */
export async function saveMany(files: OutputFile[], zipName: string): Promise<string | null> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");
    const dir = await open({ directory: true, title: "Choose a folder for the images" });
    if (typeof dir !== "string") return null;
    for (const f of files) await writeFile(await join(dir, f.name), f.bytes);
    return dir;
  }
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker({ id: "png", mode: "readwrite" });
      for (const f of files) await writeHandle(await dir.getFileHandle(f.name, { create: true }), f.bytes);
      return `folder “${dir.name}”`;
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
  }
  const zip = zipSync(Object.fromEntries(files.map((f) => [f.name, [f.bytes, { level: 0 }]])));
  download(zip, zipName, "application/zip");
  return zipName;
}

export async function confirmDiscard(message: string): Promise<boolean> {
  if (isDesktop) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return ask(message, { title: "Unsaved changes", kind: "warning", okLabel: "Discard", cancelLabel: "Cancel" });
  }
  return window.confirm(message);
}

/** Warns before closing the window/tab with unsaved changes. */
export async function guardClose(isDirty: () => boolean) {
  if (isDesktop) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().onCloseRequested(async (event) => {
      if (isDirty() && !(await confirmDiscard("You have unsaved changes. Close without saving?"))) {
        event.preventDefault();
      }
    });
  } else {
    window.addEventListener("beforeunload", (e) => {
      if (isDirty()) e.preventDefault();
    });
  }
}
