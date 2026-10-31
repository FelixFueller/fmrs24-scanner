// Bildverarbeitung ohne fremde Bibliotheken:
// detectQuad: Blatt im Foto finden (4 Ecken), warp: perspektivisch geradeziehen, applyFilter: Farbe/Grau/S-W.

// ---------- Hilfen ----------
export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}
function ctx2d(c) { return c.getContext('2d', { willReadFrequently: true }); }

// Quelle (img/video/canvas) verkleinert auf max. Seitenlänge zeichnen
export function scaledCanvas(src, srcW, srcH, maxSide) {
  const s = Math.min(1, maxSide / Math.max(srcW, srcH));
  const c = makeCanvas(srcW * s, srcH * s);
  const g = ctx2d(c);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  return { canvas: c, scale: s };
}

function toGray(data, n) {
  const g = new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  return g;
}

function boxBlur(src, w, h, r) {
  // separierbarer Mittelwert-Filter
  const tmp = new Float32Array(w * h), out = new Uint8ClampedArray(w * h);
  const d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0; const o = y * w;
    for (let x = -r; x <= r; x++) acc += src[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = acc / d;
      acc += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / d;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function otsu(g) {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  const total = g.length;
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

function morph(mask, w, h, r, dilate) {
  // quadratisches Strukturelement, separierbar
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let k = -r; k <= r; k++) {
      const xx = x + k; if (xx < 0 || xx >= w) continue;
      const m = mask[y * w + xx];
      if (dilate ? m : !m) { v = dilate ? 1 : 0; break; }
    }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let k = -r; k <= r; k++) {
      const yy = y + k; if (yy < 0 || yy >= h) continue;
      const m = tmp[yy * w + x];
      if (dilate ? m : !m) { v = dilate ? 1 : 0; break; }
    }
    out[y * w + x] = v;
  }
  return out;
}

function largestComponent(mask, w, h) {
  const lab = new Int32Array(w * h), stack = new Int32Array(w * h);
  let best = -1, bestSize = 0, cur = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || lab[i]) continue;
    cur++; let sp = 0, size = 0; stack[sp++] = i; lab[i] = cur;
    while (sp) {
      const p = stack[--sp]; size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !lab[p - w]) { lab[p - w] = cur; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !lab[p + w]) { lab[p + w] = cur; stack[sp++] = p + w; }
    }
    if (size > bestSize) { bestSize = size; best = cur; }
  }
  return { lab, id: best, size: bestSize };
}

function convexHull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  up.pop(); lo.pop();
  return lo.concat(up);
}

export function polyArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) { const p = q[i], n = q[(i + 1) % q.length]; a += p[0] * n[1] - n[0] * p[1]; }
  return Math.abs(a) / 2;
}

// Größtes Viereck aus Hüllpunkten (Startwert Extrempunkte, dann lokal verbessern)
function maxQuad(hull) {
  const n = hull.length;
  if (n < 4) return null;
  const pick = f => { let bi = 0, bv = -Infinity; hull.forEach((p, i) => { const v = f(p); if (v > bv) { bv = v; bi = i; } }); return bi; };
  const cands = [
    [pick(p => -p[0] - p[1]), pick(p => p[0] - p[1]), pick(p => p[0] + p[1]), pick(p => -p[0] + p[1])],
    [pick(p => -p[1]), pick(p => p[0]), pick(p => p[1]), pick(p => -p[0])],
  ];
  let best = null, bestA = -1;
  for (let idx of cands) {
    idx = [...new Set(idx)].sort((a, b) => a - b);
    if (idx.length < 4) continue;
    let improved = true, guard = 0;
    const area = ix => polyArea(ix.map(i => hull[i]));
    let a = area(idx);
    while (improved && guard++ < 50) {
      improved = false;
      for (let k = 0; k < 4; k++) {
        const prev = idx[(k + 3) % 4], next = idx[(k + 1) % 4];
        for (let j = (prev + 1) % n; j !== next; j = (j + 1) % n) {
          const t = idx.slice(); t[k] = j;
          const ta = area(t);
          if (ta > a + 1e-9) { a = ta; idx = t; improved = true; }
        }
      }
    }
    if (a > bestA) { bestA = a; best = idx.map(i => hull[i]); }
  }
  return best;
}

// Ecken sortieren: oben-links, oben-rechts, unten-rechts, unten-links
export function orderQuad(q) {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const s = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  // s beginnt beim Winkel -PI (links), im Uhrzeigersinn (Bildkoordinaten): wähle Start = min(x+y)
  let start = 0, m = Infinity;
  s.forEach((p, i) => { if (p[0] + p[1] < m) { m = p[0] + p[1]; start = i; } });
  return [0, 1, 2, 3].map(i => s[(start + i) % 4]);
}

function quadFromMask(mask, w, h) {
  const comp = largestComponent(mask, w, h);
  if (comp.id < 0 || comp.size < w * h * 0.12) return null;
  const pts = [];
  const { lab, id } = comp;
  for (let y = 0; y < h; y++) {
    let first = -1, last = -1;
    for (let x = 0; x < w; x++) if (lab[y * w + x] === id) { if (first < 0) first = x; last = x; }
    if (first >= 0) { pts.push([first, y]); if (last !== first) pts.push([last + 1, y]); }
  }
  for (let x = 0; x < w; x++) { // auch spaltenweise, damit oben/unten exakt sind
    let first = -1, last = -1;
    for (let y = 0; y < h; y++) if (lab[y * w + x] === id) { if (first < 0) first = y; last = y; }
    if (first >= 0) { pts.push([x, first]); pts.push([x, last + 1]); }
  }
  const hull = convexHull(pts);
  const q = maxQuad(hull);
  if (!q) return null;
  const qa = polyArea(q), ha = polyArea(hull);
  // Plausibel: Viereck füllt die Hülle fast, ist groß genug, nicht das ganze Bild
  if (qa < w * h * 0.12 || qa / ha < 0.88 || qa > w * h * 0.985) return null;
  return { quad: orderQuad(q), score: qa / ha };
}

// Hauptfunktion: liefert 4 Ecken in Koordinaten der Quelle oder null
export function detectQuad(src, srcW, srcH, maxSide = 480) {
  const { canvas, scale } = scaledCanvas(src, srcW, srcH, maxSide);
  const w = canvas.width, h = canvas.height;
  const data = ctx2d(canvas).getImageData(0, 0, w, h).data;
  const n = w * h;
  // Helligkeit und "Papier-Wert" (hell und wenig bunt)
  const gray = toGray(data, n);
  const paper = new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    paper[i] = mx - (mx - mn) * 0.9; // Sättigung abziehen
  }
  const r = Math.max(1, Math.round(Math.max(w, h) / 160));
  let best = null;
  for (const ch of [paper, gray]) {
    const bl = boxBlur(ch, w, h, r);
    const t = otsu(bl);
    let mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = bl[i] > t ? 1 : 0;
    mask = morph(morph(mask, w, h, r, false), w, h, r, true); // öffnen: dünne Brücken weg
    mask = morph(morph(mask, w, h, r * 2, true), w, h, r * 2, false); // schließen: Schrift-Löcher zu
    const res = quadFromMask(mask, w, h);
    if (res && (!best || res.score > best.score)) best = res;
    if (best && best.score > 0.97) break;
  }
  if (!best) return null;
  // minimal nach innen (0,8 % zur Mitte), damit kein dunkler Tischrand im Scan bleibt
  const cx = best.quad.reduce((a, p) => a + p[0], 0) / 4, cy = best.quad.reduce((a, p) => a + p[1], 0) / 4;
  best.quad = best.quad.map(([x, y]) => [x + (cx - x) * 0.008, y + (cy - y) * 0.008]);
  return best.quad.map(([x, y]) => [Math.min(srcW, Math.max(0, x / scale)), Math.min(srcH, Math.max(0, y / scale))]);
}

export function defaultQuad(w, h, inset = 0.04) {
  const dx = w * inset, dy = h * inset;
  return [[dx, dy], [w - dx, dy], [w - dx, h - dy], [dx, h - dy]];
}

// ---------- Entzerren ----------
function solve(A, b) { // Gauß mit Pivot, 8x8
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let p = i; for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let k = i + 1; k < n; k++) {
      const f = A[k][i] / A[i][i];
      for (let j = i; j < n; j++) A[k][j] -= f * A[i][j];
      b[k] -= f * b[i];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j]; x[i] = s / A[i][i]; }
  return x;
}
// Homographie, die Punkte from[i] -> to[i] abbildet
export function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b); h.push(1);
  return h;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export function quadSize(q) {
  const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  return { w, h };
}

// Ausgabegröße: echte Seitenverhältnisse, lange Seite max. maxLong Pixel
export function outputSize(q, maxLong) {
  let { w, h } = quadSize(q);
  const ratio = Math.max(w, h) / Math.min(w, h);
  // nahe A4 (1,414): auf exakt A4 ziehen, sieht sauberer aus
  if (Math.abs(ratio - Math.SQRT2) < 0.07) { if (h >= w) h = w * Math.SQRT2; else w = h * Math.SQRT2; }
  const s = Math.min(1, maxLong / Math.max(w, h));
  return { w: Math.round(w * s), h: Math.round(h * s) };
}

// srcCanvas (volle Auflösung), quad in srcCanvas-Koordinaten
export function warp(srcCanvas, quad, maxLong = 2339) {
  const { w: W, h: H } = outputSize(quad, maxLong);
  const sw = srcCanvas.width, sh = srcCanvas.height;
  const sd = ctx2d(srcCanvas).getImageData(0, 0, sw, sh).data;
  const out = makeCanvas(W, H);
  const og = ctx2d(out);
  const img = og.createImageData(W, H), od = img.data;
  const M = homography([[0, 0], [W, 0], [W, H], [0, H]], quad);
  // Verkleinerung stark? dann vorher Unterabtastung vermeiden: Quelle ist ohnehin <= ~3000px, bilinear reicht
  for (let y = 0; y < H; y++) {
    const yy = y + 0.5;
    for (let x = 0; x < W; x++) {
      const xx = x + 0.5;
      const d = M[6] * xx + M[7] * yy + 1;
      let sx = (M[0] * xx + M[1] * yy + M[2]) / d - 0.5;
      let sy = (M[3] * xx + M[4] * yy + M[5]) / d - 0.5;
      if (sx < 0) sx = 0; else if (sx > sw - 1.001) sx = sw - 1.001;
      if (sy < 0) sy = 0; else if (sy > sh - 1.001) sy = sh - 1.001;
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * fx;
        const bot = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * fx;
        od[o + c] = top + (bot - top) * fy;
      }
      od[o + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  return out;
}

export function rotate(canvas, quarter) {
  quarter = ((quarter % 4) + 4) % 4;
  if (!quarter) return canvas;
  const sw = quarter % 2 === 1;
  const c = makeCanvas(sw ? canvas.height : canvas.width, sw ? canvas.width : canvas.height);
  const g = ctx2d(c);
  g.translate(c.width / 2, c.height / 2);
  g.rotate(quarter * Math.PI / 2);
  g.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return c;
}

// ---------- Filter ----------
// Hintergrund (Papierhelligkeit inkl. Schatten) schätzen: klein rechnen, Schrift wegdehnen, glätten
function backgroundMap(gray, w, h) {
  const f = Math.max(4, Math.round(Math.max(w, h) / 120));
  const bw = Math.ceil(w / f), bh = Math.ceil(h / f);
  let small = new Uint8ClampedArray(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let m = 0; // Maximum im Block = Papier
    for (let y = by * f; y < Math.min(h, by * f + f); y += 2) for (let x = bx * f; x < Math.min(w, bx * f + f); x += 2) { const v = gray[y * w + x]; if (v > m) m = v; }
    small[by * bw + bx] = m;
  }
  // Maximum über Nachbarn (gegen große dunkle Flächen wie Logos) und glätten
  const mx = new Uint8ClampedArray(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    let m = 0;
    for (let k = -2; k <= 2; k++) for (let l = -2; l <= 2; l++) {
      const yy = Math.min(bh - 1, Math.max(0, y + k)), xx = Math.min(bw - 1, Math.max(0, x + l));
      if (small[yy * bw + xx] > m) m = small[yy * bw + xx];
    }
    mx[y * bw + x] = m;
  }
  small = boxBlur(mx, bw, bh, 2);
  return { small, bw, bh, f };
}
function bgAt(bg, x, y) { // bilinear aus der kleinen Karte
  const { small, bw, bh, f } = bg;
  let fx = x / f - 0.5, fy = y / f - 0.5;
  if (fx < 0) fx = 0; if (fy < 0) fy = 0;
  if (fx > bw - 1) fx = bw - 1; if (fy > bh - 1) fy = bh - 1;
  const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(bw - 1, x0 + 1), y1 = Math.min(bh - 1, y0 + 1);
  const ax = fx - x0, ay = fy - y0;
  const t = small[y0 * bw + x0] * (1 - ax) + small[y0 * bw + x1] * ax;
  const b = small[y1 * bw + x0] * (1 - ax) + small[y1 * bw + x1] * ax;
  return t * (1 - ay) + b * ay;
}

// filter: 'farbe' | 'grau' | 'sw' | 'original'
export function applyFilter(canvas, filter) {
  if (filter === 'original') return canvas;
  const w = canvas.width, h = canvas.height, n = w * h;
  const g = ctx2d(canvas);
  const img = g.getImageData(0, 0, w, h), d = img.data;
  const gray = toGray(d, n);
  const bg = backgroundMap(gray, w, h);
  // Gain-Faktor pro Pixel: Papier -> fast weiß (Schatten raus, aufhellen)
  const norm = new Uint8ClampedArray(n);
  const gainRow = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) gainRow[x] = 248 / Math.max(48, bgAt(bg, x, y));
    for (let x = 0; x < w; x++) {
      const i = y * w + x, j = i * 4, k = gainRow[x];
      if (filter === 'farbe') {
        d[j] = d[j] * k; d[j + 1] = d[j + 1] * k; d[j + 2] = d[j + 2] * k;
      }
      norm[i] = gray[i] * k;
    }
  }
  // Schwarzpunkt: 1%-Perzentil auf 0 ziehen (mehr Kontrast)
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i += 3) hist[norm[i]]++;
  let acc = 0, black = 0; const lim = n / 3 * 0.01;
  for (let t = 0; t < 256; t++) { acc += hist[t]; if (acc > lim) { black = t; break; } }
  black = Math.min(black, 120);
  const lut = new Uint8ClampedArray(256);
  for (let t = 0; t < 256; t++) {
    let v = (t - black) * 255 / Math.max(1, 245 - black);
    v = Math.max(0, Math.min(255, v));
    lut[t] = 255 * Math.pow(v / 255, 1.15); // leicht kräftigere Schrift
  }
  if (filter === 'farbe') {
    for (let j = 0; j < d.length; j += 4) { d[j] = lut[d[j]]; d[j + 1] = lut[d[j + 1]]; d[j + 2] = lut[d[j + 2]]; }
  } else if (filter === 'grau') {
    for (let i = 0, j = 0; i < n; i++, j += 4) { const v = lut[norm[i]]; d[j] = d[j + 1] = d[j + 2] = v; }
  } else if (filter === 'sw') {
    // adaptive Schwelle: Pixel deutlich dunkler als seine Umgebung -> schwarz
    const r = Math.max(8, Math.round(Math.max(w, h) / 90));
    const mean = boxBlur(norm, w, h, r);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const v = norm[i] < mean[i] - 14 || norm[i] < 90 ? 0 : 255;
      d[j] = d[j + 1] = d[j + 2] = v;
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.75) {
  return new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('Bild konnte nicht erzeugt werden')), type, quality));
}

// Blob/File -> <img> (beachtet die Drehung aus dem Foto)
export function loadImage(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => { res(im); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Bild nicht lesbar')); };
    im.src = url;
  });
}
