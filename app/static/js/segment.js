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

export class PersonMasker {
  constructor() {
    this.input = document.createElement("canvas");
    this.input.width = 180; this.input.height = 320;
    this.ictx = this.input.getContext("2d", { willReadFrequently: true });
    this.mask = document.createElement("canvas");
    this.mctx = this.mask.getContext("2d");
    this.prev = null;
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
    } catch (e) {
      console.warn("Segmentation unavailable in this browser", e);
      this.failed = true;
    }
  }

  reset() { this.prev = null; }

  // `source` is a canvas holding exactly the frame that is on screen.
  update(source) {
    if (!this.ready) return false;
    this.ictx.drawImage(source, 0, 0, this.input.width, this.input.height);
    const ts = Math.max(this.lastTs + 1, performance.now());
    this.lastTs = ts;
    try {
      segmenter.segmentForVideo(this.input, ts, (result) => {
        const m = result.confidenceMasks && result.confidenceMasks[0];
        if (!m) return;
        const w = m.width, h = m.height, data = m.getAsFloat32Array();
        if (this.mask.width !== w || this.mask.height !== h) {
          this.mask.width = w; this.mask.height = h; this.prev = null;
          this.img = this.mctx.createImageData(w, h);
          this.img.data.fill(255);
        }
        if (!this.prev) this.prev = new Float32Array(data);
        if (!this.tmp || this.tmp.length !== data.length) { this.tmp = new Float32Array(data.length); this.tmp2 = new Float32Array(data.length); }
        const a = this.tmp, b = this.tmp2;
        for (let i = 0; i < data.length; i++) {
          const v = 0.5 * this.prev[i] + 0.5 * data[i];
          this.prev[i] = v;
          a[i] = Math.max(0, Math.min(1, (v - 0.3) / 0.4));
        }
        // Two small blur passes so the edge around hair/shoulders is soft, not jagged.
        for (let pass = 0; pass < 2; pass++) {
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = y * w + x;
            b[i] = (a[i] * 2 + (x > 0 ? a[i - 1] : a[i]) + (x < w - 1 ? a[i + 1] : a[i])) / 4;
          }
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = y * w + x;
            a[i] = (b[i] * 2 + (y > 0 ? b[i - w] : b[i]) + (y < h - 1 ? b[i + w] : b[i])) / 4;
          }
        }
        const px = this.img.data;
        for (let i = 0; i < data.length; i++) px[i * 4 + 3] = a[i] * 255;
        this.mctx.putImageData(this.img, 0, 0);
      });
      return true;
    } catch (e) {
      console.warn(e);
      return false;
    }
  }
}
