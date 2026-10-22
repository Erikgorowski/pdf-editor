// Generates samples/sample.pdf: a 3-page office-style document used for testing
// (heading, paragraphs, a bulleted list, a coloured picture, and a landscape page).
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import { writeFileSync } from "node:fs";

const doc = await PDFDocument.create();
const regular = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const serif = await doc.embedFont(StandardFonts.TimesRoman);

const body = [
  "This quarterly report summarises the operational results of the regional",
  "offices. Revenue grew steadily across all divisions, while operating costs",
  "remained within the approved budget for the third consecutive quarter.",
];
const body2 = [
  "The board approved the expansion plan for two new branch offices. Hiring",
  "for both locations will begin next month, and the IT team will roll out",
  "the new document management system to all staff before the end of the year.",
];

let page = doc.addPage([595.28, 841.89]); // A4
page.drawRectangle({ x: 0, y: 781.89, width: 595.28, height: 60, color: rgb(0.14, 0.35, 0.84) });
page.drawText("ACME Holdings Ltd.", { x: 50, y: 803, size: 20, font: bold, color: rgb(1, 1, 1) });
page.drawText("Quarterly Operations Report", { x: 50, y: 730, size: 24, font: bold, color: rgb(0.1, 0.1, 0.12) });
page.drawText("Prepared by the Finance Department - Q3 2026", { x: 50, y: 706, size: 11, font: regular, color: rgb(0.4, 0.4, 0.45) });
let y = 670;
for (const line of body) { page.drawText(line, { x: 50, y, size: 12, font: regular }); y -= 16; }
y -= 14;
page.drawText("Key highlights", { x: 50, y, size: 16, font: bold }); y -= 24;
for (const item of ["Revenue up 12% year over year", "Customer satisfaction score of 4.6 / 5", "Invoice: INV-2026-0042 total $18,450.00"]) {
  page.drawText("•  " + item, { x: 62, y, size: 12, font: regular }); y -= 18;
}
y -= 14;
for (const line of body2) { page.drawText(line, { x: 50, y, size: 12, font: regular }); y -= 16; }
// A simple "chart" picture: a PNG built in memory.
const png = makeChartPng(320, 160);
const img = await doc.embedPng(png);
page.drawImage(img, { x: 50, y: y - 190, width: 320, height: 160 });
page.drawText("Figure 1: Revenue by quarter", { x: 50, y: y - 210, size: 10, font: serif, color: rgb(0.35, 0.35, 0.4) });

page = doc.addPage([595.28, 841.89]);
page.drawText("Terms and Conditions", { x: 50, y: 780, size: 18, font: bold });
y = 750;
for (let i = 1; i <= 8; i++) {
  page.drawText(`${i}. Payment is due within 30 days of the invoice date. Late payments may incur`, { x: 50, y, size: 11, font: serif }); y -= 15;
  page.drawText("    a fee as described in the master services agreement signed by both parties.", { x: 50, y, size: 11, font: serif }); y -= 22;
}
page.drawText("Signature: ______________________     Date: ____________", { x: 50, y: 120, size: 12, font: regular });

page = doc.addPage([841.89, 595.28]); // landscape
page.drawText("Appendix A - Landscape page", { x: 50, y: 540, size: 18, font: bold });
page.drawText("This page is landscape to test page sizes and rotation.", { x: 50, y: 510, size: 12, font: regular });

writeFileSync(new URL("../samples/sample.pdf", import.meta.url), await doc.save());
console.log("wrote samples/sample.pdf");

function makeChartPng(w, h) {
  // Minimal uncompressed PNG encoder (zlib "stored" blocks) for a bar chart.
  const raw = [];
  const bars = [0.45, 0.6, 0.72, 0.9];
  for (let yy = 0; yy < h; yy++) {
    raw.push(0);
    for (let xx = 0; xx < w; xx++) {
      const bi = Math.floor((xx / w) * 4);
      const inBar = (xx % (w / 4)) > 12 && (xx % (w / 4)) < w / 4 - 12 && (h - yy) < bars[bi] * h;
      const c = inBar ? [36, 89, 214] : yy === h - 1 || xx === 0 ? [80, 80, 90] : [245, 247, 250];
      raw.push(...c);
    }
  }
  const data = Buffer.from(raw);
  const blocks = [];
  for (let i = 0; i < data.length; i += 65535) {
    const chunk = data.subarray(i, i + 65535);
    const last = i + 65535 >= data.length ? 1 : 0;
    blocks.push(Buffer.from([last, chunk.length & 255, chunk.length >> 8, ~chunk.length & 255, (~chunk.length >> 8) & 255]), chunk);
  }
  let a = 1, b = 0;
  for (const v of data) { a = (a + v) % 65521; b = (b + a) % 65521; }
  const adler = Buffer.alloc(4); adler.writeUInt32BE(((b << 16) | a) >>> 0);
  const idat = Buffer.concat([Buffer.from([0x78, 0x01]), ...blocks, adler]);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const v of buf) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const tb = Buffer.concat([Buffer.from(type), body]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(tb)); return Buffer.concat([len, tb, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
