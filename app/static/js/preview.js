// Live preview: draws the same layers as the exporter onto a canvas and lets
// you drag / pinch the headline, captions and logo.
import { brollAt, captionAt, cropRect, ease, effectiveCuts, keptSegments, nextKept, parseHeadline, wrapWords } from "./timeline.js";
import { PersonMasker } from "./segment.js";

const OW = 1080, OH = 1920;

export class Preview {
  constructor(canvas, video, { onChange, onTap, onTime }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.CW = canvas.width; this.CH = canvas.height;
    this.k = this.CW / OW;
    this.video = video;
    this.onChange = onChange; this.onTap = onTap; this.onTime = onTime;
    this.p = null;
    this.boxes = {};
    this.selected = null; this.selectedUntil = 0;
    this.ghostCaptions = false;
    this.logoImg = null;
    this.wm = new Image();
    this.wm.onload = () => this.draw();
    this.wm.src = "/static/brand/watermark.png";
    this.brollVids = {};
    this.person = document.createElement("canvas");
    this.person.width = this.CW; this.person.height = this.CH;
    this.pctx = this.person.getContext("2d");
    this.masker = new PersonMasker();
    this.frameNo = 0;
    this.metricsCache = {};
    this.pointers = new Map();
    this.gesture = null;
    this.audio = null;

    // iPhone Safari stops decoding the picture of a video that isn't on the page (the sound and
    // the clock keep going, so the speaker "freezes" while captions keep moving). Keep the main
    // video inside the preview, hidden underneath the canvas, like the B-roll players.
    video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover";
    this.holder().appendChild(video);

    const redraw = () => this.draw(true);
    video.addEventListener("seeked", redraw);
    video.addEventListener("loadeddata", redraw);
    // iPhone Safari often won't decode a frame until something asks for one: nudge it with a
    // tiny seek once the video's size is known, so the preview shows a picture without pressing play.
    video.addEventListener("loadedmetadata", () => {
      if (video.paused && this.p) video.currentTime = Math.max(0.01, (this.p.trim?.start || 0) + 0.01);
      redraw();
    });
    video.addEventListener("play", () => this.loop());
    video.addEventListener("pause", () => { this.syncMusic(); this.draw(true); });
    this.bindGestures();
  }

  setProject(p) {
    this.p = p;
    this.draw(true);
  }

  async setLogo(url) {
    if (!url) { this.logoImg = null; this.draw(); return; }
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {});
    this.logoImg = img;
    this.draw();
  }

  // Players live inside the preview, underneath the canvas (iPhone won't decode hidden videos).
  holder() {
    const holder = document.getElementById("brollHolder") || Object.assign(document.createElement("div"), { id: "brollHolder" });
    holder.style.cssText = "position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none";
    if (holder.parentElement !== this.canvas.parentElement) this.canvas.parentElement.insertBefore(holder, this.canvas);
    this.canvas.style.position = "relative";
    this.canvas.style.zIndex = "1";
    return holder;
  }

  setBroll(list, base) {
    // iPhone Safari won't play videos that are off-screen or invisible, so the
    // B-roll players sit inside the preview, hidden underneath the canvas.
    const holder = this.holder();
    for (const [id, v] of Object.entries(this.brollVids)) {
      if (!list.find((b) => b.id === id)) { v.pause(); v.remove(); delete this.brollVids[id]; }
    }
    for (const b of list) {
      if (this.brollVids[b.id]) continue;
      const v = document.createElement("video");
      Object.assign(v, { muted: true, playsInline: true, preload: "auto", src: `${base}/${b.file}` });
      v.setAttribute("playsinline", "");
      v.setAttribute("muted", "");
      v.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover";
      v.addEventListener("seeked", () => this.draw());
      v.addEventListener("loadeddata", () => this.draw());
      holder.appendChild(v);
      this.brollVids[b.id] = v;
    }
  }

  // ---- music preview (Web Audio so volume works on iPhone) ----
  setMusic(url) {
    if (this.audio) { this.audio.pause(); this.audio = null; }
    if (!url) return;
    this.audio = new Audio(url);
    this.audio.loop = true;
    this.audio.crossOrigin = "anonymous";
    this.audioWired = false;
  }

  wireAudio() {
    if (!this.audio || this.audioWired) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.actx = this.actx || new Ctx();
    const src = this.actx.createMediaElementSource(this.audio);
    this.gain = this.actx.createGain();
    src.connect(this.gain).connect(this.actx.destination);
    this.audioWired = true;
  }

  syncMusic() {
    const m = this.p && this.p.music;
    if (!this.audio || !m) return;
    const playing = !this.video.paused && m.enabled !== false;
    if (!playing) { this.audio.pause(); return; }
    this.wireAudio();
    if (this.actx.state === "suspended") this.actx.resume();
    const t = this.video.currentTime - this.p.trim.start;
    const dur = this.audio.duration || 0;
    if (this.audio.paused) {
      if (dur) this.audio.currentTime = t % dur;
      this.audio.play().catch(() => {});
    }
    const speaking = m.autoDuck === true && this.p.captions && captionAt(this.p.captions.lines || [], this.video.currentTime);
    const target = (m.volume ?? 0.25) * (speaking ? 0.3 : 1);
    this.gain.gain.setTargetAtTime(target, this.actx.currentTime, 0.12);
  }

  segments() {
    return this.p ? keptSegments(this.p.trim, effectiveCuts(this.p)) : [];
  }

  play() {
    const p = this.p;
    if (!p) return;
    const segs = this.segments();
    const nt = nextKept(segs, this.video.currentTime);
    if (nt === null || this.video.currentTime >= p.trim.end - 0.05) this.video.currentTime = segs.length ? segs[0][0] : p.trim.start;
    else if (nt > this.video.currentTime + 0.02) this.video.currentTime = nt;
    if (this.audio) this.wireAudio();
    this.primeBroll();
    this.video.play().catch(() => {});
  }

  // Called from a tap: start (then pause) each B-roll player once so iPhone
  // Safari loads them and allows them to play later without another tap.
  primeBroll() {
    for (const v of Object.values(this.brollVids)) {
      if (v.dataset.primed) continue;
      v.dataset.primed = "1";
      v.play().then(() => {
        const b = brollAt(this.p.broll, this.video.currentTime);
        if (!b || this.brollVids[b.id] !== v) v.pause();
      }).catch(() => {});
    }
  }

  pause() { this.video.pause(); }

  loop() {
    if (this.video.paused) return;
    const p = this.p;
    if (p) {
      // Jump over cut-out parts (removed pauses, manual cuts); stop at the end.
      const segs = this.segments();
      const t = this.video.currentTime;
      const nt = nextKept(segs, t);
      if (nt === null || t >= p.trim.end - 0.02) {
        this.video.pause();
        this.video.currentTime = segs.length ? segs[0][0] : p.trim.start;
        return;
      }
      if (nt > t + 0.02) this.video.currentTime = nt;
    }
    this.draw();
    this.syncMusic();
    requestAnimationFrame(() => this.loop());
  }

  // ---- drawing ----
  async ensureMasker() {
    await this.masker.init();
    this.draw(true);
  }

  needsMask() {
    const h = this.p && this.p.headline;
    return h && h.enabled && h.text && h.text.trim() && h.behind !== false;
  }

  draw(fresh = false) {
    const { ctx, CW, CH, video, p } = this;
    if (!p || !p.source) return;
    if (!video.videoWidth || video.readyState < 2) { this.drawPoster(); return; }
    const t = video.currentTime;
    this.onTime && this.onTime(t);
    this.frameNo++;
    ctx.clearRect(0, 0, CW, CH);
    this.boxes = {};

    const b = brollAt(p.broll, t);
    const bv = b && this.brollVids[b.id];
    for (const [id, v] of Object.entries(this.brollVids)) if (!b || id !== b.id) { if (!v.paused) v.pause(); }
    if (bv && bv.readyState >= 2) {
      const target = t - b.start;
      if (!video.paused) {
        if (bv.paused) bv.play().catch(() => {});
        if (Math.abs(bv.currentTime - target) > 0.3) bv.currentTime = target;
      } else if (Math.abs(bv.currentTime - target) > 0.05) {
        bv.currentTime = target;
      }
      this.drawCover(bv);
    } else {
      if (bv && !video.paused && bv.paused) bv.play().catch(() => {}); // kick off loading
      const [x, y, w, h] = cropRect(video.videoWidth, video.videoHeight, p.zoom, p.faceTrack, t);
      ctx.drawImage(video, x, y, w, h, 0, 0, CW, CH);
      if (p.headline && p.headline.enabled && (p.headline.text || "").trim()) {
        const behind = p.headline.behind !== false && this.masker.ready;
        if (behind) {
          this.pctx.globalCompositeOperation = "copy";
          this.pctx.drawImage(video, x, y, w, h, 0, 0, CW, CH);
          // Square crop around the headline (same trick as the export) = sharper edges.
          const hb = this.lastHeadBox || [0, 0, OW, OH * 0.6];
          const kx = this.k;
          const side = Math.min(CW, CH, Math.max(hb[2] - hb[0], hb[3] - hb[1]) * 1.1 * kx);
          const cx = (hb[0] + hb[2]) / 2 * kx, cy = (hb[1] + hb[3]) / 2 * kx;
          // Tall headlines don't fit a square that's at most the video's width: use a
          // taller box that still covers every line (so no word ends up in front).
          const rh = Math.min(CH, Math.max(side, (hb[3] - hb[1]) * 1.1 * kx));
          const rect = { x: Math.max(0, Math.min(CW - side, cx - side / 2)), y: Math.max(0, Math.min(CH - rh, cy - rh / 2)), w: side, h: rh };
          if (fresh || video.paused || this.frameNo % 2 === 0) {
            if (fresh) this.masker.reset();
            this.masker.update(this.person, rect);
          }
          this.pctx.globalCompositeOperation = "destination-in";
          const mr = this.masker.rect || rect;
          if (this.masker.mask.width > 1) this.pctx.drawImage(this.masker.mask, mr.x, mr.y, mr.w, mr.h);
        }
        this.drawHeadline(p.headline);
        if (behind) ctx.drawImage(this.person, 0, 0);
      }
    }

    if (p.captions && p.captions.enabled !== false) {
      let hit = captionAt(p.captions.lines || [], t);
      let ghost = false;
      if (!hit && this.ghostCaptions && (p.captions.lines || []).length) {
        hit = { line: p.captions.lines[0], active: 0, since: 1 };
        ghost = true;
      } else if (!hit && this.ghostCaptions) {
        hit = { line: { id: "sample", words: [{ w: "Your" }, { w: "captions" }, { w: "here" }] }, active: 1, since: 1 };
        ghost = true;
      }
      if (hit) this.drawCaption(p.captions.style || {}, hit, ghost);
    }
    if (p.logo && p.logo.enabled && this.logoImg && this.logoImg.naturalWidth) this.drawLogo(p.logo);
    // Small "LolliPOP" watermark, bottom-left (matches the saved video).
    if (this.wm.naturalWidth) {
      const k = this.k;
      this.ctx.drawImage(this.wm, 26 * k, (OH - this.wm.naturalHeight - 26) * k, this.wm.naturalWidth * k, this.wm.naturalHeight * k);
    }
    this.drawSelection();
  }

  // Still frame from the server, shown until the video has a frame ready.
  setPoster(url) {
    this.posterImg = null;
    if (!url) return;
    const img = new Image();
    img.onload = () => { this.posterImg = img; this.draw(); };
    img.src = url;
  }

  drawPoster() {
    const img = this.posterImg;
    if (!img) return;
    const { ctx, CW, CH } = this;
    const s = Math.max(CW / img.width, CH / img.height);
    const w = CW / s, h = CH / s;
    ctx.clearRect(0, 0, CW, CH);
    ctx.drawImage(img, (img.width - w) / 2, (img.height - h) / 2, w, h, 0, 0, CW, CH);
  }

  drawCover(media) {
    const { ctx, CW, CH } = this;
    const mw = media.videoWidth, mh = media.videoHeight;
    const s = Math.max(CW / mw, CH / mh);
    const w = CW / s, h = CH / s;
    ctx.drawImage(media, (mw - w) / 2, (mh - h) / 2, w, h, 0, 0, CW, CH);
  }

  // Draw text so its vertical middle matches Pillow's "lm" anchor used by the exporter.
  midOffset(font) {
    if (this.metricsCache[font] === undefined) {
      this.ctx.font = font;
      const m = this.ctx.measureText("Hg");
      const asc = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent;
      const desc = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
      this.metricsCache[font] = (asc - desc) / 2;
    }
    return this.metricsCache[font];
  }

  drawLines(lines, font, cx, cy, lineH, colors, stroke = 0, strokeColor = "#000", box = null, size = 0) {
    const { ctx } = this;
    ctx.font = font;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.lineJoin = "round";
    const off = this.midOffset(font);
    const space = ctx.measureText(" ").width;
    const n = lines.length;
    let x0 = Infinity, x1 = -Infinity;
    lines.forEach((ln, i) => {
      const y = cy - (n - 1) * lineH / 2 + i * lineH + off;
      const total = ctx.measureText(ln.map((w) => w[0]).join(" ")).width;
      let x = cx - total / 2;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x + total);
      for (const [word, key] of ln) {
        const wl = ctx.measureText(word).width;
        if (box && key) {
          const mid = y - off, r = size * 0.22;
          ctx.fillStyle = box;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(x - size * 0.18, mid - size * 0.62, wl + size * 0.36, size * 1.24, r);
          else ctx.rect(x - size * 0.18, mid - size * 0.62, wl + size * 0.36, size * 1.24);
          ctx.fill();
        } else if (stroke > 0) { ctx.lineWidth = stroke * 2; ctx.strokeStyle = strokeColor; ctx.strokeText(word, x, y); }
        ctx.fillStyle = colors[key ? 1 : 0];
        ctx.fillText(word, x, y);
        x += ctx.measureText(word).width + space;
      }
    });
    return [x0, cy - n * lineH / 2, x1, cy + n * lineH / 2];
  }

  drawHeadline(h) {
    const k = this.k;
    const text = h.uppercase !== false ? h.text.toUpperCase() : h.text;
    const size = (h.size || 150) * k;
    const font = `${size}px "${h.font || "Anton"}"`;
    this.ctx.font = font;
    const measure = (ws) => this.ctx.measureText(ws.map((w) => w[0]).join(" ")).width;
    let lines = [];
    for (const ln of parseHeadline(text)) lines = lines.concat(wrapWords(ln, measure, OW * k * (h.maxWidth || 0.92)));
    this.ctx.globalAlpha = h.opacity ?? 1;
    const colors = [h.color || "#E9E1D3", h.accent || "#D7262E"];
    const cx = (h.x ?? 0.5) * this.CW, cy = (h.y ?? 0.25) * this.CH, lh = h.lineHeight || 0.95;
    let box;
    if (h.block !== false && lines.length) {
      // Mirror of text.py: scale every line to the widest line's width → one squared-off block.
      const target = Math.max(...lines.map(measure));
      const base = h.size || 150;
      const sizes = lines.map((ln) => Math.floor(Math.min(base * 3, base * target / Math.max(1, measure(ln)))) * k);
      const total = sizes.reduce((n, s) => n + s * lh, 0);
      let y = cy - total / 2, x0 = Infinity, x1 = -Infinity;
      lines.forEach((ln, i) => {
        y += sizes[i] * lh / 2;
        const b = this.drawLines([ln], `${sizes[i]}px "${h.font || "Anton"}"`, cx, y, sizes[i] * lh, colors);
        x0 = Math.min(x0, b[0]); x1 = Math.max(x1, b[2]);
        y += sizes[i] * lh / 2;
        this.ctx.font = font; // measure() uses the base font
      });
      box = [x0, cy - total / 2, x1, cy + total / 2];
    } else {
      box = this.drawLines(lines, font, cx, cy, size * lh, colors);
    }
    this.ctx.globalAlpha = 1;
    this.boxes.headline = box.map((v) => v / k);
    this.lastHeadBox = this.boxes.headline;
  }

  drawCaption(style, { line, active, since }, ghost) {
    const k = this.k;
    let words = line.words.map((w) => w.w);
    if (style.uppercase !== false) words = words.map((w) => w.toUpperCase());
    let base = style.size || 66;
    const family0 = style.font || "Montserrat";
    if (style.fill) { // AI looks: every line as wide as the screen allows (up to 2x the size)
      this.ctx.font = `${base * k}px "${family0}"`;
      const w0 = this.ctx.measureText(words.join(" ")).width / k;
      if (w0 > 0) base = Math.floor(Math.min(base * 2, base * OW * 0.9 / w0));
    }
    let size = base;
    if ((style.animation || "pop") === "pop") size = Math.floor(base * (0.82 + 0.18 * ease(since / 0.12)));
    const family = style.font || "Montserrat";
    this.ctx.font = `${size * k}px "${family}"`;
    const width = this.ctx.measureText(words.join(" ")).width / k;
    if (width > OW * 0.9) size = Math.floor(size * OW * 0.9 / width);
    const stroke = Math.max(0, Math.floor((style.stroke ?? 7) * size / base));
    const keyed = [words.map((w, j) => [w, j === active])];
    this.ctx.globalAlpha = ghost ? 0.55 : 1;
    const isBox = style.highlightStyle === "box";
    const box = this.drawLines(keyed, `${size * k}px "${family}"`, (style.x ?? 0.5) * this.CW, (style.y ?? 0.72) * this.CH,
      size * 1.2 * k, [style.color || "#FFFFFF", isBox ? (style.boxText || "#FFFFFF") : (style.highlight || "#F2C230")],
      stroke * k, style.strokeColor || "#000000", isBox ? (style.highlight || "#E3202A") : null, size * k);
    this.ctx.globalAlpha = 1;
    this.boxes.captions = box.map((v) => v / k);
  }

  drawLogo(l) {
    const k = this.k, img = this.logoImg;
    const lw = Math.max(8, Math.floor((l.w ?? 0.3) * OW));
    const lh = Math.max(8, Math.floor(img.naturalHeight * lw / img.naturalWidth));
    const x = Math.floor((l.x ?? 0.5) * OW - lw / 2), y = Math.floor((l.y ?? 0.08) * OH - lh / 2);
    this.ctx.globalAlpha = l.opacity ?? 1;
    this.ctx.drawImage(img, x * k, y * k, lw * k, lh * k);
    this.ctx.globalAlpha = 1;
    this.boxes.logo = [x, y, x + lw, y + lh];
  }

  drawSelection() {
    const sel = this.selected;
    if (!sel || !this.boxes[sel] || (performance.now() > this.selectedUntil && !this.gesture)) return;
    const k = this.k, [x0, y0, x1, y1] = this.boxes[sel], pad = 14;
    const { ctx } = this;
    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(242,194,48,.95)";
    ctx.strokeRect((x0 - pad) * k, (y0 - pad) * k, (x1 - x0 + pad * 2) * k, (y1 - y0 + pad * 2) * k);
    // One-thumb resize handle on the bottom-right corner: drag it out = bigger, in = smaller.
    const [hx, hy] = this.handlePos(sel), r = this.handleR();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(hx * k, hy * k, r * k, 0, Math.PI * 2);
    ctx.fillStyle = "#F2C230"; ctx.shadowColor = "rgba(0,0,0,.6)"; ctx.shadowBlur = 8; ctx.fill();
    ctx.shadowBlur = 0; ctx.lineWidth = 2.5; ctx.strokeStyle = "#2a0a0c";
    const a = r * 0.45 * k, cx = hx * k, cy = hy * k;
    ctx.beginPath();
    ctx.moveTo(cx - a, cy - a); ctx.lineTo(cx + a, cy + a);
    ctx.moveTo(cx - a, cy - a); ctx.lineTo(cx - a * 0.2, cy - a); ctx.moveTo(cx - a, cy - a); ctx.lineTo(cx - a, cy - a * 0.2);
    ctx.moveTo(cx + a, cy + a); ctx.lineTo(cx + a * 0.2, cy + a); ctx.moveTo(cx + a, cy + a); ctx.lineTo(cx + a, cy + a * 0.2);
    ctx.stroke();
    ctx.restore();
  }

  // Handle size: about a fingertip (~24 screen px) whatever size the preview is.
  handleR() {
    const w = this.canvas.getBoundingClientRect().width || 300;
    return 24 * OW / w;
  }
  handlePos(key) {
    const [x0, y0, x1, y1] = this.boxes[key], pad = 14;
    return [Math.min(OW - 4, x1 + pad), Math.min(OH - 4, y1 + pad)];
  }

  // ---- gestures ----
  toOut(e) {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * OW, (e.clientY - r.top) / r.height * OH];
  }

  hitTest([x, y]) {
    for (const key of ["logo", "captions", "headline"]) {
      const b = this.boxes[key];
      if (b && x >= b[0] - 40 && x <= b[2] + 40 && y >= b[1] - 40 && y <= b[3] + 40) return key;
    }
    return null;
  }

  target(key) {
    const p = this.p;
    if (key === "captions") return p.captions.style;
    if (key === "headline") return p.headline;
    return p.logo;
  }

  sizeOf(key) {
    const o = this.target(key);
    return key === "logo" ? (o.w ?? 0.3) : (o.size || (key === "headline" ? 150 : 66));
  }

  setSize(key, v) {
    const o = this.target(key);
    if (key === "logo") o.w = Math.min(1, Math.max(0.06, v));
    else if (key === "headline") o.size = Math.round(Math.min(400, Math.max(40, v)));
    else { o.size = Math.round(Math.min(160, Math.max(28, v))); o.fill = false; } // resized by hand: stop auto-filling
  }

  bindGestures() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      if (!this.p) return;
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, this.toOut(e));
      if (this.pointers.size === 1) {
        const pt = this.toOut(e);
        // Grabbed the gold corner handle of the selected item: one-thumb resize.
        const sel = this.selected;
        if (sel && this.boxes[sel] && performance.now() < this.selectedUntil) {
          const [hx, hy] = this.handlePos(sel);
          if (Math.hypot(pt[0] - hx, pt[1] - hy) < this.handleR() * 1.6) {
            const [x0, y0, x1, y1] = this.boxes[sel];
            const c = [(x0 + x1) / 2, (y0 + y1) / 2];
            this.gesture = { key: sel, start: pt, last: pt, t0: performance.now(), moved: true,
              resize: { c, d0: Math.max(20, Math.hypot(pt[0] - c[0], pt[1] - c[1])), s0: this.sizeOf(sel) } };
            return;
          }
        }
        const key = this.hitTest(pt);
        this.gesture = { key, start: pt, last: pt, t0: performance.now(), moved: false };
        // Tapping an item keeps it selected (with its resize handle) until you tap elsewhere.
        if (key) { this.selected = key; this.selectedUntil = performance.now() + 120000; }
        else { this.selected = null; }
      } else if (this.pointers.size === 2 && this.gesture) {
        const key = this.gesture.key || this.selected;
        if (key) {
          const [a, b] = [...this.pointers.values()];
          this.gesture = { ...this.gesture, key, pinch: { d0: Math.hypot(a[0] - b[0], a[1] - b[1]), s0: this.sizeOf(key) }, moved: true };
        }
      }
    });
    c.addEventListener("pointermove", (e) => {
      if (!this.pointers.has(e.pointerId) || !this.gesture) return;
      this.pointers.set(e.pointerId, this.toOut(e));
      const g = this.gesture;
      if (g.resize) {
        const pt = this.toOut(e);
        const d = Math.hypot(pt[0] - g.resize.c[0], pt[1] - g.resize.c[1]);
        this.setSize(g.key, g.resize.s0 * d / g.resize.d0);
        this.draw();
        return;
      }
      if (g.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        this.setSize(g.key, g.pinch.s0 * d / Math.max(1, g.pinch.d0));
        this.draw();
        return;
      }
      const pt = this.toOut(e);
      if (Math.hypot(pt[0] - g.start[0], pt[1] - g.start[1]) > 18) g.moved = true;
      if (g.key && g.moved && !g.pinch) {
        const o = this.target(g.key);
        const nx = (o._rawX ?? o.x ?? 0.5) + (pt[0] - g.last[0]) / OW;
        const ny = (o.y ?? 0.5) + (pt[1] - g.last[1]) / OH;
        o._rawX = Math.min(1, Math.max(0, nx));
        o.x = Math.abs(o._rawX - 0.5) < 0.015 ? 0.5 : o._rawX; // snap to centre
        o.y = Math.min(1, Math.max(0, ny));
        this.draw();
      }
      g.last = pt;
    });
    const end = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      const g = this.gesture;
      if (this.pointers.size > 0 || !g) return;
      this.gesture = null;
      if (g.key) {
        const o = this.target(g.key);
        delete o._rawX;
      }
      if (!g.moved && performance.now() - g.t0 < 400) {
        this.onTap && this.onTap(g.key);
      } else if (g.key) {
        this.onChange && this.onChange(g.key === "captions" ? "captions" : g.key);
      }
      this.draw();
      setTimeout(() => this.draw(), 1600);
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
  }
}
