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

// ---------- Blatterkennung: mehrere Kandidaten, jeder wird an den Blattkanten geprüft ----------
function labelComponents(mask, w, h) {
  const lab = new Int32Array(w * h), stack = new Int32Array(w * h), sizes = [0];
  let cur = 0;
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
    sizes.push(size);
  }
  return { lab, sizes };
}

function hullOf(lab, id, w, h) {
  const pts = [];
  for (let y = 0; y < h; y++) {
    let first = -1, last = -1;
    for (let x = 0; x < w; x++) if (lab[y * w + x] === id) { if (first < 0) first = x; last = x; }
    if (first >= 0) { pts.push([first, y]); pts.push([last + 1, y]); }
  }
  for (let x = 0; x < w; x++) {
    let first = -1, last = -1;
    for (let y = 0; y < h; y++) if (lab[y * w + x] === id) { if (first < 0) first = y; last = y; }
    if (first >= 0) { pts.push([x, first]); pts.push([x, last + 1]); }
  }
  return convexHull(pts);
}

function sobel(g, w, h) {
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1], d = g[i - 1], f = g[i + 1], k = g[i + w - 1], l = g[i + w], m = g[i + w + 1];
    gx[i] = (c + 2 * f + m) - (a + 2 * d + k);
    gy[i] = (k + 2 * l + m) - (a + 2 * b + c);
  }
  return { gx, gy };
}

const thresholdMask = (ch, t) => { const m = new Uint8Array(ch.length); for (let i = 0; i < ch.length; i++) m[i] = ch[i] > t ? 1 : 0; return m; };

// Anteil einer Seite, an dem eine gleichgerichtete Kante quer zur Seite verläuft.
// Gezählt wird nur die vorherrschende Richtung (Blatt heller oder dunkler als der Tisch), Muster mischen beide.
function sideSupport(G, w, h, a, b, tE) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  if (len < 4) return 0;
  const nx = -dy / len, ny = dx / len;
  let pos = 0, neg = 0, tot = 0;
  const N = Math.max(12, Math.min(48, Math.round(len / 4)));
  for (let s = 0; s < N; s++) {
    const t = 0.08 + 0.84 * s / (N - 1);
    const px = a[0] + dx * t, py = a[1] + dy * t;
    if (px < 3 || py < 3 || px > w - 4 || py > h - 4) continue; // Teil der Seite außerhalb des Bildes
    let best = 0;
    for (let o = -2.5; o <= 2.5; o += 1) {
      const x = Math.round(px + nx * o), y = Math.round(py + ny * o);
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      const i = y * w + x, v = G.gx[i] * nx + G.gy[i] * ny;
      if (Math.abs(v) > Math.abs(best)) best = v;
    }
    tot++;
    if (best > tE) pos++; else if (best < -tE) neg++;
  }
  if (tot < N * 0.3) return 0; // zu wenig von der Seite sichtbar
  return (Math.max(pos, neg) - 0.5 * Math.min(pos, neg)) / tot;
}

function onBorder(a, b, w, h, bt) {
  return (a[0] < bt && b[0] < bt) || (a[1] < bt && b[1] < bt) || (a[0] > w - bt && b[0] > w - bt) || (a[1] > h - bt && b[1] > h - bt);
}

function angleOk(q) {
  for (let i = 0; i < 4; i++) {
    const p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4];
    const v1 = [p[0] - c[0], p[1] - c[1]], v2 = [n[0] - c[0], n[1] - c[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) + 1e-9);
    const ang = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    if (ang < 40 || ang > 140) return false;
  }
  return true;
}

function pointInQuad(p, q) {
  let c = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = q[i], [xj, yj] = q[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// Wie unruhig ist ein schmaler Streifen direkt innerhalb der Seiten? Papier hat dort Rand, ein Textblock nicht.
function insideBusy(q, mags, w, h, tE) {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const off = Math.max(6, Math.round(Math.max(w, h) / 55));
  const per = [];
  for (let k = 0; k < 4; k++) {
    const a = q[k], b = q[(k + 1) % 4], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    let nx = -dy / len, ny = dx / len, hit = 0, tot = 0;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; } // nach innen
    for (let s = 0; s < 30; s++) {
      const t = 0.12 + 0.76 * s / 29;
      for (const o of [off, off * 1.5, off * 2]) {
        const x = Math.round(a[0] + dx * t + nx * o), y = Math.round(a[1] + dy * t + ny * o);
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        tot++; if (mags[y * w + x] > tE) hit++;
      }
    }
    if (tot) per.push(hit / tot);
  }
  if (per.length < 2) return 1;
  per.sort((a, b) => a - b);
  return per[1]; // mindestens zwei Seiten mit ruhigem Rand
}

function scoreQuad(q, hullArea, G, w, h, tE, mags) {
  const qa = polyArea(q), af = qa / (w * h);
  const outside = q.some(([x, y]) => x < -1 || y < -1 || x > w + 1 || y > h + 1);
  if (af < 0.05 || (!outside && af > 0.995) || !angleOk(q)) return null;
  if (q.some(([x, y]) => x < -0.4 * w || y < -0.4 * h || x > 1.4 * w || y > 1.4 * h)) return null;
  const bt = Math.max(w, h) * 0.02;
  let nb = 0, through = 0; const sup = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    if (onBorder(a, b, w, h, bt)) { nb++; continue; }
    sup.push(sideSupport(G, w, h, a, b, tE));
    // Läuft die Kante über beide Ecken hinaus weiter (z.B. Schattenlinie), ist es kein Blattrand
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const e1 = sideSupport(G, w, h, [b[0] + dx * 0.03, b[1] + dy * 0.03], [b[0] + dx * 0.12, b[1] + dy * 0.12], tE);
    const e2 = sideSupport(G, w, h, [a[0] - dx * 0.12, a[1] - dy * 0.12], [a[0] - dx * 0.03, a[1] - dy * 0.03], tE);
    if (Math.min(e1, e2) > 0.5) through++;
  }
  if (nb > 2 || !sup.length) return null;
  const minS = Math.min(...sup), meanS = sup.reduce((s, v) => s + v, 0) / sup.length;
  const rect = hullArea ? Math.min(1, qa / hullArea) : 1;
  const busy = insideBusy(q, mags, w, h, tE);
  const score = 0.55 * minS + 0.3 * meanS + 0.15 * rect - 0.05 * nb - 0.6 * Math.max(0, busy - 0.25) - 0.3 * through;
  return { quad: q, score, area: qa, busy, confident: minS >= 0.5 && meanS >= 0.65 && rect >= 0.88 && busy < 0.45 && !through, nb };
}

function simplify(pts, eps) { // Douglas-Peucker auf geschlossenem Polygon
  if (pts.length < 4) return pts;
  let far = 0, fd = -1; // Startpunkt: weitester Punkt von pts[0]
  pts.forEach((p, i) => { const d = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]); if (d > fd) { fd = d; far = i; } });
  const dp = (a) => {
    if (a.length < 3) return a;
    const [x1, y1] = a[0], [x2, y2] = a[a.length - 1], L = Math.hypot(x2 - x1, y2 - y1) || 1;
    let im = 0, dm = 0;
    for (let i = 1; i < a.length - 1; i++) { const d = Math.abs((x2 - x1) * (y1 - a[i][1]) - (x1 - a[i][0]) * (y2 - y1)) / L; if (d > dm) { dm = d; im = i; } }
    if (dm <= eps) return [a[0], a[a.length - 1]];
    return dp(a.slice(0, im + 1)).slice(0, -1).concat(dp(a.slice(im)));
  };
  const A = pts.slice(0, far + 1), B = pts.slice(far).concat([pts[0]]);
  return dp(A).slice(0, -1).concat(dp(B).slice(0, -1));
}
function intersect(a1, a2, b1, b2) {
  const d1 = [a2[0] - a1[0], a2[1] - a1[1]], d2 = [b2[0] - b1[0], b2[1] - b1[1]];
  const det = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(det) < 1e-6 * Math.hypot(...d1) * Math.hypot(...d2)) return null;
  const t = ((b1[0] - a1[0]) * d2[1] - (b1[1] - a1[1]) * d2[0]) / det;
  return [a1[0] + d1[0] * t, a1[1] + d1[1] * t];
}
// Blatt ragt aus dem Bild: Seiten am Bildrand weglassen, die 4 echten Seiten verlängern und schneiden
function quadThroughBorder(hull, w, h) {
  const bt = Math.max(w, h) * 0.02;
  const poly = simplify(hull, Math.hypot(w, h) * 0.012);
  if (poly.length < 5 || poly.length > 8) return null;
  const edges = poly.map((p, i) => [p, poly[(i + 1) % poly.length]]);
  const real = edges.filter(([a, b]) => !onBorder(a, b, w, h, bt) && Math.hypot(b[0] - a[0], b[1] - a[1]) > Math.max(w, h) * 0.05);
  if (real.length !== 4 || edges.length - real.length < 1) return null;
  const q = [];
  for (let i = 0; i < 4; i++) { const c = intersect(...real[i], ...real[(i + 1) % 4]); if (!c) return null; q.push(c); }
  return q;
}

// Hauptfunktion. Liefert { quad, confident, score } in Quell-Koordinaten oder null.
// quad ist bei confident=false nur ein Vorschlag (Ecken prüfen lassen).
export function findDocument(src, srcW, srcH, { maxSide = 512, refine = true } = {}) {
  const { canvas, scale } = scaledCanvas(src, srcW, srcH, maxSide);
  const w = canvas.width, h = canvas.height, n = w * h;
  const data = ctx2d(canvas).getImageData(0, 0, w, h).data;
  const gray = toGray(data, n);
  const gB = boxBlur(gray, w, h, 1);
  const G = sobel(gB, w, h);
  // Kantenschwelle: Rauschen schätzen (Median der Gradienten), mindestens 14
  const mags = new Float32Array(n); for (let i = 0; i < n; i++) mags[i] = Math.abs(G.gx[i]) + Math.abs(G.gy[i]);
  const sample = Array.from(mags.filter((_, i) => i % 7 === 0)).sort((a, b) => a - b);
  const med = sample[sample.length >> 1] || 0;
  const tE = Math.max(14, med * 3.5);

  const r = Math.max(1, Math.round(Math.max(w, h) / 160));
  const blur = ch => boxBlur(ch, w, h, r);
  const clean = m => morph(morph(morph(morph(m, w, h, r, false), w, h, r, true), w, h, r * 2, true), w, h, r * 2, false);
  const masks = [];
  // 1) Helligkeit
  const gr = blur(gray); masks.push(clean(thresholdMask(gr, otsu(gr))));
  // 2) "Papier": hell und wenig bunt
  const paper = new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) { const mx = Math.max(data[j], data[j + 1], data[j + 2]), mn = Math.min(data[j], data[j + 1], data[j + 2]); paper[i] = mx - (mx - mn) * 0.9; }
  const pb = blur(paper); masks.push(clean(thresholdMask(pb, otsu(pb))));
  // 3) Farbabstand zum Tisch (Farbe am Bildrand)
  const rim = [[], [], []], bw = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if (x < bw || y < bw || x >= w - bw || y >= h - bw) { const j = (y * w + x) * 4; rim[0].push(data[j]); rim[1].push(data[j + 1]); rim[2].push(data[j + 2]); }
  const bgc = rim.map(a => a.sort((p, q) => p - q)[a.length >> 1]);
  const dist = new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) dist[i] = (Math.abs(data[j] - bgc[0]) + Math.abs(data[j + 1] - bgc[1]) + Math.abs(data[j + 2] - bgc[2])) * 0.6;
  const db = blur(dist); masks.push(clean(thresholdMask(db, Math.max(18, otsu(db)))));
  // 4) Umschlossen von Kanten (hilft bei weißem Blatt auf hellem Tisch und bei Schatten)
  for (const f of [1, 2]) {
    let edge = new Uint8Array(n);
    for (let i = 0; i < n; i++) edge[i] = mags[i] > tE * f * 0.75 ? 1 : 0;
    edge = morph(edge, w, h, 1, true);
    const out = new Uint8Array(n), st = [];
    const push = i => { if (!edge[i] && !out[i]) { out[i] = 1; st.push(i); } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (st.length) { const p = st.pop(), x = p % w; if (x > 0) push(p - 1); if (x < w - 1) push(p + 1); if (p >= w) push(p - w); if (p < n - w) push(p + w); }
    let ins = new Uint8Array(n); for (let i = 0; i < n; i++) ins[i] = out[i] ? 0 : 1;
    masks.push(morph(morph(ins, w, h, r, false), w, h, r, true));
  }

  const cands = [];
  for (const m of masks) {
    const { lab, sizes } = labelComponents(m, w, h);
    const ids = sizes.map((s, i) => [s, i]).slice(1).filter(([s]) => s > n * 0.04).sort((a, b) => b[0] - a[0]).slice(0, 3);
    for (const [, id] of ids) {
      const hull = hullOf(lab, id, w, h);
      const ha = polyArea(hull);
      const q = maxQuad(hull);
      if (q) { const sc = scoreQuad(orderQuad(q), ha, G, w, h, tE, mags); if (sc) cands.push(sc); }
      const qb = quadThroughBorder(hull, w, h);
      if (qb) { const sc = scoreQuad(orderQuad(qb), 0, G, w, h, tE, mags); if (sc) cands.push(sc); }
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  if (typeof window !== 'undefined' && window.__scanDebug) window.__scanDebug = cands.map(c => ({ s: +c.score.toFixed(2), conf: c.confident, busy: +c.busy.toFixed(2), a: Math.round(c.area), q: c.quad.map(p => p.map(v => Math.round(v / scale))) }));
  let best = cands[0];
  // Gibt es ein größeres, ebenfalls sicheres Viereck, das das beste enthält (z.B. dunkler Briefkopf)? Dann das.
  if (best.confident) {
    for (const c of cands) {
      if (c === best || !c.confident || c.area < best.area * 1.06 || c.score < best.score - 0.2) continue;
      const cx = best.quad.reduce((s, p) => s + p[0], 0) / 4, cy = best.quad.reduce((s, p) => s + p[1], 0) / 4;
      const shrunk = best.quad.map(([x, y]) => [x + (cx - x) * 0.04, y + (cy - y) * 0.04]);
      if (shrunk.every(p => pointInQuad(p, c.quad)) && (!best.big || c.area > best.area)) best = Object.assign({}, c, { big: true });
    }
  }
  let quad = best.quad.map(([x, y]) => [x / scale, y / scale]);
  if (refine && best.confident) quad = refineQuad(src, srcW, srcH, quad);
  // minimal nach innen (0,5 % zur Mitte), damit kein Tischrand im Scan bleibt
  const cx = quad.reduce((a, p) => a + p[0], 0) / 4, cy = quad.reduce((a, p) => a + p[1], 0) / 4;
  quad = quad.map(([x, y]) => [x + (cx - x) * 0.005, y + (cy - y) * 0.005]);
  return { quad, confident: best.confident, score: best.score };
}

// Ecken genauer: entlang jeder Seite die stärkste Kante suchen, Geraden einpassen, schneiden
export function refineQuad(src, srcW, srcH, quad, maxSide = 1400) {
  const { canvas, scale } = scaledCanvas(src, srcW, srcH, maxSide);
  const w = canvas.width, h = canvas.height;
  const g = boxBlur(toGray(ctx2d(canvas).getImageData(0, 0, w, h).data, w * h), w, h, 1);
  const q = quad.map(([x, y]) => [x * scale, y * scale]);
  const diag = Math.hypot(w, h), R = Math.max(4, Math.round(diag * 0.008)), bt = Math.max(w, h) * 0.02;
  const at = (x, y) => { // bilinear
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return null;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
  };
  const lines = [];
  for (let k = 0; k < 4; k++) {
    const a = q[k], b = q[(k + 1) % 4];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    const nx = -dy / len, ny = dx / len;
    if (onBorder(a, b, w, h, bt)) { lines.push({ p: a, d: [dx / len, dy / len], ok: false }); continue; }
    let pts = [];
    for (let s = 0; s < 40; s++) {
      const t = 0.1 + 0.8 * s / 39, px = a[0] + dx * t, py = a[1] + dy * t;
      let best = 0, bo = null;
      for (let o = -R; o <= R; o += 0.5) {
        const v1 = at(px + nx * (o + 1), py + ny * (o + 1)), v0 = at(px + nx * (o - 1), py + ny * (o - 1));
        if (v1 === null || v0 === null) continue;
        const v = Math.abs(v1 - v0);
        if (v > best) { best = v; bo = o; }
      }
      if (bo !== null && best > 6) pts.push([px + nx * bo, py + ny * bo]);
    }
    let line = null;
    for (let it = 0; it < 3 && pts.length >= 8; it++) {
      const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length, my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      let sxx = 0, sxy = 0, syy = 0;
      for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), d = [Math.cos(th), Math.sin(th)];
      line = { p: [mx, my], d, ok: true };
      const res = pts.map(([x, y]) => Math.abs((x - mx) * -d[1] + (y - my) * d[0]));
      const lim = Math.max(1, [...res].sort((u, v) => u - v)[Math.floor(res.length * 0.7)] * 2);
      pts = pts.filter((_, i) => res[i] <= lim);
    }
    lines.push(line && pts.length >= 8 ? line : { p: a, d: [dx / len, dy / len], ok: false });
  }
  const out = [];
  for (let k = 0; k < 4; k++) {
    const L1 = lines[(k + 3) % 4], L2 = lines[k];
    const det = L1.d[0] * -L2.d[1] + L2.d[0] * L1.d[1];
    let c = q[k];
    if ((L1.ok || L2.ok) && Math.abs(det) > 0.2) {
      const t = ((L2.p[0] - L1.p[0]) * -L2.d[1] + L2.d[0] * (L2.p[1] - L1.p[1])) / det;
      const cand = [L1.p[0] + L1.d[0] * t, L1.p[1] + L1.d[1] * t];
      if (Math.hypot(cand[0] - c[0], cand[1] - c[1]) < diag * 0.025) c = cand;
    }
    out.push([c[0] / scale, c[1] / scale]);
  }
  return out;
}

// Kompatibel zur ersten Version: nur sichere Treffer, sonst null
export function detectQuad(src, srcW, srcH, maxSide = 512) {
  const r = findDocument(src, srcW, srcH, { maxSide });
  return r && r.confident ? r.quad : null;
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
      if (sx < -1 || sy < -1 || sx > sw || sy > sh) { const o = (y * W + x) * 4; od[o] = od[o + 1] = od[o + 2] = od[o + 3] = 255; continue; }
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
