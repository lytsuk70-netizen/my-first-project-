/**
 * Document scanner for the phone: each camera shot is cleaned up like a scan (grey, contrast stretched,
 * paper made white) and the pages are joined into one PDF — no libraries, the PDF is written by hand.
 */

export interface ScanPage { jpeg: Uint8Array; width: number; height: number; preview: string }

/** Camera photo → scanned-looking page (long side 1800 px, JPEG). */
export async function photoToPage(file: File): Promise<ScanPage> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  // grey + histogram, then stretch so that text is black and paper is white
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) { const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0; d[i] = g; hist[g]++; }
  const total = w * h;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.25) { hi = v; break; } } // paper is most of the page
  const span = Math.max(30, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    let v = ((d[i] - lo) * 255) / span;
    v = v > 235 ? 255 : v < 0 ? 0 : v; // white paper, no grey shadows
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error('scan'))), 'image/jpeg', 0.72));
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  return { jpeg, width: w, height: h, preview: URL.createObjectURL(blob) };
}

/** Pages → PDF bytes (each page is A4 wide, height by the photo's proportions). */
export function pagesToPdf(pages: ScanPage[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (p: Uint8Array | string) => { const b = typeof p === 'string' ? enc.encode(p) : p; parts.push(b); size += b.length; };
  const obj = (n: number, body: () => void) => { offsets[n] = size; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = pages.length;
  // 1 catalog, 2 pages, then per page: page, content, image
  const pageIds = pages.map((_, i) => 3 + i * 3);
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`));
  pages.forEach((p, i) => {
    const id = pageIds[i];
    const W = 595, H = Math.round((595 * p.height) / p.width);
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(id, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`));
    obj(id + 1, () => { push(`<< /Length ${content.length} >>\nstream\n`); push(content); push('\nendstream'); });
    obj(id + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      push(p.jpeg); push('\nendstream');
    });
  });
  const count = 3 + n * 3;
  const xref = size;
  let x = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(x + `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
