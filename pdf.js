// Minimaler PDF-Schreiber: jede Seite = ein JPEG-Bild (ohne fremde Bibliothek).
// pages: [{ jpeg: Uint8Array, w: Pixel, h: Pixel }]
export function buildPdf(pages, { title = 'Scan', created = new Date() } = {}) {
  const enc = new TextEncoder();
  const chunks = []; let len = 0;
  const offsets = [];
  const push = b => { if (typeof b === 'string') b = enc.encode(b); chunks.push(b); len += b.length; };
  const obj = (num, body) => { offsets[num] = len; push(`${num} 0 obj\n`); body(); push('\nendobj\n'); };

  push('%PDF-1.4\n'); // Kopf, dann Binär-Marker
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const n = pages.length;
  // Objekte: 1 Katalog, 2 Seitenbaum, 3 Info, je Seite: Seite, Inhalt, Bild
  const pageObj = i => 4 + i * 3, contObj = i => 5 + i * 3, imgObj = i => 6 + i * 3;
  const pdfDate = d => {
    const p = x => String(x).padStart(2, '0');
    return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };
  const esc = s => String(s).replace(/[\\()]/g, m => '\\' + m).replace(/[^\x20-\x7e]/g, '?');

  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`));
  obj(3, () => push(`<< /Title (${esc(title)}) /Producer (FMRS24 Scanner) /CreationDate (${pdfDate(created)}) >>`));
  pages.forEach((p, i) => {
    // Seitengröße: lange Seite immer A4-Höhe (841,89 pt), egal wie hoch die Kamera auflöst
    const s = 841.89 / Math.max(p.w, p.h);
    const W = +(p.w * s).toFixed(2), H = +(p.h * s).toFixed(2);
    obj(pageObj(i), () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${imgObj(i)} 0 R >> /ProcSet [/PDF /ImageC /ImageB] >> /Contents ${contObj(i)} 0 R >>`));
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(contObj(i), () => { push(`<< /Length ${content.length} >>\nstream\n`); push(content); push('\nendstream'); });
    obj(imgObj(i), () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      push(p.jpeg); push('\nendstream');
    });
  });
  const total = 4 + n * 3;
  const xref = len;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(x);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}
