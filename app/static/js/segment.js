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
        const px = this.img.data;
        for (let i = 0; i < data.length; i++) {
          const v = 0.5 * this.prev[i] + 0.5 * data[i];
          this.prev[i] = v;
          px[i * 4 + 3] = Math.max(0, Math.min(1, (v - 0.35) / 0.3)) * 255;
        }
        this.mctx.putImageData(this.img, 0, 0);
      });
      return true;
    } catch (e) {
      console.warn(e);
      return false;
    }
  }
}
