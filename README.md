# PDF Editor

A desktop PDF editor for Windows 10/11 office PCs, with a web version from the same code.
Everything runs on the user's computer. Files are never uploaded anywhere.

**What it does**

- **Edit existing text:** click a line in the PDF, retype it. The original is covered with a patch in the page's background colour, and the new text is written in a matching font, size and colour.
- **Add text, whiteout, highlight, freehand drawing, images and signatures** (signatures are drawn with a mouse or pen).
- **Pages:** rotate, reorder, insert blank pages, delete pages, and merge in another PDF.
- **Convert to Word (.docx)** in one of two modes:
  - *Editable*: rebuilds paragraphs, fonts, bold/italic and pictures.
  - *Exact look*: each page becomes an image.
- **Convert to PNG:** choose 96, 150 or 300 DPI, for all pages, the current page or a page range.
- Undo/redo, keyboard shortcuts, drag-and-drop, unsaved-changes warning, and opening `.pdf` files by double-clicking them in Explorer.

## Stack

| Piece | Library | Licence |
|---|---|---|
| Rendering, text extraction | [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | Apache-2.0 |
| Writing edits / page operations | [pdf-lib](https://github.com/Hopding/pdf-lib) | MIT |
| Word output | [docx](https://github.com/dolanmiu/docx) | MIT |
| Zip (web PNG export) | [fflate](https://github.com/101arrowz/fflate) | MIT |
| Desktop shell | [Tauri 2](https://tauri.app) (uses the WebView2 runtime built into Windows) | MIT / Apache-2.0 |

All of these are permissively licensed, so the app can be distributed commercially as closed source.

## Running it during development

To preview the production web build, including the install button and offline mode, run `npm run build && npm run preview`.


You need Node.js 22.13 or newer. The desktop app also needs Rust (from https://rustup.rs).

```bash
npm install
npm run dev            # web version at http://localhost:5173
npm run tauri dev      # desktop app window with hot reload
node scripts/make-sample.mjs   # regenerates samples/sample.pdf for testing
```

## Publishing: a live link plus a Windows download

The GitHub Actions workflow in `.github/workflows/publish.yml` does both jobs from one repository:

| You do | You get |
|---|---|
| Push to `main` | The web app goes live at `https://<owner>.github.io/<repo>/` |
| Push a tag such as `v0.1.0` | Windows installers are built on a cloud Windows machine and attached to a GitHub Release |

The installer download links never change between versions:

- `https://github.com/<owner>/<repo>/releases/latest/download/PDF-Editor-Setup.exe`
- `https://github.com/<owner>/<repo>/releases/latest/download/PDF-Editor.msi` (for IT deployment)

The web app's start screen also shows a **Download for Windows** button linking to the `.exe`.

To publish a new version: bump `version` in `package.json` and `src-tauri/tauri.conf.json`, then run `git tag v0.2.0 && git push --tags`.

One-time setup: in the repository on GitHub, go to **Settings → Pages → Source** and choose **GitHub Actions**.

### Two ways staff can install it on Windows

**A. Install from the link (no admin rights, nothing to download).** Open the link in **Edge** or Chrome and click **Install app** in the toolbar, or the ⊕ icon in the address bar. PDF Editor then gets a Start-menu and taskbar icon and opens in its own window. It works offline, and it updates itself whenever you publish. After installing, you can right-click any PDF and choose **Open with → PDF Editor**. In Edge/Chrome, **Save** writes straight back to the original file.

IT can also push it to every PC through Microsoft Intune or Group Policy, using Edge's `WebAppInstallForceList` policy with the same link.

**B. Install with the downloaded installer.** Run `PDF-Editor-Setup.exe`, or deploy `PDF-Editor.msi` silently with `msiexec /i PDF-Editor.msi /qn`. This is a native app (Tauri), and it registers itself as a PDF editor in Windows.

**Code signing:** unsigned installers show a "Windows protected your PC" (SmartScreen) warning. Sign them with a code-signing certificate, or with Azure Trusted Signing, before a wide rollout. See https://tauri.app/distribute/sign/windows/. Option A doesn't need signing.

### Building the installer on your own Windows PC

Install Node.js, Rust (MSVC toolchain), and Visual Studio Build Tools with the C++ workload. Then run:

```bash
npm ci
npm run tauri build -- --bundles msi,nsis
```

The installers are written to `src-tauri/target/release/bundle/`.

### Hosting the web version somewhere else

`npm run build` produces a static site in `dist/`. Any static host works: the office intranet (IIS), Netlify, Cloudflare Pages, S3, and so on. Use HTTPS, which installing as an app and offline mode both require. There's no backend: all processing happens in the browser.

## How editing works (and its limits)

Edits are stored as overlay objects while the user works, so they can still be moved, restyled or deleted. On save, they are drawn permanently into the page content with pdf-lib. The coordinate mapping handles rotated pages and offset crop boxes.

Known limits of this prototype:

- **"Edit text" covers and retypes the text.** The original text stays in the file underneath the patch, which is how most lightweight editors work. **This is not redaction.** Don't use whiteout to hide confidential information.
- New text uses Arial/Helvetica, Times or Courier, and only Latin characters. Typing other scripts (such as Hindi, Arabic or Chinese) or emoji shows a warning, and those characters are saved as "?". Supporting them needs a TTF font embedded through `@pdf-lib/fontkit`.
- Word conversion doesn't detect tables or multi-column layouts (they come out as plain paragraphs), keeps no text colours, and has no OCR. Scanned pages are inserted as images.
- Password-protected PDFs aren't supported, and neither is filling PDF form fields. pdf-lib can do forms, so that would be a natural next feature.
- Edits are flattened into the page content, not saved as PDF annotations, so Acrobat won't show them as comments.

## Project layout

```
src/
  main.ts            app shell, toolbar, shortcuts, export dialogs
  state.ts           open document, live edits, undo/redo, page operations
  platform.ts        file access: Tauri dialogs/fs on desktop, downloads on web
  pdf/engine.ts      pdf.js loading, rendering, text runs
  pdf/apply.ts       burns edits into the PDF with pdf-lib
  pdf/pages.ts       rotate / move / insert / delete / merge
  pdf/geometry.ts    screen ↔ PDF coordinate maths
  convert/docx.ts    PDF → Word
  convert/png.ts     PDF → PNG
  ui/                viewer, thumbnails, properties bar, dialogs, icons
src-tauri/           desktop shell (Rust): plugins, permissions, installer config
```
