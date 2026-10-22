import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { defineConfig, type Plugin } from "vite";

/** Writes dist/sw.js with the list of built files so the web app works offline. */
function serviceWorker(): Plugin {
  let outDir = "dist";
  return {
    name: "pdf-editor-service-worker",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
          const full = join(dir, name);
          return statSync(full).isDirectory() ? walk(full) : [full];
        });
      const files = walk(outDir)
        .map((f) => relative(outDir, f).split(sep).join("/"))
        .filter((f) => f !== "sw.js" && !f.endsWith(".map") && !f.startsWith("samples/"))
        .sort();
      const template = readFileSync("scripts/sw-template.js", "utf8");
      const hash = createHash("sha256").update(template);
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const sw = template
        .replace("__VERSION__", hash.digest("hex").slice(0, 12))
        .replace("__PRECACHE__", JSON.stringify(["./", ...files]));
      writeFileSync(join(outDir, "sw.js"), sw);
    },
  };
}

// Tauri expects a fixed port and must not have its console output cleared.
// `base: "./"` lets the web build be hosted at any path (e.g. GitHub Pages /pdf-editor/).
export default defineConfig({
  base: "./",
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
  plugins: [serviceWorker()],
});
