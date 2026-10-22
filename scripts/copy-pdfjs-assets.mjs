// Copies pdf.js runtime assets (CMaps for CJK text, standard fonts, image
// decoders) into public/ so they are served by Vite and bundled by Tauri.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist");
const dest = join(root, "public", "pdfjs");
mkdirSync(dest, { recursive: true });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  cpSync(join(src, dir), join(dest, dir), { recursive: true });
}
console.log("pdf.js assets copied to public/pdfjs");
