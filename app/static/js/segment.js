// In-browser person segmentation for the live preview (the server repeats the
// same step at full quality when exporting). Uses Google MediaPipe, bundled
// locally so it works without any outside service.
let segmenter = null;
let loading = null;

async function load() {
  const { FilesetResolver, ImageSegmenter } = await import("/static/vendor/mediapipe/vision_bundle.mjs");
  const fileset = await FilesetResolver.forVisionTasks("/static/vendor/mediapipe/wasm");
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: "/static/vendor/mediapipe/selfie_segmenter.tflite", delegate },
    runningMode: "VIDEO", outputConfidenceMasks: true, outputCategoryMask: false,
  });
  try { return await ImageSegmenter.createFromOptions(fileset, opts("GPU")); }
  catch { return await ImageSegmenter.createFromOptions(fileset, opts("CPU")); }
}

// The detailed model: loaded quietly in the background after the fast one. It finds hair and
// shoulders reliably on dark backgrounds, so it's used as a "spill guard" — anything the fast
// model marks well outside the person (dark cabinets, a car interior) is dropped.
let guardSeg = null, guardLoading = null;
async function loadGuard() {
  const { FilesetResolver, ImageSegmenter } = await import("/static/vendor/mediapipe/vision_bundle.mjs");
  const fileset = await FilesetResolver.forVisionTasks("/static/vendor/mediapipe/wasm");
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: "/static/vendor/mediapipe/selfie_multiclass_256x256.tflite", delegate },
    runningMode: "IMAGE", outputConfidenceMasks: true, outputCategoryMask: false,
  });
  try { return await ImageSegmenter.createFromOptions(fileset, opts("GPU")); }
  catch { return await ImageSegmenter.createFromOptions(fileset, opts("CPU")); }
}

export class PersonMasker {
  constructor() {
    this.input = document.createElement("canvas");
    this.input.width = 256; this.input.height = 256; // square, like the model
    this.ictx = this.input.getContext("2d", { willReadFrequently: true });
    this.mask = document.createElement("canvas");
    this.mctx = this.mask.getContext("2d");
    this.prevs = [];
    this.lastTs = 0;
    this.ready = false;
    this.failed = false;
  }

  async init() {
    if (this.ready || this.failed) return;
    try {
      if (!loading) loading = load();
      segmenter = await loading;
      this.ready = true;
      if (!guardLoading) guardLoading = loadGuard().then((g) => (guardSeg = g)).catch((e) => console.warn("guard model unavailable", e));
    } catch (e) {
      console.warn("Segmentation unavailable in this browser", e);
      this.failed = true;
    }
  }

  reset() { this.prevs = []; this.guard = null; }

  // Where the detailed model sees the person, grown by a margin (head movement until the next
  // check) and softened. Returned at mask resolution (w x h), 0..1.
  guardMask(source, r, w, h) {
    if (!guardSeg) return null;
    const g = this.gdraw || (this.gdraw = document.createElement("canvas"));
    g.width = 256; g.height = 256;
    const gc = g.getContext("2d", { willReadFrequently: true });
    gc.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, 256, 256);
    let bg = null, gw = 0, gh = 0;
    guardSeg.segment(g, (result) => {
      const m = result.confidenceMasks && result.confidenceMasks[0];
      if (!m) return;
      gw = m.width; gh = m.height; bg = new Float32Array(m.getAsFloat32Array());
    });
    if (!bg) return null;
    const N = w * h, out = new Float32Array(N), tmp = new Float32Array(N), blur = new Float32Array(N);
    for (let y = 0; y < h; y++) {
      const my = Math.min(gh - 1, ((y / h) * gh) | 0);
      for (let x = 0; x < w; x++) out[y * w + x] = 1 - bg[my * gw + Math.min(gw - 1, ((x / w) * gw) | 0)] > 0.35 ? 1 : 0;
    }
    const rad = Math.max(2, Math.round(Math.min(w, h) * 0.022));
    boxFilter(out, blur, tmp, w, h, rad);            // grow: anything near the person counts
    for (let i = 0; i < N; i++) out[i] = blur[i] > 0.02 ? 1 : 0;
    boxFilter(out, blur, tmp, w, h, Math.max(1, rad >> 1)); // soft edge
    return blur;
  }

  // `source` is a canvas holding exactly the frame that is on screen.
  // rect = {x, y, w, h}: the part of `source` to cut out. The model sees a 256x256 square, so a
  // tall area (3-line headline) is covered with overlapping squares stacked top to bottom — the
  // same as the export. Squashing it into one square made the edge stretched and blocky.
  update(source, rect) {
    if (!this.ready) return false;
    const r = rect || { x: 0, y: 0, w: source.width, h: source.height };
    this.rect = r;
    const S = this.input.width;
    const side = Math.min(r.w, r.h);
    // The edge is worked out on a finer grid than the model's 256 px (up to ~2x, about 540 px
    // across), so the jaw / neck / collar line comes out crisp instead of soft and steppy.
    const U = Math.max(1, Math.min(2, 540 / Math.max(1, r.w * (S / side))));
    const scale = (S * U) / side; // mask pixels per source pixel
    const MW = Math.max(1, Math.round(r.w * scale)), MH = Math.max(1, Math.round(r.h * scale));
    const tall = r.h >= r.w, L = tall ? r.h : r.w;
    const n = L <= side + 1 ? 1 : Math.max(2, Math.ceil((L - side * 0.15) / (side * 0.85)));
    if (!this.acc || this.acc.length !== MW * MH) {
      this.acc = new Float32Array(MW * MH); this.tmp = new Float32Array(MW * MH);
      this.mask.width = MW; this.mask.height = MH;
      this.img = this.mctx.createImageData(MW, MH); this.img.data.fill(255);
      this.prevs = [];
    }
    if (!this.prevs) this.prevs = [];
    const acc = this.acc; acc.fill(0);
    try {
      for (let k = 0; k < n; k++) {
        const o = n === 1 ? 0 : ((L - side) * k) / (n - 1);
        const sx = r.x + (tall ? 0 : o), sy = r.y + (tall ? o : 0);
        this.ictx.drawImage(source, sx, sy, side, side, 0, 0, S, S);
        const ts = Math.max(this.lastTs + 1, performance.now());
        this.lastTs = ts;
        segmenter.segmentForVideo(this.input, ts, (result) => {
          const m = result.confidenceMasks && result.confidenceMasks[0];
          if (!m) return;
          const w = m.width, h = m.height, data = m.getAsFloat32Array();
          let prev = this.prevs[k];
          if (!prev || prev.length !== data.length) prev = this.prevs[k] = new Float32Array(data);
          const ox = tall ? 0 : Math.round(o * scale), oy = tall ? Math.round(o * scale) : 0;
          const SU = Math.round(S * U), fx = w / SU, fy = h / SU;
          const sm = (i) => 0.3 * prev[i] + 0.7 * data[i]; // light smoothing against flicker
          for (let y = 0; y < SU; y++) {
            const ay = oy + y; if (ay >= MH) break;
            const yy = Math.max(0, Math.min(h - 1, (y + 0.5) * fy - 0.5)), y0 = yy | 0, y1 = Math.min(h - 1, y0 + 1), wy = yy - y0;
            for (let x = 0; x < SU; x++) {
              const ax = ox + x; if (ax >= MW) break;
              // Smooth (bilinear) upscale of the model's answer: no stair-steps along the edge.
              const xx = Math.max(0, Math.min(w - 1, (x + 0.5) * fx - 0.5)), x0 = xx | 0, x1 = Math.min(w - 1, x0 + 1), wx = xx - x0;
              const v = (sm(y0 * w + x0) * (1 - wx) + sm(y0 * w + x1) * wx) * (1 - wy)
                      + (sm(y1 * w + x0) * (1 - wx) + sm(y1 * w + x1) * wx) * wy;
              const j = ay * MW + ax;
              if (v > acc[j]) acc[j] = v;
            }
          }
          for (let i = 0; i < data.length; i++) prev[i] = 0.3 * prev[i] + 0.7 * data[i];
        });
      }
      // Snap the edge to the real outline in the picture (edge-aware "guided filter", the same
      // step the export uses), then firm it up — clean hair/ear edges instead of a soft blob.
      const w = MW, h = MH;
      if (!this.gcan) { this.gcan = document.createElement("canvas"); this.gctx = this.gcan.getContext("2d", { willReadFrequently: true }); }
      if (this.gcan.width !== w || this.gcan.height !== h) { this.gcan.width = w; this.gcan.height = h; }
      this.gctx.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, w, h);
      const rgba = this.gctx.getImageData(0, 0, w, h).data;
      const N = w * h;
      if (!this.gf || this.gf.I.length !== N) {
        const f = () => new Float32Array(N);
        this.gf = { I: f(), II: f(), IP: f(), mI: f(), mP: f(), mII: f(), mIP: f(), A: f(), B: f(), t: f() };
      }
      const { I, II, IP, mI, mP, mII, mIP, A, B, t } = this.gf;
      for (let i = 0; i < N; i++) {
        const g = (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) / 255;
        I[i] = g; II[i] = g * g; IP[i] = g * acc[i];
      }
      const rad = Math.max(2, Math.round(w / 110));
      const box = (src, out) => boxFilter(src, out, t, w, h, rad);
      box(I, mI); box(acc, mP); box(II, mII); box(IP, mIP);
      for (let i = 0; i < N; i++) {
        const va = mII[i] - mI[i] * mI[i], cov = mIP[i] - mI[i] * mP[i];
        A[i] = cov / (va + 5e-4); B[i] = mP[i] - A[i] * mI[i];
      }
      box(A, mII); box(B, mIP);
      const a = acc;
      for (let i = 0; i < N; i++) a[i] = Math.max(0, Math.min(1, (mII[i] * I[i] + mIP[i] - 0.42) / 0.2));
      // Spill guard: refreshed when the picture is paused/jumped and every ~8 updates while playing.
      if (guardSeg) {
        this.guardAge = (this.guardAge || 0) + 1;
        if (!this.guard || this.guard.length !== a.length || this.guardAge >= 8) {
          const gm = this.guardMask(source, r, w, h);
          if (gm) { this.guard = gm; this.guardAge = 0; }
        }
        if (this.guard && this.guard.length === a.length) for (let i = 0; i < a.length; i++) a[i] *= this.guard[i];
      }
      const px = this.img.data;
      for (let i = 0; i < a.length; i++) px[i * 4 + 3] = a[i] * 255;
      this.mctx.putImageData(this.img, 0, 0);
      return true;
    } catch (e) {
      console.warn(e);
      return false;
    }
  }
}

// Mean over a (2r+1)x(2r+1) window, edges clamped. Two running-sum passes, so it's fast in JS.
function boxFilter(src, out, tmp, w, h, r) {
  const d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / d;
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / d;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
}
