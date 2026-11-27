/**
 * Document scanner for the phone: each camera shot is cleaned up like a scan (grey, contrast stretched,
 * paper made white) and the pages are joined into one PDF — no libraries, the PDF is written by hand.
 */

export interface Pt { x: number; y: number }
/** A shot: the photo kept for re-cropping, the 4 corners (TL, TR, BR, BL) and the cleaned page. */
export interface ScanPage { jpeg: Uint8Array; width: number; height: number; preview: string; src: HTMLCanvasElement; corners: Pt[] }

/** Camera photo → canvas (long side up to 2000 px, EXIF orientation applied by the browser). */
export async function loadPhoto(file: File): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as any).catch(() => createImageBitmap(file));
  const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

/** Finds the sheet of paper: the biggest bright area, its 4 outer corners. Falls back to the whole photo. */
export function detectCorners(src: HTMLCanvasElement): Pt[] {
  const W = src.width, H = src.height;
  const k = 320 / Math.max(W, H);
  const w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h); const hist = new Uint32Array(256);
  for (let i = 0; i < w * h; i++) { const v = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000 | 0; g[i] = v; hist[v]++; }
  // Otsu threshold
  let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sB = 0, wB = 0, best = 0, th = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v]; if (!wB) continue; const wF = w * h - wB; if (!wF) break;
    sB += v * hist[v]; const mB = sB / wB, mF = (sum - sB) / wF; const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; th = v; }
  }
  // biggest connected bright region
  const lab = new Int32Array(w * h); let bestLab = 0, bestN = 0, cur = 0; const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (g[i] <= th || lab[i]) continue;
    cur++; let n = 0; stack.push(i); lab[i] = cur;
    while (stack.length) {
      const j = stack.pop()!; n++; const x = j % w, y = (j / w) | 0;
      const nb = [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1];
      for (const q of nb) if (q >= 0 && !lab[q] && g[q] > th) { lab[q] = cur; stack.push(q); }
    }
    if (n > bestN) { bestN = n; bestLab = cur; }
  }
  const full = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  if (bestN < w * h * 0.08 || bestN > w * h * 0.97) return full;
  let tl = [Infinity, 0, 0], tr = [-Infinity, 0, 0], br = [-Infinity, 0, 0], bl = [Infinity, 0, 0];
  for (let i = 0; i < w * h; i++) {
    if (lab[i] !== bestLab) continue;
    const x = i % w, y = (i / w) | 0;
    if (x + y < tl[0]) tl = [x + y, x, y];
    if (x + y > br[0]) br = [x + y, x, y];
    if (x - y > tr[0]) tr = [x - y, x, y];
    if (x - y < bl[0]) bl = [x - y, x, y];
  }
  return [tl, tr, br, bl].map((p) => ({ x: Math.min(W, Math.max(0, (p[1] + 0.5) / k)), y: Math.min(H, Math.max(0, (p[2] + 0.5) / k)) }));
}

/** Homography that maps the unit square (0,0)(1,0)(1,1)(0,1) to the quad. */
function squareToQuad(q: Pt[]) {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
  const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (sx * dy2 - dx2 * sy) / den, hh = (dx1 * sy - sx * dy1) / den;
  return { a: p1.x - p0.x + g * p1.x, b: p3.x - p0.x + hh * p3.x, c: p0.x, d: p1.y - p0.y + g * p1.y, e: p3.y - p0.y + hh * p3.y, f: p0.y, g, h: hh };
}

/** Cuts the quad out of the photo, straightens it and cleans it up like a scan (long side ≤ 1800 px, JPEG). */
export async function cropToPage(src: HTMLCanvasElement, corners: Pt[]): Promise<ScanPage> {
  const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  let ow = Math.max(dist(corners[0], corners[1]), dist(corners[3], corners[2]));
  let oh = Math.max(dist(corners[0], corners[3]), dist(corners[1], corners[2]));
  const k = Math.min(1.5, 1800 / Math.max(ow, oh));
  ow = Math.max(16, Math.round(ow * k)); oh = Math.max(16, Math.round(oh * k));
  const W = src.width, H = src.height;
  const sd = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H).data;
  const grey = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) grey[i] = (sd[i * 4] * 299 + sd[i * 4 + 1] * 587 + sd[i * 4 + 2] * 114) / 1000 | 0;
  const m = squareToQuad(corners);
  const out = new Uint8Array(ow * oh); const hist = new Uint32Array(256);
  for (let y = 0; y < oh; y++) {
    const v = (y + 0.5) / oh;
    for (let x = 0; x < ow; x++) {
      const u = (x + 0.5) / ow;
      const z = m.g * u + m.h * v + 1;
      let px = (m.a * u + m.b * v + m.c) / z - 0.5, py = (m.d * u + m.e * v + m.f) / z - 0.5;
      px = px < 0 ? 0 : px > W - 1.001 ? W - 1.001 : px; py = py < 0 ? 0 : py > H - 1.001 ? H - 1.001 : py;
      const x0 = px | 0, y0 = py | 0, fx = px - x0, fy = py - y0, i0 = y0 * W + x0;
      const val = (grey[i0] * (1 - fx) + grey[i0 + 1] * fx) * (1 - fy) + (grey[i0 + W] * (1 - fx) + grey[i0 + W + 1] * fx) * fy;
      const vv = val | 0; out[y * ow + x] = vv; hist[vv]++;
    }
  }
  // contrast: text black, paper white
  const total = ow * oh; let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.4) { hi = v; break; } }
  const span = Math.max(30, hi - lo);
  const c = document.createElement('canvas'); c.width = ow; c.height = oh;
  const ctx = c.getContext('2d')!; const img = ctx.createImageData(ow, oh); const d = img.data;
  for (let i = 0; i < total; i++) {
    let v = ((out[i] - lo) * 255) / span; v = v > 225 ? 255 : v < 0 ? 0 : v;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error('scan'))), 'image/jpeg', 0.72));
  return { jpeg: new Uint8Array(await blob.arrayBuffer()), width: ow, height: oh, preview: URL.createObjectURL(blob), src, corners };
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
