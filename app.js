// FMRS Scan: Seiten aufnehmen, zuschneiden, PDF bauen, nach Dropbox /Posteingang hochladen.
import { CONFIG } from './config.js';
import * as S from './scan.js';
import { buildPdf } from './pdf.js';
import * as DB from './store.js';
import * as DBX from './dropbox.js';

export const VERSION = '1.2.0';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const SRC_MAX = 3000;          // Originalfotos auf max. 3000 px lange Seite
const OUT_MAX = Math.round(11.69 * CONFIG.DPI); // A4 lang bei Ziel-DPI
const DEF_OPTS = { native: true, filter: 'farbe', auto: true, lastFirma: null };
const opts = loadOpts();
// Felix, 31.10.: iPhone-Kamera ist viel schärfer als das Live-Bild, daher einmalig für alle auf Standard umstellen
if (!opts.v2) { opts.native = true; opts.v2 = true; saveOpts(); }

let pages = [];                // aktueller Scan
let stream = null, liveTimer = null;
let editing = null;            // { page, img, canvas, quad, scale, ox, oy, view }
let retakeId = null;

function loadOpts() { try { return Object.assign({}, DEF_OPTS, JSON.parse(localStorage.getItem('fmrs_scanner_opts') || '{}')); } catch { return Object.assign({}, DEF_OPTS); } }
function saveOpts() { try { localStorage.setItem('fmrs_scanner_opts', JSON.stringify(opts)); } catch {} }
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms);
}
function show(id) {
  $$('.screen').forEach(s => s.classList.toggle('on', s.id === id));
  if (id === 's-cam') startCamera(); else stopCamera();
  if (id === 's-review') renderReview();
  if (id === 's-list') renderList();
  if (id === 's-settings') renderSettings();
}
const current = () => $$('.screen').find(s => s.classList.contains('on'))?.id;

// ---------- Kamera ----------
const live = { q: null, miss: 0, stableSince: 0, armed: true, prev: null, sharp: [], busy: false, shooting: false, lastShot: 0 };
let track = null, torchOn = false, audioCtx = null;

async function startCamera() {
  updateThumb(); updateAutoChip();
  if (opts.native) { $('#nocam').classList.add('hidden'); setHint('Auslöser öffnet die iPhone-Kamera'); return; }
  if (stream) return;
  if (!navigator.mediaDevices?.getUserMedia) return noCamera();
  try {
    // höchste Auflösung anfragen, die das Handy liefert (4:3 wie die Fotokamera)
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 } },
    });
    if (current() !== 's-cam') { stopCamera(); return; }
    track = stream.getVideoTracks()[0];
    const v = $('#video'); v.srcObject = stream; await v.play().catch(() => {});
    $('#nocam').classList.add('hidden');
    // Dauer-Autofokus und automatische Belichtung, wo der Browser das kann
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      const adv = [];
      if (caps.focusMode && caps.focusMode.includes('continuous')) adv.push({ focusMode: 'continuous' });
      if (caps.exposureMode && caps.exposureMode.includes('continuous')) adv.push({ exposureMode: 'continuous' });
      if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes('continuous')) adv.push({ whiteBalanceMode: 'continuous' });
      if (adv.length) await track.applyConstraints({ advanced: adv }).catch(() => {});
      $('#torchBtn').classList.toggle('hidden', !caps.torch);
    } catch { $('#torchBtn').classList.add('hidden'); }
    torchOn = false; $('#torchBtn').classList.remove('on');
    // 'armed' bleibt erhalten: liegt noch dieselbe Seite da, nicht nochmal auslösen (erst nach Bewegung)
    Object.assign(live, { q: null, miss: 0, stableSince: 0, prev: null, sharp: [] });
    liveTimer = setInterval(liveDetect, 220);
  } catch (e) { noCamera(); }
}
function noCamera() { $('#nocam').classList.remove('hidden'); setHint('Foto aufnehmen oder aus Fotos wählen'); }
function stopCamera() {
  clearInterval(liveTimer); liveTimer = null;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; track = null; }
  const v = $('#video'); v.srcObject = null;
  const o = $('#overlay'); o.getContext('2d').clearRect(0, 0, o.width, o.height);
  setProgress(0);
}
async function toggleTorch() {
  if (!track) return;
  torchOn = !torchOn;
  try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch { torchOn = false; toast('Licht geht hier nicht'); }
  $('#torchBtn').classList.toggle('on', torchOn);
}
function setHint(t, ok) { const h = $('#hint'); h.textContent = t; h.classList.toggle('ok', !!ok); }
function setProgress(f) { $('#shutter').style.setProperty('--p', Math.max(0, Math.min(1, f)).toFixed(3)); }
function updateAutoChip() { const c = $('#autoChip'); c.textContent = opts.auto ? 'Auto an' : 'Auto aus'; c.classList.toggle('on', !!opts.auto); }

function videoMap() { // Video-Koordinaten -> Bildschirm (object-fit: cover)
  const v = $('#video'), W = v.clientWidth, H = v.clientHeight, vw = v.videoWidth, vh = v.videoHeight;
  const s = Math.max(W / vw, H / vh);
  return { s, ox: (W - vw * s) / 2, oy: (H - vh * s) / 2, W, H };
}
const maxDist = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));

// Bewegung und Schärfe aus einem kleinen Graubild
const statCanvas = S.makeCanvas(96, 72);
function frameStats(v) {
  const g = statCanvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(v, 0, 0, 96, 72);
  const d = g.getImageData(0, 0, 96, 72).data, gray = new Float32Array(96 * 72);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = d[j] * 0.3 + d[j + 1] * 0.59 + d[j + 2] * 0.11;
  let motion = 0;
  if (live.prev) { for (let i = 0; i < gray.length; i++) motion += Math.abs(gray[i] - live.prev[i]); motion /= gray.length; }
  live.prev = gray;
  let s = 0, s2 = 0, n = 0; // Varianz des Laplace-Filters = Schärfe
  for (let y = 1; y < 71; y++) for (let x = 1; x < 95; x++) {
    const i = y * 96 + x, l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - 96] - gray[i + 96];
    s += l; s2 += l * l; n++;
  }
  return { motion, sharp: s2 / n - (s / n) ** 2 };
}

function liveDetect() {
  const v = $('#video');
  if (!v.videoWidth || document.hidden || live.busy || live.shooting) return;
  live.busy = true;
  try {
    const now = performance.now(), vw = v.videoWidth, vh = v.videoHeight, diag = Math.hypot(vw, vh);
    const st = frameStats(v);
    const r = S.findDocument(v, vw, vh, { maxSide: 360, refine: false });
    if (r && r.confident) {
      live.miss = 0;
      if (live.q && maxDist(r.quad, live.q) < diag * 0.06) {
        const dev = maxDist(r.quad, live.q);
        live.q = live.q.map((p, i) => [p[0] * 0.55 + r.quad[i][0] * 0.45, p[1] * 0.55 + r.quad[i][1] * 0.45]); // glätten
        if (dev > diag * 0.015) live.stableSince = now;
      } else { live.q = r.quad; live.stableSince = now; }
    } else if (++live.miss >= 3) { live.q = null; live.stableSince = 0; }
    if (st.motion > 6) live.stableSince = now;
    if (st.motion > 14 || (!live.q && live.miss >= 4)) live.armed = true; // Blatt gewechselt
    live.sharp.push([now, st.sharp]); live.sharp = live.sharp.filter(([t]) => now - t < 3000);
    const sharpOk = st.sharp >= 0.7 * Math.max(...live.sharp.map(s => s[1]));

    // Anzeige
    const o = $('#overlay'), m = videoMap(), dpr = devicePixelRatio || 1;
    o.width = m.W * dpr; o.height = m.H * dpr;
    const g = o.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, m.W, m.H);
    const held = live.q && live.stableSince ? now - live.stableSince : 0;
    if (live.q) {
      g.beginPath(); live.q.forEach(([x, y], i) => g[i ? 'lineTo' : 'moveTo'](x * m.s + m.ox, y * m.s + m.oy)); g.closePath();
      g.fillStyle = '#f08a3c22'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#f08a3c'; g.stroke();
      if (!live.armed) setHint('Aufgenommen. Nächste Seite hinlegen', true);
      else setHint(opts.auto ? (sharpOk ? 'Blatt erkannt, ruhig halten …' : 'Blatt erkannt, wird scharf …') : 'Blatt erkannt', true);
    } else setHint(live.armed ? 'Blatt ins Bild halten' : 'Aufgenommen. Nächste Seite hinlegen', !live.armed);
    const AUTO_MS = 800;
    setProgress(opts.auto && live.armed && live.q ? held / AUTO_MS : 0);
    if (opts.auto && live.armed && live.q && held >= AUTO_MS && sharpOk && now - live.lastShot > 1500) {
      live.armed = false; setProgress(0);
      shoot(true);
    }
  } finally { live.busy = false; }
}

function signal() {
  const f = $('#flash'); f.classList.add('go'); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('go')));
  try { navigator.vibrate && navigator.vibrate(40); } catch {}
  try { // kurzer Klick
    if (!audioCtx) return;
    const o = audioCtx.createOscillator(), gn = audioCtx.createGain();
    o.frequency.value = 1400; gn.gain.setValueAtTime(0.08, audioCtx.currentTime); gn.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.06);
    o.connect(gn).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.07);
  } catch {}
}

async function shoot(auto) {
  if (opts.native || !stream) { $('#fileCam').click(); return; }
  const v = $('#video'); if (!v.videoWidth || live.shooting) return;
  live.shooting = true; live.lastShot = performance.now(); live.armed = false;
  const btn = $('#shutter'); btn.classList.add('busy');
  signal();
  try {
    const vw = v.videoWidth, vh = v.videoHeight, hint = live.q && live.q.map(p => p.slice());
    let canvas = null;
    // 1) echtes Foto über ImageCapture (volle Sensorauflösung, wo vorhanden)
    if (window.ImageCapture && track) {
      try {
        const blob = await new ImageCapture(track).takePhoto();
        const img = await S.loadImage(blob);
        if (img.naturalWidth > vw) canvas = S.scaledCanvas(img, img.naturalWidth, img.naturalHeight, SRC_MAX).canvas;
      } catch {}
    }
    // 2) sonst Standbild aus dem Video in voller Video-Auflösung
    if (!canvas) canvas = S.scaledCanvas(v, vw, vh, SRC_MAX).canvas;
    // Live-Ecken auf das große Bild umrechnen (nur bei gleichem Seitenverhältnis)
    let hq = null;
    if (hint && Math.abs(canvas.width / canvas.height - vw / vh) < 0.02) { const k = canvas.width / vw; hq = hint.map(([x, y]) => [x * k, y * k]); }
    await addPageFromCanvas(canvas, hq);
  } finally { btn.classList.remove('busy'); live.shooting = false; }
}

async function addFiles(files) {
  if (!files || !files.length) return;
  for (const file of files) {
    try {
      const img = await S.loadImage(file);
      const { canvas } = S.scaledCanvas(img, img.naturalWidth, img.naturalHeight, SRC_MAX);
      await addPageFromCanvas(canvas, null);
    } catch (e) { toast('Bild konnte nicht gelesen werden'); }
  }
}

// Ecken im großen Bild bestimmen: eigene Erkennung, sonst Live-Ecken nachverfeinert, sonst Vorschlag/ganzes Bild
function locate(canvas, hint) {
  const W = canvas.width, H = canvas.height;
  const r = S.findDocument(canvas, W, H, { maxSide: 640 });
  if (r && r.confident) {
    if (!hint || maxDist(r.quad, hint) < Math.hypot(W, H) * 0.08) return { quad: r.quad, sure: true };
  }
  if (hint) return { quad: S.refineQuad(canvas, W, H, hint), sure: true };
  if (r && r.score > 0.45) return { quad: r.quad, sure: false };
  return { quad: S.defaultQuad(W, H, 0), sure: false };
}

async function addPageFromCanvas(canvas, hint) {
  const { quad, sure } = locate(canvas, hint);
  const src = await S.canvasToBlob(canvas, 'image/jpeg', 0.9);
  let page;
  if (retakeId && pages.find(p => p.id === retakeId)) {
    page = pages.find(p => p.id === retakeId);
    Object.assign(page, { src, w: canvas.width, h: canvas.height, quad, detected: sure, rot: 0 });
    retakeId = null;
  } else {
    page = { id: uid(), order: Date.now(), src, w: canvas.width, h: canvas.height, quad, detected: sure, rot: 0, filter: opts.filter };
    pages.push(page);
  }
  await processPage(page, canvas);
  await DB.put('pages', page);
  updateThumb();
  if (!sure) { toast('Rand nicht sicher erkannt, bitte Ecken prüfen'); openEditor(page); }
  else if (current() === 's-cam') toast(`Seite ${pages.length} ✓`, 1200);
  else if (current() === 's-edit') openEditor(page);
}

// Ergebnisbild einer Seite neu rechnen
async function processPage(page, srcCanvas, quality = 0.74, maxLong = OUT_MAX) {
  if (!srcCanvas) {
    const img = await S.loadImage(page.src);
    srcCanvas = S.makeCanvas(img.naturalWidth, img.naturalHeight);
    srcCanvas.getContext('2d').drawImage(img, 0, 0);
  }
  let c = S.warp(srcCanvas, page.quad, maxLong);
  c = S.rotate(c, page.rot);
  S.applyFilter(c, page.filter);
  page.out = await S.canvasToBlob(c, 'image/jpeg', page.filter === 'sw' ? Math.min(quality, 0.62) : quality);
  page.ow = c.width; page.oh = c.height;
  const { canvas: t } = S.scaledCanvas(c, c.width, c.height, 260);
  page.thumb = t.toDataURL('image/jpeg', 0.7);
  return page;
}

function updateThumb() {
  $('#pageCount').textContent = pages.length;
  const last = pages[pages.length - 1];
  const im = $('#thumbImg');
  if (last && last.thumb) im.src = last.thumb; else im.removeAttribute('src');
  $('#thumbBtn').style.visibility = pages.length ? 'visible' : 'hidden';
}

// ---------- Editor ----------
async function openEditor(page) {
  const img = await S.loadImage(page.src);
  editing = { page, img, quad: page.quad.map(p => p.slice()), view: 'crop', dirty: false };
  $('#editTitle').textContent = `Seite ${pages.indexOf(page) + 1}`;
  $$('#s-edit .chip.f').forEach(b => b.classList.toggle('on', b.dataset.filter === page.filter));
  if (current() !== 's-edit') show('s-edit');
  setView('crop');
}
function setView(v) {
  editing.view = v;
  const crop = v === 'crop';
  $('#editCanvas').classList.toggle('hidden', !crop);
  $('#editQuad').classList.toggle('hidden', !crop);
  $$('.handle').forEach(h => h.classList.toggle('hidden', !crop));
  $('#editResult').classList.toggle('hidden', crop);
  $('#viewToggle').textContent = crop ? 'Ergebnis' : 'Zuschnitt';
  if (crop) layoutEditor(); else showResult();
}
async function showResult() {
  const p = editing.page;
  if (editing.dirty || !p.out) await busy(async () => { p.quad = editing.quad.map(q => q.slice()); await processPage(p); editing.dirty = false; });
  const r = $('#editResult');
  if (r.dataset.url) URL.revokeObjectURL(r.dataset.url);
  r.dataset.url = URL.createObjectURL(p.out); r.src = r.dataset.url;
}
async function busy(fn) {
  $('#busy').classList.remove('hidden');
  await new Promise(r => setTimeout(r, 30));
  try { await fn(); } finally { $('#busy').classList.add('hidden'); }
}
function layoutEditor() {
  if (!editing) return;
  const area = $('#editArea'), W = area.clientWidth, H = area.clientHeight, pad = 22;
  const { img } = editing, iw = img.naturalWidth, ih = img.naturalHeight;
  const s = Math.min((W - 2 * pad) / iw, (H - 2 * pad) / ih);
  const cw = iw * s, ch = ih * s, ox = (W - cw) / 2, oy = (H - ch) / 2;
  Object.assign(editing, { scale: s, ox, oy });
  const dpr = devicePixelRatio || 1;
  for (const id of ['#editCanvas', '#editQuad']) {
    const c = $(id); c.width = cw * dpr; c.height = ch * dpr;
    Object.assign(c.style, { left: ox + 'px', top: oy + 'px', width: cw + 'px', height: ch + 'px' });
  }
  $('#editCanvas').getContext('2d').drawImage(img, 0, 0, cw * dpr, ch * dpr);
  drawQuad();
}
function drawQuad() {
  const { quad, scale, ox, oy } = editing, dpr = devicePixelRatio || 1;
  const c = $('#editQuad'), g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = '#000a'; g.fillRect(0, 0, c.width, c.height);
  g.beginPath(); quad.forEach(([x, y], i) => g[i ? 'lineTo' : 'moveTo'](x * scale, y * scale)); g.closePath();
  g.globalCompositeOperation = 'destination-out'; g.fill(); g.globalCompositeOperation = 'source-over';
  g.lineWidth = 2; g.strokeStyle = '#f08a3c'; g.stroke();
  $$('.handle').forEach(h => { const [x, y] = quad[+h.dataset.i]; h.style.left = (ox + x * scale) + 'px'; h.style.top = (oy + y * scale) + 'px'; });
}
function drawLoupe(i, clientX) {
  const l = $('#loupe'), g = l.getContext('2d'), { img, quad } = editing;
  const [x, y] = quad[i], z = 2.6 / editing.scale * (l.width / 140), r = l.width / 2;
  l.style.display = 'block';
  l.style.left = clientX < innerWidth / 2 ? '' : '10px';
  l.style.right = clientX < innerWidth / 2 ? '10px' : '';
  g.fillStyle = '#000'; g.fillRect(0, 0, l.width, l.height);
  const sw = l.width / (2.6 * editing.scale);
  g.drawImage(img, x - sw / 2, y - sw / 2, sw, sw, 0, 0, l.width, l.height);
  g.strokeStyle = '#f08a3c'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(r, r - 14); g.lineTo(r, r + 14); g.moveTo(r - 14, r); g.lineTo(r + 14, r); g.stroke();
  void z;
}
function initHandles() {
  $$('.handle').forEach(h => {
    h.addEventListener('pointerdown', e => {
      e.preventDefault(); h.setPointerCapture(e.pointerId);
      const i = +h.dataset.i, start = editing.quad[i].slice(), sx = e.clientX, sy = e.clientY;
      const move = ev => {
        const { img, scale } = editing;
        const x = Math.min(img.naturalWidth, Math.max(0, start[0] + (ev.clientX - sx) / scale));
        const y = Math.min(img.naturalHeight, Math.max(0, start[1] + (ev.clientY - sy) / scale));
        editing.quad[i] = [x, y]; editing.dirty = true; drawQuad(); drawLoupe(i, ev.clientX);
      };
      const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); $('#loupe').style.display = 'none'; };
      h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
    });
  });
}
async function editOk() {
  const p = editing.page;
  if (editing.dirty || !p.out) await busy(async () => { p.quad = editing.quad.map(q => q.slice()); p.detected = true; await processPage(p); });
  p.detected = true;
  await DB.put('pages', p);
  editing = null; updateThumb();
  show(pages.length > 1 || $('#s-review').dataset.from === 'review' ? 's-review' : 's-cam');
}
async function setFilter(f) {
  const p = editing.page; p.filter = f;
  $$('#s-edit .chip.f').forEach(b => b.classList.toggle('on', b.dataset.filter === f));
  editing.dirty = true;
  if (editing.view !== 'result') setView('result'); else await showResult();
}
async function rotatePage() { editing.page.rot = (editing.page.rot + 1) % 4; editing.dirty = true; if (editing.view !== 'result') setView('result'); else await showResult(); }

// ---------- Prüfen ----------
const sel = { firma: null, art: null };
function renderReview() {
  $('#s-review').dataset.from = 'review';
  const box = $('#pages'); box.innerHTML = '';
  pages.forEach((p, i) => {
    const d = document.createElement('div'); d.className = 'pg';
    d.innerHTML = `<img alt=""><span class="n">${i + 1}</span>${p.detected ? '' : '<span class="w">prüfen</span>'}<div class="ctl"><button data-m="-1" aria-label="nach vorn">‹</button><button data-del aria-label="löschen">✕</button><button data-m="1" aria-label="nach hinten">›</button></div>`;
    d.querySelector('img').src = p.thumb;
    d.querySelector('img').onclick = () => openEditor(p);
    d.querySelectorAll('[data-m]').forEach(b => b.onclick = () => movePage(i, +b.dataset.m));
    d.querySelector('[data-del]').onclick = () => deletePage(p);
    box.appendChild(d);
  });
  const n = pages.length;
  $('#reviewTitle').textContent = n === 1 ? '1 Seite' : `${n} Seiten`;
  $('#split').closest('.switch').classList.toggle('hidden', n < 2);
  updateSend();
}
function updateSend() {
  $$('#firma button').forEach(b => b.classList.toggle('on', b.dataset.v === sel.firma));
  $$('#art button').forEach(b => b.classList.toggle('on', b.dataset.v === sel.art));
  const ok = pages.length > 0 && !!sel.firma;
  $('#sendBtn').disabled = !ok;
  $('#sendBtn').textContent = !pages.length ? 'Keine Seiten' : !sel.firma ? 'Erst Firma wählen' : `Hochladen · ${FIRMA_TXT[sel.firma]}`;
  const bytes = pages.reduce((s, p) => s + (p.out ? p.out.size : 0), 0);
  $('#sizeInfo').textContent = pages.length ? `ca. ${(bytes / 1048576).toFixed(1)} MB` : '';
}
async function movePage(i, d) {
  const j = i + d; if (j < 0 || j >= pages.length) return;
  [pages[i], pages[j]] = [pages[j], pages[i]];
  pages.forEach((p, k) => p.order = k);
  await Promise.all(pages.map(p => DB.put('pages', p)));
  renderReview();
}
async function deletePage(p) {
  if (!confirm('Diese Seite löschen?')) return;
  pages = pages.filter(x => x !== p); await DB.del('pages', p.id);
  updateThumb();
  if (current() === 's-edit') { editing = null; show(pages.length ? 's-review' : 's-cam'); } else renderReview();
}
async function discardAll() {
  if (pages.length && !confirm('Alle Seiten dieses Scans verwerfen?')) return;
  pages = []; await DB.clear('pages'); resetForm(); updateThumb(); show('s-cam');
}
function resetForm() { sel.firma = opts.lastFirma || null; sel.art = null; $('#note').value = ''; $('#split').checked = false; $('#s-review').dataset.from = ''; }

// ---------- Dateiname, Abholzeit ----------
function berlinParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const o = {}; f.formatToParts(d).forEach(p => o[p.type] = p.value); return o;
}
export function fileBase(d, kz, art, idx) {
  const p = berlinParts(d);
  return `${p.year}-${p.month}-${p.day}_${p.hour}${p.minute}${p.second}_${kz}${art ? '_' + art : ''}_scan${idx ? '-' + idx : ''}`;
}
export function nextRun(d = new Date()) {
  const p = berlinParts(d), now = +p.hour * 60 + +p.minute;
  for (const t of CONFIG.RUNS) { const [h, m] = t.split(':').map(Number); if (h * 60 + m > now) return `heute um ${h}:${String(m).padStart(2, '0')}`; }
  const [h, m] = CONFIG.RUNS[0].split(':').map(Number);
  return `morgen um ${h}:${String(m).padStart(2, '0')}`;
}
const FIRMA_TXT = { FMRS: 'FMRS 24', FAS: 'Füller Air Services', PRIV: 'Privat', UNKLAR: 'Weiß nicht' };

// ---------- PDF bauen und in die Warteschlange ----------
async function makePdf(group, title) {
  const toPage = async p => ({ jpeg: new Uint8Array(await p.out.arrayBuffer()), w: p.ow, h: p.oh });
  let blob = buildPdf(await Promise.all(group.map(toPage)), { title });
  // zu groß: kleiner rechnen
  const steps = [[0.6, OUT_MAX], [0.55, Math.round(OUT_MAX * 0.8)], [0.5, Math.round(OUT_MAX * 0.65)]];
  for (const [q, ml] of steps) {
    if (blob.size <= CONFIG.MAX_DOC_BYTES) break;
    for (const p of group) await processPage(p, null, q, ml);
    blob = buildPdf(await Promise.all(group.map(toPage)), { title });
  }
  return blob;
}
async function send() {
  if (!pages.length || !sel.firma) return;
  const btn = $('#sendBtn'); btn.disabled = true; btn.textContent = 'PDF wird gebaut …';
  try {
    const now = new Date();
    const groups = $('#split').checked && pages.length > 1 ? pages.map(p => [p]) : [pages.slice()];
    const note = $('#note').value.trim();
    for (let i = 0; i < groups.length; i++) {
      const base = fileBase(now, sel.firma, sel.art, groups.length > 1 ? i + 1 : 0);
      const pdf = await makePdf(groups[i], base);
      const p = berlinParts(now);
      const txt = note ? [
        'Scanner-App FMRS24',
        `Datei: ${base}.pdf`,
        `Firma: ${FIRMA_TXT[sel.firma]}`,
        `Art: ${sel.art || 'nicht angegeben'}`,
        `Seiten: ${groups[i].length}`,
        `Aufgenommen: ${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`,
        `Notiz: ${note}`, '',
      ].join('\n') : null;
      await DB.put('docs', { id: uid(), name: base + '.pdf', base, firma: sel.firma, art: sel.art, note, pages: groups[i].length, created: now.getTime(), status: 'wartet', pdf, size: pdf.size, txt, txtDone: false });
    }
    opts.lastFirma = sel.firma; saveOpts();
    pages = []; await DB.clear('pages'); resetForm(); updateThumb();
    show('s-cam');
    toast(groups.length > 1 ? `${groups.length} Dokumente, werden hochgeladen …` : 'Wird hochgeladen …', 1500);
    processQueue().then(r => {
      if (!r) return;
      if (r.waiting) toast(r.auth ? 'Gespeichert. Wartet: Dropbox nicht verbunden' : 'Gespeichert. Wartet auf Netz, geht später von selbst raus', 3500);
      else if (r.uploaded) toast(`Hochgeladen ✓  Abholung ${nextRun()}`, 3000);
    });
  } catch (e) {
    toast('Fehler beim PDF: ' + e.message, 5000);
  } finally { updateSend(); }
}

// ---------- Warteschlange ----------
let queueBusy = false, queueAgain = false;
async function processQueue() {
  if (queueBusy) { queueAgain = true; return null; } queueBusy = true; queueAgain = false;
  let uploaded = 0, waiting = 0, authProblem = false, netProblem = false;
  try {
    const docs = (await DB.all('docs')).filter(d => d.status !== 'hochgeladen').sort((a, b) => a.created - b.created);
    if (docs.length) await refreshQueueChip();
    for (const d of docs) {
      if (!DBX.isConnected()) { authProblem = true; waiting++; continue; }
      if (authProblem || netProblem) { waiting++; continue; }
      try {
        if (d.txt && !d.txtDone) {
          await DBX.upload(`${CONFIG.FOLDER}/${d.base}.txt`, new Blob([d.txt], { type: 'text/plain;charset=utf-8' }));
          d.txtDone = true; await DB.put('docs', d);
        }
        const meta = await DBX.upload(`${CONFIG.FOLDER}/${d.name}`, d.pdf);
        Object.assign(d, { status: 'hochgeladen', uploaded: Date.now(), path: meta && meta.path_display, pdf: null, error: null });
        await DB.put('docs', d); uploaded++;
      } catch (e) {
        d.error = e.message; await DB.put('docs', d); waiting++;
        if (e instanceof DBX.AuthError) authProblem = true; else netProblem = true;
      }
    }
    await prune();
  } finally { queueBusy = false; }
  if (queueAgain) return processQueue(); // während des Hochladens kam ein neues Dokument dazu
  await refreshQueueChip();
  if (current() === 's-list') renderList();
  return { uploaded, waiting, auth: authProblem };
}
async function prune() { // hochgeladene Einträge: nur die letzten 40, max. 60 Tage
  const docs = (await DB.all('docs')).filter(d => d.status === 'hochgeladen').sort((a, b) => b.created - a.created);
  const old = Date.now() - 60 * 864e5;
  for (const [i, d] of docs.entries()) if (i >= 40 || d.created < old) await DB.del('docs', d.id);
}
async function refreshQueueChip() {
  const n = (await DB.all('docs')).filter(d => d.status !== 'hochgeladen').length;
  const c = $('#queueChip');
  c.textContent = n ? `⇡ ${n} wartet` : 'Verlauf';
  c.classList.toggle('warn', n > 0);
  const up = queueBusy && n > 0;
  $('#queueBadge').textContent = n ? (up ? `⇡ ${n} lädt hoch` : `⇡ ${n} wartet`) : '';
  $('#queueBadge').classList.toggle('hidden', !n);
}
async function renderList() {
  $('#connWarn').classList.toggle('hidden', DBX.isConnected());
  const docs = (await DB.all('docs')).sort((a, b) => b.created - a.created);
  const ul = $('#docList'); ul.innerHTML = '';
  if (!docs.length) { ul.innerHTML = '<li class="mut">Noch keine Scans.</li>'; return; }
  for (const d of docs) {
    const li = document.createElement('li');
    const p = berlinParts(new Date(d.created));
    const st = d.status === 'hochgeladen' ? '<span class="st ok">hochgeladen</span>' : '<span class="st wait">wartet auf Upload</span>';
    li.innerHTML = `<div><div class="nm"></div><div class="meta"></div></div>${st}`;
    li.querySelector('.nm').textContent = d.name;
    li.querySelector('.meta').textContent = `${p.day}.${p.month}. ${p.hour}:${p.minute} · ${d.pages} S. · ${(d.size / 1048576).toFixed(1)} MB${d.note ? ' · Notiz' : ''}${d.status !== 'hochgeladen' && d.error ? ' · ' + d.error : ''}`;
    ul.appendChild(li);
  }
}

// ---------- Einstellungen ----------
function renderSettings() {
  const c = DBX.isConnected();
  $('#dbxState').textContent = c ? 'Verbunden. Scans gehen in deine Dropbox.' : 'Nicht verbunden.';
  $('#connectBtn').textContent = c ? 'Neu verbinden' : 'Mit Dropbox verbinden';
  $('#disconnectBtn').classList.toggle('hidden', !c);
  $('#appKey').value = DBX.appKey();
  $('#keyBox').classList.toggle('hidden', !!CONFIG.DROPBOX_APP_KEY);
  $('#optNative').checked = !!opts.native;
  $('#optAuto').checked = !!opts.auto;
  $$('#optFilter button').forEach(b => b.classList.toggle('on', b.dataset.v === opts.filter));
  $('#folderName').textContent = CONFIG.FOLDER;
  $('#runTimes').textContent = CONFIG.RUNS.join(', ');
  $('#redirUri').textContent = DBX.redirectUri();
  $('#ver').textContent = VERSION;
}
function keyFromInput() { const k = $('#appKey').value.trim(); if (k) DBX.setAppKey(k); return DBX.appKey(); }
async function connect() {
  if (!keyFromInput()) { toast('Bitte zuerst den App-Schlüssel eintragen'); return; }
  try { await DBX.startLogin(); } catch (e) { toast(e.message); }
}
async function manualStart() {
  if (!keyFromInput()) { toast('Bitte zuerst den App-Schlüssel eintragen'); return; }
  window.open(await DBX.manualLoginUrl(), '_blank');
}
async function manualFinish() {
  const code = $('#manualCode').value.trim(); if (!code) return;
  try { await DBX.exchangeCode(code, false); toast('Dropbox verbunden'); $('#manualCode').value = ''; renderSettings(); processQueue(); }
  catch (e) { toast('Hat nicht geklappt: ' + e.message, 5000); }
}

// ---------- Neue Version? ----------
let lastUpdateCheck = 0;
async function checkUpdate(force) {
  if (!force && Date.now() - lastUpdateCheck < 5 * 60000) return;
  lastUpdateCheck = Date.now();
  try {
    const j = await (await fetch('version.json?t=' + Date.now(), { cache: 'no-store' })).json();
    if (j.version && j.version !== VERSION) $('#updateBar').classList.remove('hidden');
  } catch {}
}

// ---------- Start ----------
const ACT = {
  shoot: () => shoot(false), torch: toggleTorch,
  autoToggle: () => { opts.auto = !opts.auto; saveOpts(); updateAutoChip(); toast(opts.auto ? 'Automatisch auslösen an' : 'Automatisch auslösen aus', 1400); },
  update: () => { navigator.serviceWorker?.getRegistration().then(r => r && r.update()).finally(() => setTimeout(() => location.reload(), 300)); },
  review: () => pages.length && show('s-review'), cam: () => show('s-cam'),
  list: () => { $('#doneBox').classList.add('hidden'); show('s-list'); }, settings: () => show('s-settings'),
  photo: () => $('#fileCam').click(), library: () => $('#fileLib').click(),
  editCancel: () => { const p = editing?.page; editing = null; show(p && p.out ? (pages.length > 1 ? 's-review' : 's-cam') : 's-cam'); },
  toggleView: () => setView(editing.view === 'crop' ? 'result' : 'crop'),
  autoQuad: () => { const { img } = editing; const r = S.findDocument(img, img.naturalWidth, img.naturalHeight, { maxSide: 640 }); if (r && r.score > 0.45) { editing.quad = r.quad; editing.dirty = true; setView('crop'); if (!r.confident) toast('Unsicher, bitte Ecken prüfen'); } else toast('Kein Blatt gefunden'); },
  fullQuad: () => { const { img } = editing; editing.quad = S.defaultQuad(img.naturalWidth, img.naturalHeight, 0); editing.dirty = true; setView('crop'); },
  retake: () => { retakeId = editing.page.id; editing = null; live.armed = true; show('s-cam'); toast('Seite neu aufnehmen'); },
  delPage: () => deletePage(editing.page), rotate: rotatePage, editOk,
  discard: discardAll, send, retry: () => processQueue().then(r => toast(r.waiting ? 'Noch nicht geklappt, versuche es später wieder' : 'Alles hochgeladen')),
  connect, manualStart, manualFinish,
  disconnect: () => { if (confirm('Dropbox wirklich trennen?')) { DBX.disconnect(); renderSettings(); } },
};

async function init() {
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (b && ACT[b.dataset.act]) ACT[b.dataset.act]();
    const f = e.target.closest('[data-filter]'); if (f && editing) setFilter(f.dataset.filter);
  });
  $$('#firma button').forEach(b => b.onclick = () => { sel.firma = b.dataset.v; updateSend(); });
  $$('#art button').forEach(b => b.onclick = () => { sel.art = sel.art === b.dataset.v ? null : b.dataset.v; updateSend(); });
  $$('#optFilter button').forEach(b => b.onclick = () => { opts.filter = b.dataset.v; saveOpts(); renderSettings(); });
  $('#optNative').onchange = e => { opts.native = e.target.checked; saveOpts(); };
  $('#optAuto').onchange = e => { opts.auto = e.target.checked; saveOpts(); };
  // Ton für den Auslöser darf erst nach einer Berührung starten (iOS)
  document.addEventListener('pointerdown', () => { try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch {} }, { passive: true });
  $('#fileCam').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
  $('#fileLib').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
  initHandles();
  addEventListener('resize', () => { if (editing && editing.view === 'crop') layoutEditor(); });
  addEventListener('online', () => processQueue());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { processQueue(); checkUpdate(); } });
  setInterval(() => { if (!document.hidden) processQueue(); }, 60000);

  // Warteschlange vor dem Aufräumen durch den Browser schützen
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  // offener Scan von vorher wiederherstellen
  pages = (await DB.all('pages')).sort((a, b) => a.order - b.order);
  live.armed = pages.length === 0; // App mit offenen Seiten neu geöffnet: erst nach Blattwechsel auslösen
  const r = await DBX.handleRedirect();
  if (r) { toast(r.ok ? 'Dropbox verbunden' : 'Dropbox: ' + r.msg, 4000); }
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  resetForm();
  show(r ? 's-settings' : 's-cam');
  processQueue().then(res => { if (res && res.uploaded && !res.waiting) toast(`Wartende Scans hochgeladen ✓`, 2500); });
  checkUpdate();
}
window.__scanner = { S, pages: () => pages, processQueue, nextRun, fileBase, DB, DBX, VERSION, checkUpdate, live };
init();
