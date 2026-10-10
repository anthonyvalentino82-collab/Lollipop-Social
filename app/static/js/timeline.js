// Mirror of app/pipeline/timeline.py — keep the two files in sync so the
// preview matches the exported MP4.

export const ease = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

export function buildCaptionLines(words, maxWords = 3) {
  const lines = []; let cur = [];
  words.forEach((w, i) => {
    cur.push(w);
    const nxt = words[i + 1];
    const sentenceEnd = /[.!?,;:]$/.test(w.w);
    const pause = nxt && nxt.start - w.end > 0.6;
    if (cur.length >= maxWords || sentenceEnd || pause || !nxt) {
      lines.push({ id: `l${lines.length}`, start: cur[0].start, end: cur[cur.length - 1].end, words: cur.map((x) => ({ ...x })) });
      cur = [];
    }
  });
  return lines;
}

export function captionAt(lines, t) {
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i], nxt = lines[i + 1];
    let holdEnd = ln.end + 0.25;
    if (nxt) holdEnd = nxt.start - ln.end < 0.5 ? nxt.start : Math.min(holdEnd, nxt.start);
    if (ln.start <= t && t < holdEnd) {
      let active = 0;
      ln.words.forEach((w, j) => { if (w.start <= t) active = j; });
      return { line: ln, active, since: t - ln.start };
    }
  }
  return null;
}

export function zoomScaleAt(zoom, t) {
  if (!zoom || zoom.enabled === false) return 1;
  let best = 1;
  for (const seg of zoom.segments || []) {
    const s = seg.start, e = seg.end, rin = seg.rin ?? 0.4, rout = seg.rout ?? 0.5;
    if (t < s || t > e + rout) continue;
    const env = t < s + rin ? ease((t - s) / rin) : (t <= e ? 1 : 1 - ease((t - e) / rout));
    best = Math.max(best, 1 + (seg.scale - 1) * env);
  }
  return best;
}

export function faceAt(track, t) {
  if (!track || !track.length) return [0.5, 0.4];
  if (t <= track[0][0]) return [track[0][1], track[0][2]];
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i], b = track[i + 1];
    if (a[0] <= t && t <= b[0]) {
      const k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    }
  }
  const l = track[track.length - 1];
  return [l[1], l[2]];
}

export function cropRect(srcW, srcH, zoom, track, t) {
  const aspect = 9 / 16;
  let w, h;
  if (srcW / srcH > aspect) { h = srcH; w = h * aspect; } else { w = srcW; h = w / aspect; }
  const s = zoomScaleAt(zoom, t);
  w /= s; h /= s;
  const [fx, fy] = faceAt(track, t);
  const cx = fx * srcW, cy = fy * srcH + 0.1 * h;
  const x = Math.min(Math.max(cx - w / 2, 0), srcW - w);
  const y = Math.min(Math.max(cy - h / 2, 0), srcH - h);
  return [x, y, w, h];
}

export function brollAt(broll, t) {
  return (broll || []).find((b) => !b.removed && b.start <= t && t < b.end) || null;
}

export function parseHeadline(text) {
  const lines = []; let accent = false;
  for (const rawLine of text.split("\n")) {
    const words = [];
    for (const tok of rawLine.split(/\s+/).filter(Boolean)) {
      const starts = tok.startsWith("*"), ends = tok.endsWith("*") && tok.length > 1;
      const word = tok.replace(/^\*+|\*+$/g, "");
      if (starts) accent = true;
      if (word) words.push([word, accent]);
      if (ends) accent = false;
    }
    lines.push(words);
  }
  return lines;
}

export function wrapWords(words, measure, maxWidth) {
  const out = []; let cur = [];
  for (const w of words) {
    if (cur.length && measure([...cur, w]) > maxWidth) { out.push(cur); cur = [w]; } else cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}

// Retime a caption line after its text was edited: spread the new words over
// the line's original time span, weighted by word length.
export function retimeLine(line, text) {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const span = line.end - line.start;
  let t = line.start;
  const words = parts.map((p) => {
    const d = span * (p.length + 1) / total;
    const w = { w: p, start: +t.toFixed(3), end: +(t + d * 0.92).toFixed(3) };
    t += d;
    return w;
  });
  return { ...line, words };
}
