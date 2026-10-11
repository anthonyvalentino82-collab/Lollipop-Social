import { Preview } from "./preview.js";
import { buildCaptionLines, effectiveCuts, keptDuration, keptSegments, outToSrc, retimeLine, srcToOut } from "./timeline.js";

const $ = (id) => document.getElementById(id);
const video = document.createElement("video");
video.playsInline = true;
video.setAttribute("playsinline", "");
video.preload = "auto";

const state = { project: null, settings: null, status: null, sheet: null, wizard: null, exportUrl: null };
const FONTS_CAPTION = ["Montserrat", "Bebas Neue", "Lobster", "Anton", "Poppins", "Oswald", "Playfair"];
const FONTS_HEADLINE = ["Anton", "Bebas Neue", "Lobster", "Oswald", "Montserrat", "Playfair"];
const brandFonts = () => (state.settings?.fonts || []).map((f) => f.name);

// Make uploaded brand fonts available to the preview canvas.
async function loadBrandFonts() {
  for (const f of state.settings?.fonts || []) {
    if ([...document.fonts].some((ff) => ff.family === f.name || ff.family === `"${f.name}"`)) continue;
    try {
      const face = new FontFace(f.name, `url(/files/fonts/${f.file})`);
      await face.load();
      document.fonts.add(face);
    } catch (e) { console.warn("font failed", f.name, e); }
  }
  preview.draw();
}

// Font chips (built-in + your brand fonts) with "+ Add my font".
function fontPicker(label, builtins, current, onpick) {
  const inp = el("input", { type: "file", accept: ".ttf,.otf,font/ttf,font/otf", hidden: true });
  inp.addEventListener("change", async () => {
    const f = inp.files[0];
    if (!f) return;
    const name = prompt("Name this font (e.g. Horizon Brand)", f.name.replace(/\.[^.]+$/, "")) || "";
    try {
      busy("Uploading font…", 0);
      state.settings = await upload("/api/fonts", { file: f, name }, (x) => busy("Uploading font…", x));
      busy(null);
      await loadBrandFonts();
      const added = state.settings.fonts[state.settings.fonts.length - 1];
      onpick(added.name);
      refreshSheet();
      toast(`Font “${added.name}” added`);
    } catch (e) { busy(null); toast(e.message, 4000); }
  });
  const field = chips(label, [...builtins, ...brandFonts()].map((f) => [f, f, `font-family:"${f}"`]), current, onpick);
  field.querySelector(".chips").append(el("label", { class: "chip add-font" }, inp, "+ Add my font"));
  return field;
}
const TEXT_COLORS = ["#FFFFFF", "#E9E1D3", "#F2C230", "#E3202A", "#111111", "#C4C4C4"];
const ACCENT_COLORS = ["#F2C230", "#E3202A", "#D7262E", "#FFFFFF", "#33C3F0", "#7CFC8A"];
const INTENSITY = { subtle: 1.08, medium: 1.15, strong: 1.25 };

// ---------- helpers ----------
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
}
const fmt = (s) => { s = Math.max(0, s || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`; };
const fmt1 = (s) => `${(s || 0).toFixed(1)}s`;
function toast(msg, ms = 2600) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
// ---------- "Report a problem": a short technical log of what the app did ----------
const dlogBuf = (() => { try { return JSON.parse(localStorage.getItem("lp_dlog") || "[]"); } catch { return []; } })();
function dlog(msg, data) {
  dlogBuf.push({ t: new Date().toISOString(), msg: String(msg).slice(0, 300), ...(data ? { data } : {}) });
  while (dlogBuf.length > 150) dlogBuf.shift();
  try { localStorage.setItem("lp_dlog", JSON.stringify(dlogBuf)); } catch {}
}
window.addEventListener("error", (e) => dlog("js error", { message: e.message, at: `${e.filename}:${e.lineno}` }));
window.addEventListener("unhandledrejection", (e) => dlog("js promise error", { message: String(e.reason?.message || e.reason) }));
document.addEventListener("visibilitychange", () => dlog(`page ${document.visibilityState}`));
async function sendReport() {
  const note = prompt("What went wrong? (a few words help — optional)");
  if (note === null) return;
  const conn = navigator.connection || {};
  const client = {
    userAgent: navigator.userAgent, platform: navigator.platform, standalone: !!navigator.standalone,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`, viewport: `${innerWidth}x${innerHeight}`,
    memoryGB: navigator.deviceMemory, cores: navigator.hardwareConcurrency, network: conn.effectiveType,
    appVersion: document.querySelector('script[src*="app.js"]')?.getAttribute("src"),
    screenShown: ["hero", "stageWrap", "result"].filter((id) => $(id) && !$(id).hidden),
    log: dlogBuf.slice(-150),
  };
  try {
    busy("Sending report…", 0.5);
    const r = await api("/api/report", { method: "POST", json: { note, projectId: state.project?.id || recall("lp_project"), client } });
    busy(null);
    alert(`Report sent ✓\n\nTell Claude: “I sent a report” (number ${r.id}).`);
  } catch (e) { busy(null); if (!(e instanceof AuthError)) toast("Couldn't send the report: " + e.message, 5000); }
}

function store(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
function recall(k) { try { return localStorage.getItem(k); } catch { return null; } }

class AuthError extends Error {}
async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers = { "Content-Type": "application/json" };
    delete init.json;
  }
  const r = await fetch(path, init);
  if (r.status === 401 && path !== "/api/login") { showLogin(); throw new AuthError("login"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || `Request failed (${r.status})`);
  return data;
}

function upload(url, fields, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
    const x = new XMLHttpRequest();
    x.open("POST", url);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    x.onload = () => {
      if (x.status === 401) { showLogin(); return reject(new AuthError("login")); }
      let d = {}; try { d = JSON.parse(x.responseText); } catch {}
      x.status < 300 ? resolve(d) : reject(Object.assign(new Error(d.detail || `Upload failed (${x.status})`), { network: x.status >= 500 }));
    };
    x.onerror = () => reject(Object.assign(new Error("Upload failed — check your connection. Your video is kept: tap Try again."), { network: true }));
    x.send(fd);
  });
}

async function waitJob(job, onProgress) {
  let misses = 0;
  while (true) {
    let j;
    try {
      const r = await fetch(`/api/jobs/${job.id}`);
      if (r.status === 401) { showLogin(); throw new AuthError("login"); }
      if (r.status === 404) {
        throw Object.assign(new Error("The server restarted while working (this happens when the app updates). Please tap the button again."), { restarted: true });
      }
      if (!r.ok) throw Object.assign(new Error(`Server error (${r.status})`), { transient: true });
      j = await r.json();
      misses = 0;
    } catch (e) {
      // Phone went to sleep, Wi-Fi blip, server busy: keep trying for ~3 minutes.
      if (e instanceof AuthError || !(e.transient || e instanceof TypeError) || ++misses > 90) throw e;
      await new Promise((res) => setTimeout(res, 2000));
      continue;
    }
    onProgress && onProgress(j);
    if (j.status === "done") return j;
    if (j.status === "error") throw new Error(j.error || "Something went wrong.");
    await new Promise((r) => setTimeout(r, 900));
  }
}

// Wait for a job; if the server restarts mid-way (e.g. while the app updates), wait for it to
// come back and start the job again from where its files are, instead of failing.
async function runJob(job, restart, onProgress) {
  for (let attempt = 0; ; attempt++) {
    if (job.done) return job;
    try { return await waitJob(job, onProgress); }
    catch (e) {
      if (!e.restarted || attempt >= 3) throw e;
      dlog("server restarted mid-job, resuming", { attempt });
      busy("The server restarted — picking up where we left off…", 0);
      for (let i = 0; i < 90; i++) { // up to ~3 minutes
        try { if ((await fetch("/healthz", { cache: "no-store" })).ok) break; } catch {}
        await new Promise((r) => setTimeout(r, 2000));
      }
      job = await restart();
    }
  }
}

function showError(title, err, retry) {
  dlog(`error shown: ${title}`, { message: String(err && err.message || err) });
  openSheet("error", title, [
    el("p", { class: "note warn" }, String(err && err.message || err)),
    el("p", { class: "note" }, "If this keeps happening, take a screenshot of this message and send it to Claude."),
    retry ? el("button", { class: "btn btn-primary", onclick: () => { closeSheet(); retry(); } }, "Try again") : null,
  ]);
}

function busy(msg, p) {
  $("busy").hidden = msg == null;
  if (msg != null) {
    const pct = Math.round((p || 0) * 100);
    $("busyMsg").textContent = msg.replace(/\s*…?\s*\d+%$/, "");
    $("busyPct").textContent = `${pct}%`;
    $("busyBar").style.width = `${pct}%`;
  }
}

// ---------- preview ----------
const preview = new Preview($("canvas"), video, {
  onChange: (key) => save(key === "logo" ? ["logo"] : key === "headline" ? ["headline"] : ["captions"]),
  onTap: (key) => {
    if (key) { if (state.wizard == null) openSheet(key); } // during AI Edit, tapping just selects for dragging
    else if (video.paused) preview.play(); else preview.pause();
  },
  onTime: (t) => updateScrub(t),
});
video.addEventListener("play", () => $("ppBtn").classList.add("playing"));
video.addEventListener("pause", () => $("ppBtn").classList.remove("playing"));
const togglePlay = () => { if (video.paused) preview.play(); else preview.pause(); };
$("ppBtn").addEventListener("click", togglePlay);
$("ppMini").addEventListener("click", togglePlay);
video.addEventListener("play", () => $("ppMini").classList.add("playing"));
video.addEventListener("pause", () => $("ppMini").classList.remove("playing"));

function updateScrub(t) {
  const p = state.project;
  if (!p) return;
  const segs = keptSegments(p.trim, effectiveCuts(p));
  const d = keptDuration(segs);
  const o = srcToOut(segs, t);
  $("tCur").textContent = fmt(o);
  $("tDur").textContent = fmt(d);
  const v = Math.round((o / Math.max(0.01, d)) * 1000);
  if (!seekDragging) { $("seek").value = v; }
  $("seek").style.setProperty("--p", `${v / 10}%`);
  highlightCaptionRow(t);
  if (state.sheet === "trim" && trimUI) {
    trimUI.head.style.left = `${(t / trimUI.dur) * 100}%`;
    if (pendingCut != null) trimUI.paint();
  }
}
let seekDragging = false;
$("seek").addEventListener("input", () => {
  seekDragging = true;
  const p = state.project;
  const segs = keptSegments(p.trim, effectiveCuts(p));
  video.currentTime = outToSrc(segs, ($("seek").value / 1000) * keptDuration(segs));
});
$("seek").addEventListener("change", () => (seekDragging = false));

// ---------- video size (pulsing chevron on the video) ----------
const SIZES = ["s", "m", "l", "full"];
const SIZE_NAMES = { s: "Small", m: "Medium", l: "Large", full: "Full screen" };
function setSize(sz) {
  state.size = sz;
  document.body.dataset.size = sz;
  document.querySelectorAll(".size-label").forEach((e) => (e.textContent = SIZE_NAMES[sz]));
  $("exitFull").hidden = sz !== "full";
  if (sz === "full") window.scrollTo({ top: 0 });
  const k = SIZES.indexOf(sz);
  for (const id of ["sizeSmaller", "sizeSmaller2"]) $(id).disabled = k <= 0;
  for (const id of ["sizeBigger", "sizeBigger2"]) $(id).disabled = k >= SIZES.length - 1;
  fitStage();
  preview.draw();
  placeSizeHint();
  setTimeout(placeSizeHint, 260); // after the resize animation
}
// While editing, the video and the edit panel share the screen below the status bar:
//   Medium (start) — the video is as big as it can be with the WHOLE panel showing (no scrolling);
//                    when "More options" opens, the video automatically gets smaller to make room.
//   Small  — a smaller video, more room for the panel.
//   Large  — a bigger video; the panel gets shorter and scrolls.
//   Full screen — just the video.
// Everything is measured on the real screen, so the iPhone's status-bar area is accounted for
// and the play bar is never covered.
function fitStage() {
  const sh = $("sheet");
  const root = document.documentElement.style;
  const editing = !sh.hidden && document.body.classList.contains("sheet-open") && state.size !== "full";
  if (!editing) { root.removeProperty("--stage-h"); root.removeProperty("--stage-wmax"); sh.style.maxHeight = ""; return; }
  const row = document.querySelector(".stage-row");
  const rowTop = row.getBoundingClientRect().top;
  const scrub = $("scrub");
  const scrubH = scrub.hidden ? 0 : Math.max(48, scrub.getBoundingClientRect().height) + 10;
  const total = innerHeight - rowTop - scrubH - 6; // video + panel share this
  sh.style.maxHeight = "none";
  const natural = Math.ceil(sh.getBoundingClientRect().height); // panel with everything showing
  const minSheet = Math.min(300, total * 0.45); // always keep the step title, a bit of the panel and Back/Next
  const smallest = 120;
  // Width available for the video between the note and the buttons (Large hides the note).
  const side = document.querySelector(".size-side").offsetWidth || 90;
  const note = Math.max(side, $("sizeNote").offsetWidth || 0);
  const wNote = row.clientWidth - side - note - 20, wLarge = row.clientWidth - side - 20;
  const maxH = total - minSheet;
  const m = Math.max(smallest + 50, Math.min(total - natural, total * 0.55, maxH, (wNote * 16) / 9));
  const sizes = {
    s: Math.max(smallest, Math.min(m * 0.65, m - 70)),
    m,
    l: Math.min(maxH, (wLarge * 16) / 9, Math.max(m + 90, total * 0.66)),
  };
  const wmax = state.size === "l" ? wLarge : wNote;
  const h = Math.max(smallest, Math.floor(sizes[state.size] || m));
  root.setProperty("--stage-h", `${h}px`);
  root.setProperty("--stage-wmax", `${Math.floor(wmax)}px`);
  // The panel takes everything below the play bar (the row can be taller than the video when the
  // note/buttons are taller).
  const rowH = Math.max(h, $("sizeNote").offsetHeight || 0, document.querySelector(".size-side").offsetHeight || 0);
  sh.style.maxHeight = `${Math.max(200, Math.floor(innerHeight - rowTop - rowH - scrubH - 6))}px`;
}
new ResizeObserver(() => {
  const sh = $("sheet");
  document.documentElement.style.setProperty("--sheet-h", `${sh.hidden ? 0 : Math.round(sh.getBoundingClientRect().height)}px`);
  fitStage();
}).observe($("sheet"));
window.addEventListener("resize", fitStage);
$("sheet").addEventListener("load", () => requestAnimationFrame(fitStage), true); // an image in the panel finished loading
// "Make video bigger / smaller" buttons beside the video.
function stepSize(d) {
  const k = Math.max(0, Math.min(SIZES.length - 1, SIZES.indexOf(state.size || "m") + d));
  setSize(SIZES[k]);
}
for (const id of ["sizeBigger", "sizeBigger2"]) $(id).addEventListener("click", (e) => { e.stopPropagation(); stepSize(1); });
for (const id of ["sizeSmaller", "sizeSmaller2"]) $(id).addEventListener("click", (e) => { e.stopPropagation(); stepSize(-1); });

// The note + moving arrow beside the size button (shown while editing, when there's room).
function placeSizeHint() {
  const hint = $("sizeHint");
  hint.hidden = true; return; // replaced by the Bigger / Smaller buttons beside the video
  const editing = document.body.classList.contains("sheet-open") && state.size !== "full" && state.project;
  if (!editing || recall("lp_size_hint_done")) { hint.hidden = true; return; } // once they've used it, they know
  hint.hidden = false;
  const r = $("sizeBtn").getBoundingClientRect();
  const stage = $("stage").getBoundingClientRect();
  const w = Math.min(190, window.innerWidth - 24);
  hint.style.width = `${w}px`;
  const left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w + 24));
  const top = r.top - hint.offsetHeight - 4;
  // Only show it where it won't cover the video.
  const overlaps = left < stage.right && left + w > stage.left && top < stage.bottom;
  if (overlaps || top < 60) { hint.hidden = true; return; }
  hint.style.left = `${left + window.scrollX}px`;
  hint.style.top = `${top + window.scrollY}px`;
  hint.querySelector(".hint-arrow").style.marginLeft = "";
}
window.addEventListener("resize", placeSizeHint);
$("stage").addEventListener("transitionend", placeSizeHint); // re-place after every resize animation
$("sheet").addEventListener("animationend", placeSizeHint);
window.addEventListener("scroll", placeSizeHint, { passive: true });
const cycleSize = (e) => {
  e.stopPropagation();
  setSize(SIZES[(SIZES.indexOf(state.size || "m") + 1) % SIZES.length]);
  document.querySelectorAll(".size-btn").forEach((b) => b.classList.add("used"));
  store("lp_size_hint_done", "1");
  placeSizeHint();
};
$("sizeBtn").addEventListener("click", cycleSize);
$("sizeBtnMain").addEventListener("click", cycleSize);
$("exitFull").addEventListener("click", () => setSize("m"));
setSize("m");

// ---------- saving ----------
const pending = new Set();
let saveTimer = null;
function save(keys) {
  keys.forEach((k) => pending.add(k));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 600);
  preview.draw();
}
async function flush() {
  clearTimeout(saveTimer);
  if (!pending.size || !state.project) return;
  const patch = {};
  for (const k of pending) patch[k] = state.project[k];
  pending.clear();
  try { await api(`/api/projects/${state.project.id}`, { method: "PUT", json: patch }); }
  catch (e) { if (!(e instanceof AuthError)) toast(`Couldn't save: ${e.message}`); }
}

// Download a file while reporting 0..1 progress.
async function fetchWithProgress(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  const total = +r.headers.get("Content-Length") || 0;
  if (!r.body || !total) return r.blob();
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got / total, got, total);
  }
  return new Blob(chunks, { type: r.headers.get("Content-Type") || "video/mp4" });
}

// "Loading your video…" with a percentage until the preview can show a frame.
let loadingVideo = false;
function showVideoLoading() {
  loadingVideo = true;
  busy("Loading your video", 0);
  const done = () => {
    if (!loadingVideo) return;
    loadingVideo = false;
    busy(null);
    ["progress", "loadeddata", "canplay", "error"].forEach((ev) => video.removeEventListener(ev, onEvt));
  };
  const onEvt = (e) => {
    if (e.type === "progress" && video.duration) {
      const b = video.buffered;
      const end = b.length ? b.end(b.length - 1) : 0;
      busy("Loading your video", Math.min(0.99, end / video.duration));
    } else if (e.type !== "progress") done();
  };
  ["progress", "loadeddata", "canplay", "error"].forEach((ev) => video.addEventListener(ev, onEvt));
  setTimeout(done, 25000); // never leave the overlay stuck
}

// ---------- project lifecycle ----------
function logoUrl(id) {
  const l = (state.settings?.logos || []).find((x) => x.id === id);
  return l ? l.url : "/static/brand/lollipop-logo.png";
}

async function openProject(p) {
  state.project = p;
  store("lp_project", p.id);
  const base = `/files/projects/${p.id}`;
  $("hero").hidden = true;
  $("stageWrap").hidden = false;
  $("scrub").hidden = false;
  $("hint").hidden = false;
  $("btnNew").hidden = false;
  if (!video.src.endsWith(`${base}/source.mp4`)) {
    showVideoLoading();
    video.src = `${base}/source.mp4`;
    video.load();
  }
  preview.setProject(p);
  preview.setPoster(`/api/projects/${p.id}/poster`);
  preview.setLogo(logoUrl(p.logo.id));
  preview.setBroll(p.broll || [], base);
  preview.setMusic(p.music?.file ? `${base}/${p.music.file}?v=${encodeURIComponent(p.music.name || "")}` : null);
  if (preview.needsMask()) preview.ensureMasker();
  document.querySelectorAll(".tools button").forEach((b) => (b.disabled = false));
  $("btnAuto").disabled = false;
  $("btnAuto").hidden = false;
  $("btnAuto").classList.toggle("done", !!p.autoEdited);
  $("btnAutoLabel").textContent = p.autoEdited ? "AI Edit" : "START HERE";
  $("btnAutoSub").textContent = p.autoEdited ? "Walk through your edits again" : "Tap for ✨ AI Edit";
  $("btnSave").hidden = !p.autoEdited;
  $("btnFine").hidden = !p.autoEdited;
  $("btnReport").hidden = false;
  renderBroll();
  renderWarnings();
  markTools();
}

function markTools() {
  const p = state.project;
  if (!p) return;
  const on = {
    trim: p.trim.start > 0.05 || p.trim.end < p.source.duration - 0.05,
    captions: p.captions.enabled && (p.captions.lines || []).length > 0,
    headline: p.headline.enabled && (p.headline.text || "").trim(),
    logo: p.logo.enabled,
    music: p.music.enabled && p.music.file,
    zoom: p.zoom.enabled && (p.zoom.segments || []).length > 0,
  };
  document.querySelectorAll(".tools button").forEach((b) => b.classList.toggle("on", !!on[b.dataset.tool]));
}

function renderWarnings() {
  const w = [...(state.project?.sourceWarnings || []), ...(state.project?.warnings || [])];
  $("warnings").hidden = !w.length;
  $("warnings").textContent = w.join("  •  ");
}

function resetToEmpty() {
  video.pause();
  video.removeAttribute("src");
  video.load();
  state.project = null;
  store("lp_project", null);
  $("hero").hidden = false;
  $("stageWrap").hidden = true;
  ["scrub", "hint", "brollStrip", "warnings", "btnNew", "btnSave", "btnFine", "fineTune", "btnReport"].forEach((id) => ($(id).hidden = true));
  setSize("m");
  document.querySelectorAll(".tools button").forEach((b) => (b.disabled = true));
  $("btnAuto").disabled = true;
  $("btnAuto").hidden = true;
  $("btnAuto").classList.remove("done");
  $("btnSave").classList.remove("ready");
  $("btnAutoLabel").textContent = "START HERE";
  $("btnAutoSub").textContent = "Tap for ✨ AI Edit";
  const c = $("canvas"); c.getContext("2d").clearRect(0, 0, c.width, c.height);
  preview.setProject(null);
  preview.setMusic(null);
  preview.setBroll([], "");
}

async function handleVideoFile(file) {
  if (!file) return;
  if (file.pieces) dlog("take uploading", { pieces: file.pieces.length, sizeMB: +(file.pieces.reduce((n, p) => n + p.file.size, 0) / 2 ** 20).toFixed(1) });
  else dlog("video chosen", { name: file.name, type: file.type, sizeMB: +(file.size / 2 ** 20).toFixed(1) });
  try {
    busy("Uploading… 0%", 0);
    // Weak signal or the server restarting for an update can drop an upload: retry a few times.
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        const fields = file.pieces?.length > 1
          ? { segments: file.pieces.map((p) => p.file), offsets: JSON.stringify(file.pieces.map((p) => p.offset)) }
          : { file: file.pieces ? file.pieces[0].file : file };
        res = await upload("/api/projects", fields, (f) => busy(`Uploading… ${Math.round(f * 100)}%`, f));
        break;
      } catch (e) {
        if (e instanceof AuthError || !e.network || attempt >= 4) throw e;
        dlog("upload retry", { attempt, message: e.message });
        for (let w = attempt * 4; w > 0; w--) { busy(`Connection dropped — retrying in ${w}s…`, 0); await new Promise((r) => setTimeout(r, 1000)); }
      }
    }
    busy("Preparing your video…", 0);
    store("lp_project", res.project.id); // so "Continue my last video" can finish it if interrupted
    await runJob(res.job, () => api(`/api/projects/${res.project.id}/prepare`, { method: "POST" }), (j) => busy(j.message, j.progress));
    const p = await api(`/api/projects/${res.project.id}`);
    busy(null);
    await openProject(p);
    toast("Video ready! Tap ✨ AI Edit");
  } catch (e) {
    busy(null);
    dlog("upload failed", { message: e.message });
    // Keep the video: offer to try again instead of losing the take.
    if (!(e instanceof AuthError)) showError("The upload didn't go through", e, () => handleVideoFile(file));
  }
}
$("inRecord").addEventListener("change", (e) => { handleVideoFile(e.target.files[0]); e.target.value = ""; });

// ---------- in-app camera ----------
// iPhone Safari's built-in "record" picker saves at reduced (medium) quality, and a web
// page can't change that. Recording the camera stream ourselves keeps full 1080p quality.
const cam = { stream: null, rec: null, chunks: [], facing: "user", timer: null, t0: 0 };
const camSupported = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
function camMime() {
  // Let Safari pick its own H.264 settings: forcing a codec profile gave recordings whose picture
  // stopped partway through on iPhone.
  for (const t of ["video/mp4", "video/mp4;codecs=avc1",
                   "video/webm;codecs=h264,opus", "video/webm;codecs=vp9,opus", "video/webm"]) {
    if (MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return "";
}
async function camStart() {
  camStop();
  const portrait = window.innerHeight >= window.innerWidth;
  // Raw microphone: our own audio cleanup does a better job than the phone-call filters.
  // Use iPhone's normal microphone processing. Turning it off (echoCancellation/noiseSuppression/
  // autoGainControl: false) triggers a Safari bug where the mic feed glitches and drops out.
  let audio = true;
  // In a car (Bluetooth/CarPlay) or with AirPods, iPhone records through the hands-free
  // "phone call" mic, which sounds choppy and cuts in and out. Ask for the iPhone's own mic.
  try {
    const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
    const builtIn = mics.find((d) => /iphone|built-?in|internal/i.test(d.label));
    if (builtIn && builtIn.deviceId) audio = { deviceId: { exact: builtIn.deviceId } };
  } catch (e) { /* use the default mic */ }
  // iPhone Safari interprets width/height in the camera sensor's (landscape) orientation in
  // some versions and in the screen's orientation in others. Asking the wrong way round
  // returns a cropped, zoomed-in feed, so try both and keep the one that matches the phone.
  const attempts = [
    { width: { ideal: 1920 }, height: { ideal: 1080 } },
    { width: { ideal: 1080 }, height: { ideal: 1920 } },
    { width: { ideal: 1280 }, height: { ideal: 720 } },
  ];
  let best = null, bestScore = -1;
  for (const size of attempts) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: cam.facing, frameRate: { ideal: 30 }, ...size }, audio });
    } catch (e) {
      if (audio !== true) { // that mic wasn't available: fall back to the default one
        audio = true;
        try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: cam.facing, frameRate: { ideal: 30 }, ...size }, audio }); }
        catch { continue; }
      } else continue;
    }
    const st = stream.getVideoTracks()[0].getSettings();
    const w = st.width || 0, h = st.height || 0;
    const matches = portrait ? h >= w : w >= h;
    const score = (matches ? 1e7 : 0) + Math.min(w, h) * Math.max(w, h) / 1000;
    if (score > bestScore) { best?.getTracks().forEach((t) => t.stop()); best = stream; bestScore = score; }
    else stream.getTracks().forEach((t) => t.stop());
    if (matches && Math.min(w, h) >= 1080) break; // good enough — stop asking
  }
  if (!best) throw new Error("camera unavailable");
  cam.stream = best;
  const track = best.getVideoTracks()[0];
  // Widest view the camera offers (like the iPhone Camera app's default).
  try {
    const caps = track.getCapabilities?.() || {};
    if (caps.zoom) await track.applyConstraints({ advanced: [{ zoom: caps.zoom.min }] });
  } catch (e) { /* zoom control not supported */ }
  const v = $("camView");
  v.srcObject = best;
  v.classList.toggle("mirror", cam.facing === "user");
  await v.play().catch(() => {});
  const st = track.getSettings();
  const w = st.width || v.videoWidth, h = st.height || v.videoHeight;
  // If the feed isn't shaped like the screen, show all of it instead of cropping in.
  v.classList.toggle("fit", portrait ? w > h : h > w);
  // Show which microphone is recording; warn if it's a car / Bluetooth hands-free mic.
  const micLabel = best.getAudioTracks()[0]?.label || "";
  const phoneMic = !micLabel || /iphone|built-?in|internal|default/i.test(micLabel);
  $("camMic").hidden = false;
  $("camMic").classList.toggle("warn", !phoneMic);
  $("camMic").textContent = phoneMic ? "🎙 iPhone mic" : `⚠️ Using “${micLabel}” mic — for clear sound, disconnect Bluetooth / CarPlay`;
  dlog("camera opened", { facing: cam.facing, settings: st, mic: micLabel,
    mics: (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === "audioinput").map((d) => d.label) });
  const short = Math.min(w || 0, h || 0);
  $("camQuality").textContent = short ? `${short >= 1080 ? "HD" : short + "p"} · ${Math.round(st.frameRate || 30)}` : "";
}
function camStop() {
  camCountdownCancel();
  clearTimeout(cam.tpDelay);
  if (cam.rec && cam.rec.state !== "inactive") { cam.rec.onstop = null; cam.rec.stop(); }
  cam.rec = null;
  camRecUI(false);
  clearInterval(cam.timer);
  cam.stream?.getTracks().forEach((t) => t.stop());
  cam.stream = null;
  $("camRec").classList.remove("on");
  $("camTime").hidden = true;
}
async function openCamera() {
  if (!camSupported()) { $("inRecord").click(); return; }
  $("cam").hidden = false;
  document.body.classList.add("cam-open");
  tpRender(); tpRestart();
  try { await camStart(); }
  catch (e) {
    console.warn(e);
    closeCamera();
    toast("Couldn't open the camera here — using the iPhone camera instead.", 3500);
    $("inRecord").click();
  }
}
function closeCamera() {
  camStop();
  tpPlay(false);
  $("tpEdit").hidden = true;
  $("cam").hidden = true;
  document.body.classList.remove("cam-open");
}
$("btnRecord").addEventListener("click", openCamera);
$("camClose").addEventListener("click", () => {
  if (!$("camReview").hidden && !confirm("Close the camera and delete this take?")) return;
  if (cam.rec && !confirm("Stop and delete this recording?")) return;
  camReviewClose(); cam.take = 0;
  closeCamera();
});
$("camNative").addEventListener("click", () => { closeCamera(); $("inRecord").click(); });
$("camFlip").addEventListener("click", async () => {
  if (cam.rec) return; // don't switch mid-recording
  cam.facing = cam.facing === "user" ? "environment" : "user";
  try { await camStart(); } catch { toast("Couldn't switch cameras."); }
});
$("camRec").addEventListener("click", () => {
  if (!cam.stream) return;
  if (cam.rec) { clearTimeout(cam.tpDelay); if (cam.rec.state === "paused") cam.rec.resume(); cam.rec.stop(); return; }
  if (cam.counting) { camCountdownCancel(); return; } // tap again during 3-2-1 to cancel
  camCountdown(camStartRec);
});
// 3-2-1 before recording so you can get set and read the first line.
function camCountdown(done) {
  let n = 3;
  const box = $("camCount");
  cam.counting = true;
  $("camRec").classList.add("counting");
  const show = () => { box.hidden = false; box.textContent = n; box.classList.remove("pop"); void box.offsetWidth; box.classList.add("pop"); };
  show();
  cam.countTimer = setInterval(() => {
    n -= 1;
    if (n > 0) { show(); return; }
    camCountdownCancel();
    done();
  }, 1000);
}
function camCountdownCancel() {
  clearInterval(cam.countTimer);
  cam.counting = false;
  $("camCount").hidden = true;
  $("camRec").classList.remove("counting");
}
// iPhone Safari's recorder can stop saving the picture after ~13-15 s while the sound keeps
// going. So a take is recorded as short overlapping pieces: a fresh recorder starts every
// SEG_LEN seconds and runs alongside the old one for SEG_OVERLAP s before the old one stops.
// The server lines the pieces up by their sound and joins them into one video.
const SEG_LEN = 8, SEG_OVERLAP = 1.2;
class SegmentedRecorder {
  constructor(stream, opts, elapsed) {
    this.stream = stream; this.opts = opts; this.elapsed = elapsed;
    this.state = "inactive"; this.mimeType = ""; this.segs = []; this.active = []; this.onstop = null; this.onerror = null;
  }
  _newSeg() {
    const mr = new MediaRecorder(this.stream, this.opts);
    const seg = { offset: this.elapsed(), chunks: [], mr };
    seg.done = new Promise((res) => {
      mr.ondataavailable = (e) => { if (e.data && e.data.size) seg.chunks.push(e.data); };
      mr.onstop = () => { this.active = this.active.filter((x) => x !== seg); res(); };
    });
    mr.onerror = (e) => this.onerror?.(e);
    mr.start(); // each piece is one continuous recording
    this.mimeType = mr.mimeType || this.mimeType;
    this.segs.push(seg); this.active.push(seg);
    return seg;
  }
  start() { this.state = "recording"; this._newSeg(); }
  // Called a few times a second while recording: start the next piece when it's time.
  tick() {
    if (this.state !== "recording" || this.rotating) return;
    const cur = this.segs[this.segs.length - 1];
    if (this.elapsed() - cur.offset < SEG_LEN) return;
    this.rotating = true;
    try {
      this._newSeg();
      setTimeout(() => { if (cur.mr.state !== "inactive") cur.mr.stop(); this.rotating = false; }, SEG_OVERLAP * 1000);
    } catch (e) {
      // Couldn't run two recorders at once: switch pieces back to back instead.
      dlog("overlap recorder failed", { message: String(e?.message || e) });
      cur.mr.onstop = ((orig) => () => { orig?.(); try { this._newSeg(); } catch {} this.rotating = false; })(cur.mr.onstop);
      cur.mr.stop();
    }
  }
  pause() { for (const s of this.active) if (s.mr.state === "recording") s.mr.pause(); this.state = "paused"; }
  resume() { for (const s of this.active) if (s.mr.state === "paused") s.mr.resume(); this.state = "recording"; }
  async stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    for (const s of [...this.active]) if (s.mr.state !== "inactive") s.mr.stop();
    await Promise.all(this.segs.map((s) => s.done));
    const type = this.mimeType || "video/mp4";
    const ext = type.includes("webm") ? "webm" : "mp4";
    const pieces = this.segs
      .map((s, i) => ({ offset: s.offset, file: new File([new Blob(s.chunks, { type })], `piece${i}.${ext}`, { type }) }))
      .filter((p) => p.file.size > 0);
    this.onstop?.(pieces, type);
  }
}
function camStartRec() {
  if (!cam.stream || cam.rec) return;
  const mimeType = camMime();
  const rec = new SegmentedRecorder(cam.stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 160_000 }, camElapsed);
  cam.rec = rec;
  // Watchdog: warn right away if the camera stops sending pictures while recording.
  const vtrack = cam.stream.getVideoTracks()[0];
  const view = $("camView");
  let lastFrameAt = performance.now();
  const onFrame = () => { lastFrameAt = performance.now(); if (cam.rec === rec && view.requestVideoFrameCallback) view.requestVideoFrameCallback(onFrame); };
  if (view.requestVideoFrameCallback) view.requestVideoFrameCallback(onFrame);
  const stalled = (why) => { if (!cam.stallLogged) { cam.stallLogged = true; dlog("camera stalled", { why: why?.type || why, at: (Date.now() - cam.t0) / 1000 }); } $("camMic").hidden = false; $("camMic").classList.add("warn");
    $("camMic").textContent = "⚠️ The camera stopped sending video. Tap stop and record again."; };
  vtrack.addEventListener("ended", stalled, { once: true });
  vtrack.addEventListener("mute", stalled, { once: true });
  cam.watch = setInterval(() => {
    if (cam.rec !== rec) { clearInterval(cam.watch); return; }
    if (view.requestVideoFrameCallback && performance.now() - lastFrameAt > 2500) stalled("no frames");
  }, 1000);
  rec.onstop = (pieces, type) => {
    tpPlay(false);
    const bytes = pieces.reduce((n, p) => n + p.file.size, 0);
    dlog("recording stopped", { seconds: camElapsed(), sizeMB: +(bytes / 2 ** 20).toFixed(1), type, pieces: pieces.length, offsets: pieces.map((p) => +p.offset.toFixed(2)) });
    cam.rec = null;
    camRecUI(false);
    if (!bytes) { toast("Nothing was recorded — please try again."); return; }
    // Release the camera while the take plays back: on iPhone, playing a video while the camera
    // is live can freeze the camera feed. Retake opens a fresh camera.
    cam.stream?.getTracks().forEach((t) => t.stop());
    cam.stream = null;
    camReview({ pieces, length: camElapsed() });
  };
  rec.onerror = (e) => dlog("recorder error", { message: String(e.error?.message || e.error || e) });
  cam.stallLogged = false;
  dlog("recording started", { mimeType: rec.mimeType || mimeType });
  cam.t0 = Date.now();
  cam.pausedMs = 0; cam.pausedAt = 0;
  rec.start();
  // Hold the first line on screen for a moment, then start scrolling.
  clearTimeout(cam.tpDelay);
  cam.tpDelay = setTimeout(() => { if (cam.rec === rec && rec.state === "recording") tpPlay(true); }, 2000);
  camRecUI(true);
  $("camTime").textContent = "0:00";
  cam.timer = setInterval(() => { $("camTime").textContent = fmt(camElapsed()); rec.tick(); }, 250);
}
// Recording time, not counting pauses.
function camElapsed() {
  const now = cam.pausedAt || Date.now();
  return (now - cam.t0 - (cam.pausedMs || 0)) / 1000;
}
function camRecUI(on) {
  $("camRec").classList.toggle("on", on);
  $("camTime").hidden = !on;
  $("camPause").hidden = !on;
  $("camPause").textContent = "⏸ Pause";
  $("camPause").classList.remove("paused");
  $("camNative").hidden = on;
  $("camFlip").style.visibility = on ? "hidden" : "";
  $("tpOpen").hidden = on;
  if (!on) clearInterval(cam.timer);
}
// Pause / resume in the middle of a take (the teleprompter pauses with it).
$("camPause").addEventListener("click", () => {
  const rec = cam.rec; if (!rec) return;
  if (rec.state === "recording") {
    try { rec.pause(); } catch { toast("Pausing isn't supported on this phone — tap stop instead."); return; }
    cam.pausedAt = Date.now(); tpPlay(false);
    $("camPause").textContent = "▶ Resume"; $("camPause").classList.add("paused");
    $("camTime").classList.add("paused");
    dlog("recording paused", { at: camElapsed() });
  } else if (rec.state === "paused") {
    rec.resume();
    cam.pausedMs += Date.now() - cam.pausedAt; cam.pausedAt = 0; tpPlay(true);
    $("camPause").textContent = "⏸ Pause"; $("camPause").classList.remove("paused");
    $("camTime").classList.remove("paused");
    dlog("recording resumed", { at: camElapsed() });
  }
});
// After a take: play it back; "Use this take" uploads it, "Retake" throws it away.
function camReview(take) {
  cam.take = (cam.take || 0) + 1;
  cam.reviewFile = take;
  cam.reviewUrls = take.pieces.map((p) => URL.createObjectURL(p.file));
  const v = $("camReviewVid");
  $("camReviewTitle").textContent = `Take ${cam.take} · ${fmt(take.length)}`;
  $("camReviewWarn").hidden = true;
  $("camReview").hidden = false;
  cam.reviewBroken = false;
  (async () => {
    // Check every piece: if one's picture stops early, the phone dropped video there.
    for (let i = 0; i < cam.reviewUrls.length && cam.reviewFile === take; i++) {
      v.src = cam.reviewUrls[i];
      const end = await checkTakePicture(v);
      if (end != null) {
        const at = take.pieces[i].offset + end;
        cam.reviewBroken = true;
        $("camReviewWarn").hidden = false;
        $("camReviewWarn").textContent = `⚠️ Your iPhone stopped recording the picture at ${fmt(at)} (the sound kept going). Please tap Retake.`;
        dlog("take picture stopped early", { at, piece: i, pieceLength: v.duration });
        break;
      }
    }
    if (cam.reviewFile !== take) return;
    // Play the pieces back to back.
    let i = 0;
    v.onended = () => { if (++i < cam.reviewUrls.length) { v.src = cam.reviewUrls[i]; v.play().catch(() => {}); } };
    v.src = cam.reviewUrls[0];
    v.play().catch(() => {});
  })();
}
function camReviewClose() {
  const v = $("camReviewVid");
  v.onended = null;
  v.pause(); v.removeAttribute("src"); v.load();
  for (const u of cam.reviewUrls || []) URL.revokeObjectURL(u);
  cam.reviewUrls = []; cam.reviewFile = null;
  $("camReview").hidden = true;
}
// Jump to the end of the take and see which frame shows: if the last picture is from much
// earlier, the phone stopped recording video partway through. Returns that time, or null if fine.
async function checkTakePicture(v) {
  try {
    if (!v.requestVideoFrameCallback) return null;
    if (!(v.readyState >= 1)) await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
    if (!isFinite(v.duration) || v.duration < 4) return null;
    const target = Math.max(0, v.duration - 0.3);
    const seek = (t) => new Promise((res) => {
      const to = setTimeout(res, 3000);
      v.addEventListener("seeked", () => { clearTimeout(to); res(); }, { once: true });
      v.currentTime = t;
    });
    await seek(target);
    // Only now listen for a frame, then nudge the position so a fresh frame is shown: this
    // avoids reading the very first frame (0:00) that may appear while the jump is happening.
    const shown = new Promise((res) => {
      const to = setTimeout(() => res(null), 3000);
      v.requestVideoFrameCallback((now, meta) => { clearTimeout(to); res(meta.mediaTime); });
    });
    await seek(Math.max(0, target - 0.05));
    const last = await shown;
    if (last == null || last < 0.2) return null; // no clear answer: don't raise a false alarm
    return last < v.duration - 2 ? last : null;
  } catch { return null; }
}
$("camRetake").addEventListener("click", async () => {
  if (!confirm("Delete this take and record again?")) return;
  dlog("take discarded", { take: cam.take });
  camReviewClose();
  tpRestart(); // script back to the beginning
  try {
    await camStart(); // fresh camera feed
    toast("Ready — tap the red button when you are.");
  } catch (e) {
    dlog("camera restart failed", { message: String(e?.message || e) });
    toast("Couldn't restart the camera — close it and tap Record again.", 4500);
  }
});
$("camUse").addEventListener("click", () => {
  const file = cam.reviewFile; if (!file) return;
  if (cam.reviewBroken && !confirm("The picture in this take stops partway through. Use it anyway?")) return;
  dlog("take used", { take: cam.take });
  cam.reviewFile = null; // keep it from being freed before upload
  camReviewClose();
  cam.take = 0;
  closeCamera();
  handleVideoFile(file); // now upload + prepare for AI Edit
});
// ---------- teleprompter ----------
// Script scrolls in the top half of the camera screen (near the lens). It starts scrolling when
// you start recording, pauses when you stop, and you can drag it with a finger any time.
const tp = { speed: +(recall("lp_tp_speed") || 3), size: +(recall("lp_tp_size") || 30), playing: false, raf: 0, last: 0, acc: 0 };
function tpScript() { return recall("lp_tp_script") || ""; }
function tpRender() {
  const text = tpScript().trim();
  const show = !!text && recall("lp_tp_hidden") !== "1";
  $("tp").hidden = !show;
  $("cam").classList.toggle("has-tp", show);
  $("tpOpen").textContent = "📜 Teleprompter";
  // One continuous block of text — no blank lines between sentences or paragraphs.
  $("tpText").textContent = text.replace(/\s*\n\s*/g, " ");
  $("tpText").style.fontSize = `${tp.size}px`;
  $("tp").style.setProperty("--tp-size", `${tp.size}px`);
  $("tpSpeed").textContent = tp.speed;
}
function tpTick(now) {
  if (!tp.playing) return;
  const dt = Math.min(0.1, (now - (tp.last || now)) / 1000);
  tp.last = now;
  const box = $("tpScroll");
  // Speed 1–10 ≈ lines per 10 s, scaled to the text size so bigger text doesn't race ahead.
  tp.acc += dt * tp.speed * tp.size * 0.2;
  if (tp.acc >= 1) { const px = Math.floor(tp.acc); tp.acc -= px; box.scrollTop += px; }
  if (box.scrollTop + box.clientHeight >= box.scrollHeight - 1) { tpPlay(false); return; }
  tp.raf = requestAnimationFrame(tpTick);
}
function tpPlay(on) {
  tp.playing = on && !$("tp").hidden;
  $("tpPlay").textContent = tp.playing ? "⏸" : "▶";
  cancelAnimationFrame(tp.raf);
  if (tp.playing) { tp.last = 0; tp.raf = requestAnimationFrame(tpTick); }
}
function tpRestart() { tpPlay(false); $("tpScroll").scrollTop = 0; tp.acc = 0; }
function tpSet(k, v) { tp[k] = v; store(k === "speed" ? "lp_tp_speed" : "lp_tp_size", v); tpRender(); }
$("tpOpen").addEventListener("click", () => {
  tpPlay(false);
  $("tpInput").value = tpScript();
  tpCount();
  $("tpEdit").hidden = false;
  setTimeout(() => $("tpInput").focus(), 50);
});
$("tpSave").addEventListener("click", () => {
  // No blank lines or line breaks: the script is one continuous block of text.
  const flat = $("tpInput").value.replace(/\s*\n\s*/g, " ").replace(/ {2,}/g, " ").trim();
  store("lp_tp_script", flat || null);
  store("lp_tp_hidden", null);
  $("tpEdit").hidden = true;
  tpRender(); tpRestart();
});
function tpCount() {
  const words = ($("tpInput").value.match(/\S+/g) || []).length;
  const secs = Math.round(words / 2.5); // typical speaking pace ≈ 150 words a minute
  $("tpCount").textContent = `${words} words · about ${secs < 60 ? secs + " s" : fmt(secs)} to read`;
}
$("tpInput").addEventListener("input", tpCount);
$("tpClear").addEventListener("click", () => { $("tpInput").value = ""; tpCount(); $("tpInput").focus(); });
// Changed their mind about a script: leave the camera and go back to the start screen.
$("tpBack").addEventListener("click", () => { if (cam.rec) return; camReviewClose(); cam.take = 0; closeCamera(); });
$("tpEdit").addEventListener("click", (e) => { if (e.target === $("tpEdit")) $("tpEdit").hidden = true; });
$("tpPlay").addEventListener("click", () => tpPlay(!tp.playing));
$("tpRestart").addEventListener("click", tpRestart);
$("tpSlower").addEventListener("click", () => tpSet("speed", Math.max(1, tp.speed - 1)));
$("tpFaster").addEventListener("click", () => tpSet("speed", Math.min(10, tp.speed + 1)));
$("tpSmaller").addEventListener("click", () => tpSet("size", Math.max(20, tp.size - 4)));
$("tpBigger").addEventListener("click", () => tpSet("size", Math.min(56, tp.size + 4)));
$("tpHide").addEventListener("click", () => { tpPlay(false); store("lp_tp_hidden", "1"); tpRender(); });
$("tpText").addEventListener("click", () => tpPlay(!tp.playing)); // tap the words to pause / resume
tpRender();

// ---------- 🍭 AI script writer (HOPS: Hook → Objection → Problem → Solution) ----------
const ai = { seconds: +(recall("lp_ai_seconds") || 30) };
function aiLengths() {
  for (const b of $("aiLengths").children) b.classList.toggle("on", +b.dataset.s === ai.seconds);
}
$("aiOpen").addEventListener("click", () => {
  const open = $("aiPanel").hidden;
  $("aiPanel").hidden = !open;
  $("aiOpen").classList.toggle("on", open);
  if (open) { $("aiTopic").value = $("aiTopic").value || recall("lp_ai_topic") || ""; aiLengths(); setTimeout(() => $("aiTopic").focus(), 50); }
});
$("aiLengths").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  ai.seconds = +b.dataset.s; store("lp_ai_seconds", ai.seconds); aiLengths();
});
$("aiGo").addEventListener("click", async () => {
  const topic = $("aiTopic").value.trim();
  if (topic.length < 3) { toast("Type a topic first — e.g. “why mortgage rates are high”"); $("aiTopic").focus(); return; }
  store("lp_ai_topic", topic);
  if ($("tpInput").value.trim() && !confirm("Replace the script that's already in the teleprompter?")) return;
  const btn = $("aiGo"); btn.disabled = true;
  const steps = ["Searching the latest news…", "Writing your hook…", "Handling the objection…", "Laying out the problem…", "Writing the solution…"];
  const t0 = Date.now();
  const tick = setInterval(() => {
    const secs = (Date.now() - t0) / 1000;
    const pct = Math.min(95, Math.round(100 * (1 - Math.exp(-secs / 25)))); // estimate: most scripts take 20–60 s
    $("aiGoText").textContent = `${steps[Math.min(steps.length - 1, Math.floor(pct / 20))]} ${pct}%`;
    $("aiGoBar").style.width = `${pct}%`;
  }, 300);
  dlog("ai script requested", { seconds: ai.seconds });
  try {
    const r = await api("/api/script", { method: "POST", json: { topic, seconds: ai.seconds } });
    $("aiGoBar").style.width = "100%";
    $("tpInput").value = r.script.replace(/\s*\n\s*/g, " "); tpCount();
    $("aiResult").hidden = false;
    $("aiResult").replaceChildren(
      el("h4", {}, `✅ ${r.title || "Your script"} · ${r.seconds}s`),
      el("div", { class: "ai-parts" }, el("span", {}, "Hook"), el("span", {}, "Objection"), el("span", {}, "Problem"), el("span", {}, "Solution")),
      r.sources?.length ? el("div", {}, el("div", { class: "note" }, "Based on:"),
        ...r.sources.map((s) => el("a", { href: s.url, target: "_blank", rel: "noopener" }, s.title))) : null,
    );
    toast("Script ready! Read it over, then tap “Use in teleprompter”.", 3500);
    $("tpInput").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (e) {
    dlog("ai script failed", { message: e.message });
    if (!(e instanceof AuthError)) toast(e.message, 5000);
  } finally {
    clearInterval(tick); btn.disabled = false;
    $("aiGoText").textContent = "✨ Write my script"; setTimeout(() => ($("aiGoBar").style.width = "0"), 600);
  }
});
// Landing page shortcut: open the camera with the script writer ready.
$("btnAiWriter").addEventListener("click", async () => {
  await openCamera();
  if ($("cam").hidden) return;
  $("tpOpen").click();
  if (!tpScript().trim() && $("aiPanel").hidden) $("aiOpen").click(); // no script yet: offer the AI writer
});

for (const id of ["btnReport", "btnReport2"]) $(id)?.addEventListener("click", sendReport);
$("inUpload").addEventListener("change", (e) => { handleVideoFile(e.target.files[0]); e.target.value = ""; });
$("btnNew").addEventListener("click", () => { if (confirm("Start a new video? (This one stays saved on the server for 14 days.)")) resetToEmpty(); });

// ---------- AI edit (analysis + guided steps) ----------
async function runAnalysis() {
  const p = state.project;
  preview.pause();
  closeSheet();
  await flush();
  busy("Starting AI Edit…", 0);
  const start = () => api(`/api/projects/${p.id}/auto-edit`, { method: "POST" });
  await runJob(await start(), start, (j) => busy(j.message, j.progress));
  const fresh = await api(`/api/projects/${p.id}`);
  busy(null);
  await openProject(fresh);
}

$("btnAuto").addEventListener("click", async () => {
  const p = state.project;
  if (!p) return;
  try {
    if (!p.autoEdited) await runAnalysis();
    showStep(0);
  } catch (e) {
    busy(null);
    if (!(e instanceof AuthError)) toast(e.message, 5000);
  }
});

$("btnReanalyze").addEventListener("click", async () => {
  if (!confirm("Re-run the AI analysis? This replaces your captions, zooms and B-roll (your headline, logo and music stay).")) return;
  try { await runAnalysis(); showStep(0); }
  catch (e) { busy(null); if (!(e instanceof AuthError)) toast(e.message, 5000); }
});

$("btnFine").addEventListener("click", () => {
  const open = $("fineTune").hidden;
  $("fineTune").hidden = !open;
  $("btnFine").textContent = open ? "Hide manual controls ▴" : "Fine-tune manually ▾";
});

// ---------- save / export ----------
async function saveVideo() {
  const p = state.project;
  if (!p) return;
  preview.pause();
  closeSheet();
  await flush();
  let url;
  try {
    // One bar for the whole save: building on the server = 0-90%, download to the phone = 90-100%.
    busy("Saving your video", 0);
    const start = () => api(`/api/projects/${p.id}/render`, { method: "POST" });
    const done = await runJob(await start(), start, (j) => busy(j.status === "queued" ? "Waiting for the server…" : j.message, j.progress * 0.9));
    url = done.result.url;
  } catch (e) {
    busy(null);
    if (!(e instanceof AuthError)) showError("Saving didn't finish", e, saveVideo);
    return;
  }
  busy(null);
  // Show the finished video right away (it streams); the file for Save / Share downloads
  // in the background, with its progress on the Save button.
  showExport(null, url);
  const myUrl = url;
  fetchWithProgress(url, (f) => { if (state.exportPending === myUrl) setSaveProgress(f); })
    .then((blob) => { if (state.exportPending === myUrl) showExport(blob, url, true); })
    .catch((e) => { console.warn("download failed", e); if (state.exportPending === myUrl) showExport(null, url, true, true); });
}
function setSaveProgress(f) {
  const b = document.querySelector("#resultActions .save-wait");
  if (b) b.textContent = `Getting it ready to save… ${Math.round(f * 100)}%`;
}
$("btnSave").addEventListener("click", saveVideo);

function showExport(blob, url, refresh = false, failed = false) {
  // refresh: the background download finished — just update the buttons, keep the video playing.
  const pending = !blob && !failed && !refresh;
  state.exportPending = pending ? url : null;
  const file = blob ? new File([blob], "lollipop-video.mp4", { type: "video/mp4" }) : null;
  const canShare = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
  closeSheet();
  preview.pause();
  const v = $("resultVideo");
  if (!refresh) {
    if (state.exportUrl) URL.revokeObjectURL(state.exportUrl);
    state.exportUrl = null;
    v.src = url;
  }
  const acts = $("resultActions");
  acts.innerHTML = "";
  if (pending) {
    acts.append(el("button", { class: "btn btn-primary save-wait", disabled: true }, "Getting it ready to save… 0%"));
  } else if (canShare) {
    acts.append(el("button", {
      class: "btn btn-primary", onclick: async () => {
        v.pause();
        try { await navigator.share({ files: [file] }); }
        catch (e) { if (e.name !== "AbortError") toast("Sharing didn't open — use “Open video” instead.", 5000); }
      },
    }, "Save to iPhone / Share"));
  }
  const bubbles = socialBubbles(file, url, v);
  if (pending) bubbles.classList.add("waiting");
  acts.append(bubbles);
  acts.append(
    el("p", { class: "note center" }, canShare
      ? "Then choose “Save Video” for Photos — or send to Messages, Instagram, TikTok, Facebook, LinkedIn or YouTube."
      : "Tap “Open video”, then Share (square with arrow) → “Save Video”."),
    el("a", { class: "small-btn wide", href: url, target: "_blank", rel: "noopener" }, "Open video"),
    el("button", { class: "btn result-done", onclick: closeToStart }, "✅ All done — back to start"));
  $("result").hidden = false;
  document.body.classList.add("result-open");
  if (!refresh) v.play().catch(() => {}); // starts right away when allowed; otherwise tap ▶
}

// Instagram / TikTok / Facebook bubbles: save the video, then jump into the app.
const SOCIAL = [
  { name: "Messages", icon: "/icons/messages.png", text: true },
  { name: "Instagram", icon: "/icons/instagram.png", app: "instagram://camera", web: "https://www.instagram.com/" },
  { name: "TikTok", icon: "/icons/tiktok.png", app: "snssdk1233://", web: "https://www.tiktok.com/upload" },
  { name: "Facebook", icon: "/icons/facebook.png", app: "fb://", web: "https://www.facebook.com/" },
];
function socialBubbles(file, url, player) {
  const row = el("div", { class: "social-row" });
  for (const s of SOCIAL) {
    row.append(el("button", { class: "social-bubble", onclick: () => postTo(s, file, url, player) },
      el("img", { src: s.icon, alt: "" }), el("span", {}, s.name)));
  }
  return row;
}
async function postTo(s, file, url, player) {
  player.pause();
  // Messages: a web page can't attach a video to an sms: link, so the iPhone share
  // sheet is the way in — the video arrives already attached, ready to text.
  if (s.text) {
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      toast("Tap “Messages” to text your video", 2200);
      try { await navigator.share({ files: [file] }); } catch (e) { /* closed the sheet */ }
    } else {
      window.location.href = `sms:&body=${encodeURIComponent("Check out my video: " + new URL(url, location.href).href)}`;
    }
    return;
  }
  // a) Save the video. On the web, the iPhone share sheet is the only way to get it into Photos.
  let saved = false;
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); saved = true; }
    catch (e) { if (e.name === "AbortError") return; } // they closed the sheet: don't jump away
  } else {
    window.open(url, "_blank"); // can't share files here: open the video so it can be saved
  }
  // b) Toast, c) open the app, d) fall back to the website if the app didn't open.
  toast(saved ? `Saved! Opening ${s.name}…` : `Opening ${s.name}…`, 1000);
  setTimeout(() => {
    let left = false;
    const onHide = () => { left = true; };
    document.addEventListener("visibilitychange", onHide, { once: true });
    window.addEventListener("pagehide", onHide, { once: true });
    window.location.href = s.app;
    setTimeout(() => {
      document.removeEventListener("visibilitychange", onHide);
      if (!left && document.visibilityState === "visible") window.location.href = s.web;
    }, 1500);
  }, 1000);
}

// Close the finished-video screen and go back to the start page. The video stays saved on the
// server, so "Continue my last video" can reopen it.
function closeToStart() {
  const pid = state.project?.id;
  $("resultVideo").pause();
  if (pid) store("lp_project", pid);
  location.href = "/";
}
$("resultClose").addEventListener("click", closeToStart);
$("resultBack").addEventListener("click", () => {
  state.exportPending = null; // a background download finishing later shouldn't reopen this screen
  $("resultVideo").pause();
  $("result").hidden = true;
  document.body.classList.remove("result-open");
});

// ---------- b-roll ----------
function renderBroll() {
  const p = state.project;
  const list = $("brollList");
  list.innerHTML = "";
  if (!p || !p.autoEdited) { $("brollStrip").hidden = true; return; }
  $("brollStrip").hidden = false;
  if (!(p.broll || []).length) {
    list.append(el("div", { class: "broll-empty" },
      state.status?.stock ? "No B-roll moments found in this video." : "B-roll is off — add a Pixabay key or upload your own clips (My clips)."));
    return;
  }
  const base = `/files/projects/${p.id}`;
  for (const b of p.broll) {
    list.append(el("div", { class: `bclip${b.removed ? " removed" : ""}` },
      el("div", { class: "bclip-thumb", onclick: () => { preview.pause(); video.currentTime = b.start + 0.05; } },
        el("img", { src: `${base}/${b.thumb}`, alt: "" }),
        el("span", { class: "bclip-time" }, fmt(b.start - p.trim.start))),
      el("div", { class: "bclip-q", title: b.credit || "" }, b.query),
      el("div", { class: "bclip-actions" },
        b.removed
          ? el("button", { class: "keep", onclick: () => { b.removed = false; save(["broll"]); renderBroll(); } }, "Keep")
          : el("button", { class: "remove", onclick: () => { b.removed = true; save(["broll"]); renderBroll(); } }, "Remove"),
        b.source === "stock" ? el("button", { onclick: () => swapBroll(b) }, "Swap") : null)));
  }
}

async function swapBroll(b) {
  const p = state.project;
  await flush();
  try {
    busy("Finding another clip…", 0.1);
    const start = () => api(`/api/projects/${p.id}/broll/${b.id}/swap`, { method: "POST" });
    await runJob(await start(), start, (j) => busy(j.message, j.progress));
    busy(null);
    await openProject(await api(`/api/projects/${p.id}`));
    refreshSheet();
  } catch (e) { busy(null); if (!(e instanceof AuthError)) toast(e.message, 4000); }
}

$("btnClips").addEventListener("click", () => openSheet("clips"));

// ---------- bottom sheets ----------
function closeSheet() {
  $("sheet").hidden = true;
  document.body.classList.remove("sheet-open");
  placeSizeHint();
  state.sheet = null;
  state.wizard = null;
  fitStage();
  preview.ghostCaptions = false;
  preview.draw();
  markTools();
}
$("sheetDone").addEventListener("click", closeSheet);

const TITLES = { trim: "Trim", captions: "Captions", headline: "Cinematic Headline", logo: "Logo", music: "Music & Voice", zoom: "Auto Zoom", clips: "My B-roll clips" };
const BUILDERS = { trim: () => trimSheet(), captions: () => captionsSheet(), headline: () => headlineSheet(), logo: () => logoSheet(), music: () => musicSheet(), zoom: () => zoomSheet(), clips: () => clipsSheet() };

function renderSheet({ key, title, step, content, footer }) {
  state.sheet = key;
  $("sheet").classList.remove("tall");
  $("sheetTitle").textContent = title || "";
  $("sheetStep").hidden = !step;
  $("sheetStep").textContent = step || "";
  const body = $("sheetBody");
  const keepScroll = body.dataset.key === key ? body.scrollTop : 0;
  body.dataset.key = key;
  body.innerHTML = "";
  body.append(...content.filter(Boolean));
  body.scrollTop = keepScroll;
  const foot = $("sheetFoot");
  foot.innerHTML = "";
  foot.hidden = !footer;
  if (footer) foot.append(...footer.filter(Boolean));
  preview.ghostCaptions = key === "captions";
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (!document.body.classList.contains("sheet-open") || state.size === "full") setSize("m");
  document.body.classList.add("sheet-open");
  $("sheet").hidden = false; // no backdrop: the preview stays draggable while a panel is open
  [60, 300, 700].forEach((ms) => setTimeout(placeSizeHint, ms));
  requestAnimationFrame(fitStage);
  [250, 800, 1600].forEach((ms) => setTimeout(fitStage, ms)); // pictures/filmstrips that load in late
  preview.draw();
}

function openSheet(tool, title, content) {
  if (!state.project && tool !== "clips" && tool !== "error") return;
  state.wizard = null;
  state.sheet = tool; // so the builders know which panel they're in
  renderSheet({ key: tool, title: title || TITLES[tool], content: content || BUILDERS[tool]() });
}

function refreshSheet() {
  if (state.wizard != null) showStep(state.wizard);
  else if (state.sheet && BUILDERS[state.sheet]) openSheet(state.sheet);
}

// The guided AI Edit: one simple choice per screen, then watch and save.
const STEPS = [
  { key: "trim", title: "Trim, cut & remove pauses", build: () => trimSheet() },
  { key: "captions", title: "Pick a caption style", build: () => captionsStep() },
  { key: "headline", title: "Add a headline", build: () => headlineStep() },
  { key: "logo", title: "Your logo", build: () => logoSheet() },
  { key: "zoom", title: "Auto zoom", build: () => zoomStep() },
  { key: "broll", title: "B-roll clips", build: () => brollStep() },
  { key: "music", title: "Background music", build: () => musicSheet() },
];

function showStep(i) {
  if (!state.project) return;
  preview.pause();
  state.wizard = i;
  const st = STEPS[i], last = i === STEPS.length - 1;
  renderSheet({
    key: st.key, title: st.title, step: `Step ${i + 1} of ${STEPS.length}`,
    content: st.build(),
    footer: [
      el("div", { class: "dots" }, ...STEPS.map((_, j) => el("span", { class: j === i ? "on" : j < i ? "done" : "" }))),
      el("div", { class: "foot-btns" },
        i > 0 ? el("button", { class: "small-btn", onclick: () => showStep(i - 1) }, "‹ Back") : el("span"),
        el("button", { class: "btn btn-primary next-btn", onclick: () => (last ? finishWizard() : showStep(i + 1)) },
          last ? "See my video ✨" : "Next ›")),
    ],
  });
}

async function finishWizard() {
  closeSheet();
  await flush();
  const p = state.project;
  $("btnSave").hidden = false;
  $("btnSave").classList.add("ready");
  $("btnFine").hidden = false;
  video.currentTime = p.trim.start;
  preview.play(); // this tap counts as permission to play with sound
  toast("Here's your video! Like it? Tap Save Video.", 4000);
}

document.querySelectorAll(".tools button").forEach((b) => b.addEventListener("click", () => openSheet(b.dataset.tool)));

// small UI builders
function toggle(label, checked, onchange) {
  return el("div", { class: "row" }, el("span", {}, label),
    el("label", { class: "toggle" }, el("input", { type: "checkbox", checked, onchange: (e) => onchange(e.target.checked) }), el("span")));
}
function slider(label, { min, max, step = 1, value, fmt: f = (v) => v, oninput }) {
  const out = el("span", { class: "note" }, f(value));
  const inp = el("input", { type: "range", min, max, step, value });
  const paint = () => inp.style.setProperty("--p", `${((inp.value - min) / (max - min)) * 100}%`);
  paint();
  inp.addEventListener("input", () => { paint(); out.textContent = f(+inp.value); oninput(+inp.value); });
  return el("div", { class: "field" }, el("div", { class: "row" }, el("label", { class: "label" }, label), out), inp);
}
// Advanced settings stay tucked away so each step shows just a few big choices.
const MORE_HINTS = {
  trim: "fine-tune, cut out the middle", captions: "font, fix a word", headline: "colors, fonts, cut-out",
  logo: "see-through, save default", music: "auto-lower, voice cleanup",
};
function more(open, ...kids) {
  const hint = MORE_HINTS[state.wizard != null ? STEPS[state.wizard]?.key : state.sheet];
  const d = el("details", { class: "more" },
    el("summary", {}, "More options", hint ? el("small", {}, ` (${hint})`) : null), ...kids.flat().filter(Boolean));
  if (open) d.open = true;
  d.addEventListener("toggle", () => { store("lp_more_" + (state.sheet || ""), d.open ? "1" : null); requestAnimationFrame(fitStage); });
  return d;
}
function chips(label, options, current, onpick) {
  const wrap = el("div", { class: "chips" });
  const draw = (cur) => {
    wrap.innerHTML = "";
    for (const o of options) {
      const [val, text, style] = Array.isArray(o) ? o : [o, o, null];
      wrap.append(el("button", { class: `chip${val === cur ? " on" : ""}`, style, onclick: () => { onpick(val); draw(val); } }, text));
    }
  };
  draw(current);
  return el("div", { class: "field" }, label ? el("label", { class: "label" }, label) : null, wrap);
}
// 10 ready-made colors + a color wheel for any custom color.
const PALETTE_DEFAULT = ["#FFFFFF", "#E9E1D3", "#E3202A", "#F2C230", "#FF7A1A", "#FF3D8B", "#8B5CF6", "#2F80ED", "#14B8A6", "#22C55E"];
// Headline: rich, muted "luxury" tones — white, ivory, champagne, antique gold, burnt copper, berry,
// oxblood, deep teal (Tiffany family), deep ocean, forest, midnight navy, cognac leather, onyx
// (+ color wheel = 14, two rows of 7).
const HEADLINE_PALETTE = ["#FFFFFF", "#EFE6D2", "#E3D3A3", "#C9A227", "#C2602A", "#9E2F57", "#7F1A22",
  "#2A8C86", "#1D4E6E", "#1E4D36", "#14213D", "#7A4B2A", "#121212"];
function swatches(label, colors, current, onpick) {
  const PALETTE = colors || PALETTE_DEFAULT;
  const wrap = el("div", { class: `swatches${colors ? " swatches-7" : ""}` });
  const preview = el("span", { class: "color-now" });
  const draw = (cur) => {
    wrap.innerHTML = "";
    const c0 = (cur || "").toUpperCase();
    for (const c of PALETTE) {
      wrap.append(el("button", { class: `swatch${c === c0 ? " on" : ""}`, style: `background:${c}`, "aria-label": c,
        onclick: () => { onpick(c); draw(c); } }));
    }
    // Color wheel: the native iPhone color picker (grid / spectrum / sliders).
    const custom = !PALETTE.includes(c0) && c0;
    const inp = el("input", { type: "color", value: /^#[0-9A-F]{6}$/.test(c0) ? c0.toLowerCase() : "#ffffff" });
    inp.addEventListener("input", () => { onpick(inp.value.toUpperCase()); preview.style.background = inp.value; });
    inp.addEventListener("change", () => draw(inp.value.toUpperCase()));
    wrap.append(el("label", { class: `swatch wheel${custom ? " on" : ""}`, title: "Pick any color",
      style: custom ? `--custom:${c0}` : "" }, inp));
    preview.style.background = cur || "#FFFFFF";
  };
  draw(current);
  return el("div", { class: "field" },
    el("div", { class: "row" }, el("label", { class: "label" }, label), preview), wrap);
}

// ----- TRIM (filmstrip with draggable handles) -----
let trimUI = null;
let pendingCut = null; // start time of a cut being marked
const fmtT = (s) => { s = Math.max(0, s || 0); return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`; };
function trimSheet() {
  const p = state.project, dur = p.source.duration;
  const MIN = 1; // shortest allowed video, seconds
  const strip = el("div", { class: "strip", style: `background-image:url(/api/projects/${p.id}/filmstrip?v=2)` });
  const shadeL = el("div", { class: "shade l" }), shadeR = el("div", { class: "shade r" });
  const box = el("div", { class: "trim-box" });
  const hL = el("div", { class: "handle l" }, el("span")), hR = el("div", { class: "handle r" }, el("span"));
  const head = el("div", { class: "playhead" });
  const cutLayer = el("div", { class: "cut-layer" });
  const wrap = el("div", { class: "strip-wrap" }, strip, cutLayer, shadeL, shadeR, box, hL, hR, head);
  const lblStart = el("span"), lblLen = el("span", { class: "len" }), lblEnd = el("span");
  const labels = el("div", { class: "strip-labels" }, lblStart, lblLen, lblEnd);

  const pct = (t) => `${(t / dur) * 100}%`;
  const paint = () => {
    const { start, end } = p.trim;
    shadeL.style.width = pct(start);
    shadeR.style.width = `${(1 - end / dur) * 100}%`;
    box.style.left = hL.style.left = pct(start);
    box.style.right = `${(1 - end / dur) * 100}%`;
    hR.style.left = pct(end);
    lblStart.textContent = `Start ${fmtT(start)}`;
    lblEnd.textContent = `End ${fmtT(end)}`;
    lblLen.textContent = `${fmtT(keptDuration(keptSegments(p.trim, effectiveCuts(p))))} final`;
    // Red = sections you cut; striped = pauses AI removes.
    cutLayer.innerHTML = "";
    const mark = (c, cls) => cutLayer.append(el("div", { class: `cutmark ${cls}`, style: `left:${pct(c.start)};width:${((c.end - c.start) / dur) * 100}%` }));
    if (p.removePauses !== false) (p.pauseCuts || []).forEach((c) => mark(c, "auto"));
    (p.cuts || []).forEach((c) => mark(c, "manual"));
    if (pendingCut != null) mark({ start: Math.min(pendingCut, video.currentTime), end: Math.max(pendingCut, video.currentTime) }, "pending");
  };
  const timeAt = (e) => {
    const r = wrap.getBoundingClientRect();
    return Math.min(dur, Math.max(0, ((e.clientX - r.left) / r.width) * dur));
  };
  const drag = (which) => (e) => {
    e.preventDefault(); e.stopPropagation();
    preview.pause();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    target.classList.add("active");
    const move = (ev) => {
      const t = timeAt(ev);
      if (which === "l") p.trim.start = +Math.min(t, p.trim.end - MIN).toFixed(2);
      else p.trim.end = +Math.max(t, p.trim.start + MIN).toFixed(2);
      video.currentTime = which === "l" ? p.trim.start : Math.max(p.trim.start, p.trim.end - 0.04);
      paint();
    };
    const up = () => {
      target.classList.remove("active");
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      save(["trim"]); markTools();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
    move(e);
  };
  hL.addEventListener("pointerdown", drag("l"));
  hR.addEventListener("pointerdown", drag("r"));
  // Tap or slide anywhere else on the strip to scrub the preview.
  wrap.addEventListener("pointerdown", (e) => {
    preview.pause();
    wrap.setPointerCapture(e.pointerId);
    const seek = (ev) => { video.currentTime = timeAt(ev); };
    seek(e);
    const up = () => { wrap.removeEventListener("pointermove", seek); wrap.removeEventListener("pointerup", up); };
    wrap.addEventListener("pointermove", seek);
    wrap.addEventListener("pointerup", up);
  });
  trimUI = { head, dur, paint };
  paint();
  const nudge = (which, d) => () => {
    if (which === "l") p.trim.start = +Math.min(Math.max(0, p.trim.start + d), p.trim.end - MIN).toFixed(2);
    else p.trim.end = +Math.max(Math.min(dur, p.trim.end + d), p.trim.start + MIN).toFixed(2);
    preview.pause();
    video.currentTime = which === "l" ? p.trim.start : Math.max(p.trim.start, p.trim.end - 0.04);
    paint(); save(["trim"]);
  };
  const cutBits = cutControls(paint);
  const pauseBits = cutBits.splice(-3); // [title, toggle, note]
  return [
    el("p", { class: "note" }, "Drag the yellow handles to cut the start and end."),
    labels,
    wrap,
    pauseBits[1],
    more(recall("lp_more_trim") || pendingCut != null || (p.cuts || []).length > 0,
    el("div", { class: "nudges" },
      el("div", { class: "nudge" }, el("span", { class: "label" }, "Start"),
        el("button", { class: "small-btn", onclick: nudge("l", -0.1) }, "−0.1s"),
        el("button", { class: "small-btn", onclick: nudge("l", 0.1) }, "+0.1s")),
      el("div", { class: "nudge" }, el("span", { class: "label" }, "End"),
        el("button", { class: "small-btn", onclick: nudge("r", -0.1) }, "−0.1s"),
        el("button", { class: "small-btn", onclick: nudge("r", 0.1) }, "+0.1s"))),
    el("div", { class: "grid2" },
      el("button", { class: "small-btn", onclick: () => { p.trim.start = +Math.min(video.currentTime, p.trim.end - MIN).toFixed(2); paint(); save(["trim"]); } }, "Start at playhead"),
      el("button", { class: "small-btn", onclick: () => { p.trim.end = +Math.max(video.currentTime, p.trim.start + MIN).toFixed(2); paint(); save(["trim"]); } }, "End at playhead")),
    el("button", { class: "small-btn wide", onclick: () => { p.trim = { start: 0, end: dur }; save(["trim"]); refreshSheet(); } }, "Reset trim"),
    ...cutBits,
    pauseBits[2]),
  ];
}

// Cut sections out of the middle (stumbles, retakes) + automatic pause removal.
function cutControls(paint) {
  const p = state.project;
  p.cuts = p.cuts || [];
  const pauses = p.pauseCuts || [];
  const saved = pauses.reduce((n, c) => n + (c.end - c.start), 0);
  const out = [el("div", { class: "section-title" }, "✂ Cut out the middle")];
  if (pendingCut == null) {
    out.push(
      el("p", { class: "note" }, "Move the white line to where the mistake starts, tap “Start cut”, move to where it ends, then tap “End cut”."),
      el("button", { class: "small-btn wide cut-btn", onclick: () => { preview.pause(); pendingCut = +video.currentTime.toFixed(2); refreshSheet(); } }, "✂ Start cut here"));
  } else {
    out.push(
      el("p", { class: "note warn" }, `Cut starts at ${fmtT(pendingCut)}. Now move the white line to where it should end.`),
      el("div", { class: "grid2" },
        el("button", { class: "small-btn", onclick: () => { pendingCut = null; refreshSheet(); } }, "Cancel"),
        el("button", { class: "small-btn cut-btn", onclick: () => {
          const a = Math.min(pendingCut, video.currentTime), b = Math.max(pendingCut, video.currentTime);
          pendingCut = null;
          if (b - a < 0.1) { toast("Move the white line first, so there's something to cut."); refreshSheet(); return; }
          p.cuts.push({ start: +a.toFixed(2), end: +b.toFixed(2) });
          save(["cuts"]); refreshSheet(); toast(`Cut ${(b - a).toFixed(1)}s`);
        } }, "✂ End cut here")));
  }
  p.cuts.forEach((c, i) => out.push(el("div", { class: "row cut-row" },
    el("span", {}, `✂ ${fmtT(c.start)} → ${fmtT(c.end)}  (${(c.end - c.start).toFixed(1)}s)`),
    el("button", { class: "link", onclick: () => { p.cuts.splice(i, 1); save(["cuts"]); refreshSheet(); } }, "Undo"))));
  out.push(
    el("div", { class: "section-title" }, "⏸ Remove pauses"),
    toggle(pauses.length ? `Remove ${pauses.length} pause${pauses.length === 1 ? "" : "s"} automatically (saves ${saved.toFixed(1)}s)` : "Remove pauses automatically",
      p.removePauses !== false, (v) => { p.removePauses = v; save(["removePauses"]); paint && paint(); }),
    el("p", { class: "note" }, pauses.length
      ? "AI cuts the dead air between your sentences, like Captions AI. Striped areas on the strip are the pauses it removes."
      : "AI Edit finds the pauses between your sentences; none long enough were found."));
  return out;
}

// ----- CAPTIONS -----
let captionRows = [];
function highlightCaptionRow(t) {
  if (state.sheet !== "captions") return;
  for (const r of captionRows) r.row.classList.toggle("active", r.line.start <= t && t < r.line.end + 0.25);
}
function captionsSheet() {
  const p = state.project, c = p.captions, s = c.style;
  const changed = () => save(["captions"]);
  const out = [toggle("Show captions", c.enabled !== false, (v) => { c.enabled = v; changed(); })];
  if (!(c.lines || []).length) {
    out.push(el("p", { class: `note${state.status && !state.status.transcriptionReady ? " warn" : ""}` },
      state.status && !state.status.transcriptionReady
        ? "Transcription isn't set up on the server yet (see SETUP.md — OpenAI key)."
        : "Tap Auto Edit to transcribe your video into captions."));
  }
  out.push(
    el("p", { class: "note" }, "Drag the captions on the preview to move them. Pinch to resize."),
    chips("Position", [["top", "Top"], ["middle", "Middle"], ["bottom", "Bottom"]], null, (v) => { s.y = { top: 0.2, middle: 0.5, bottom: 0.72 }[v]; s.x = 0.5; changed(); }),
    fontPicker("Font", FONTS_CAPTION, s.font, (v) => { s.font = v; changed(); }),
    slider("Size", { min: 32, max: 140, value: s.size || 66, oninput: (v) => { s.size = v; changed(); } }),
    swatches("Text color", null, s.color, (v) => { s.color = v; changed(); }),
    chips("Spoken-word highlight", [["color", "Colored word"], ["box", "Box behind word"]], s.highlightStyle || "color", (v) => { s.highlightStyle = v; changed(); }),
    swatches("Highlight color", null, s.highlight, (v) => { s.highlight = v; changed(); }),
    chips("Words at a time", [1, 2, 3, 4].map((n) => [n, String(n)]), s.maxWords || 3, (n) => {
      s.maxWords = n;
      const words = (c.lines || []).flatMap((l) => l.words);
      c.lines = buildCaptionLines(words, n);
      changed(); refreshSheet();
    }),
    chips("Animation", [["pop", "Pop"], ["none", "None"]], s.animation || "pop", (v) => { s.animation = v; changed(); }),
    toggle("ALL CAPS", s.uppercase !== false, (v) => { s.uppercase = v; changed(); }),
  );
  if ((c.lines || []).length) {
    out.push(el("div", { class: "field" }, el("label", { class: "label" }, "Fix words (tap a line to jump there; clear it to delete)"), captionLinesList()));
  }
  return out;
}

// ----- HEADLINE -----
function headlineSheet() {
  const h = state.project.headline;
  const changed = () => { save(["headline"]); if (preview.needsMask()) preview.ensureMasker(); };
  const ta = el("textarea", { rows: 3, placeholder: "YOUR *NEXT 10 YEARS*\nARE HIDDEN IN YOUR\nDAILY ROUTINE." });
  ta.value = h.text || "";
  ta.addEventListener("input", () => { h.text = ta.value; if (h.text.trim()) h.enabled = true; changed(); });
  return [
    toggle("Show headline", !!h.enabled, (v) => { h.enabled = v; changed(); }),
    el("div", { class: "field" }, el("label", { class: "label" }, "Headline text"), ta,
      el("p", { class: "note" }, "This stays on screen the whole video. Put *stars* around words to color them. Press return for a new line.")),
    el("div", { class: "toggles" },
      toggle("Square block", h.block !== false, (v) => { h.block = v; changed(); }),
      toggle("Behind me (AI cut-out)", h.behind !== false, (v) => { h.behind = v; changed(); refreshSheet(); }),
      h.behind !== false ? toggle("Extra-sharp (slower save)", h.cutout === "best", (v) => { h.cutout = v ? "best" : "sharp"; changed(); }) : null),
    el("p", { class: "note" }, "Drag the headline on the preview to move it. Pinch to resize."),
    fontPicker("Font", FONTS_HEADLINE, h.font, (v) => { h.font = v; changed(); }),
    slider("Size", { min: 50, max: 320, value: h.size || 150, oninput: (v) => { h.size = v; changed(); } }),
    swatches("Main color", HEADLINE_PALETTE, h.color, (v) => { h.color = v; changed(); }),
    swatches("*Starred* word color", HEADLINE_PALETTE, h.accent, (v) => { h.accent = v; changed(); }),
    toggle("ALL CAPS", h.uppercase !== false, (v) => { h.uppercase = v; changed(); }),
  ];
}

// ----- LOGO -----
function logoSheet() {
  const p = state.project, l = p.logo;
  const changed = () => save(["logo"]);
  const grid = el("div", { class: "logos" });
  // "No logo" first: every video starts without one.
  grid.append(el("div", { class: `logo-opt logo-none${l.enabled ? "" : " on"}`, onclick: () => { l.enabled = false; changed(); refreshSheet(); } }, "No logo"));
  for (const opt of state.settings.logos) {
    grid.append(el("div", { class: `logo-opt${l.enabled && opt.id === l.id ? " on" : ""}`, onclick: () => { l.id = opt.id; l.enabled = true; preview.setLogo(opt.url); changed(); refreshSheet(); } },
      el("img", { src: opt.url, alt: opt.name }),
      opt.builtin ? null : el("button", { class: "x", onclick: async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete “${opt.name}”?`)) return;
        state.settings = await api(`/api/logos/${opt.id}`, { method: "DELETE" });
        if (l.id === opt.id) { l.id = "lollipop"; preview.setLogo(logoUrl("lollipop")); changed(); }
        refreshSheet();
      } }, "×")));
  }
  const inp = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });
  inp.addEventListener("change", async () => {
    const f = inp.files[0];
    if (!f) return;
    const name = prompt("Name this logo (e.g. Horizon Pacific Lending)", f.name.replace(/\.[^.]+$/, "")) || "My logo";
    try {
      state.settings = await upload("/api/logos", { file: f, name });
      const added = state.settings.logos[state.settings.logos.length - 1];
      l.id = added.id; l.enabled = true;
      preview.setLogo(added.url); changed(); refreshSheet();
    } catch (e) { toast(e.message); }
  });
  grid.append(el("label", { class: "logo-opt logo-add" }, inp, "+ Add logo"));
  const pos = { tl: [0.2, 0.07], top: [0.5, 0.07], tr: [0.8, 0.07], bl: [0.2, 0.93], bottom: [0.5, 0.93], br: [0.8, 0.93] };
  return [
    el("p", { class: "note" }, "Tap one of your logos, or “+ Add logo” to save a new one from your phone for this and future videos."),
    grid,
    chips("Where?", [["tl", "↖"], ["top", "Top"], ["tr", "↗"], ["bl", "↙"], ["bottom", "Bottom"], ["br", "↘"]], null, (v) => { [l.x, l.y] = pos[v]; changed(); }),
    slider("Size", { min: 0.06, max: 0.9, step: 0.01, value: l.w ?? 0.3, fmt: (v) => `${Math.round(v * 100)}%`, oninput: (v) => { l.w = v; changed(); } }),
    more(recall("lp_more_logo"),
    el("p", { class: "note" }, "Drag the logo on the video to move it, pinch to resize. A PNG with a see-through background looks best."),
    slider("Opacity", { min: 0.2, max: 1, step: 0.05, value: l.opacity ?? 1, fmt: (v) => `${Math.round(v * 100)}%`, oninput: (v) => { l.opacity = v; changed(); } }),
    el("button", { class: "small-btn wide", onclick: async () => {
      state.settings = await api("/api/settings", { method: "PUT", json: { defaultLogo: l.id, logoDefaults: { x: l.x, y: l.y, w: l.w, opacity: l.opacity ?? 1 } } });
      toast("Saved — new videos will use this logo and position.");
    } }, "★ Save as my default")),
  ];
}

// A button that steps once per tap and keeps stepping while held down.
function holdButton(label, aria, step) {
  const b = el("button", { class: "rock", "aria-label": aria }, label);
  let wait = null, rep = null;
  const stop = () => { clearTimeout(wait); clearInterval(rep); wait = rep = null; };
  b.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    stop();
    step();
    wait = setTimeout(() => { rep = setInterval(step, 70); }, 400);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => b.addEventListener(ev, stop));
  b.addEventListener("contextmenu", (e) => e.preventDefault()); // no iPhone long-press menu
  return b;
}

// Big − / + buttons (1% per tap, hold to keep going) and a slider; the level stays where you put it.
function volumeRocker(m, changed) {
  const pctOf = (v) => Math.round((v ?? 0.2) * 100);
  const out = el("span", { class: "vol-pct" }, `${pctOf(m.volume)}%`);
  const inp = el("input", { type: "range", min: 0, max: 100, step: 1, value: pctOf(m.volume) });
  const paint = () => {
    inp.value = pctOf(m.volume);
    inp.style.setProperty("--p", `${inp.value}%`);
    out.textContent = `${inp.value}%`;
  };
  const set = (v) => { m.volume = Math.round(Math.min(1, Math.max(0, v)) * 100) / 100; paint(); changed(); preview.syncMusic(); };
  inp.addEventListener("input", () => set(+inp.value / 100));
  paint();
  return el("div", { class: "field" },
    el("div", { class: "row" }, el("label", { class: "label" }, "Music volume"), out),
    el("div", { class: "rocker" },
      holdButton("−", "Quieter", () => set((m.volume ?? 0.2) - 0.01)),
      inp,
      holdButton("+", "Louder", () => set((m.volume ?? 0.2) + 0.01))));
}

// ----- MUSIC -----
function musicSheet() {
  const p = state.project, m = p.music;
  const changed = () => save(["music"]);
  const inp = el("input", { type: "file", accept: "audio/*,.mp3,.m4a,.wav,.aac", hidden: true });
  inp.addEventListener("change", async () => {
    const f = inp.files[0];
    if (!f) return;
    try {
      busy("Uploading music…", 0);
      const fresh = await upload(`/api/projects/${p.id}/music`, { file: f }, (x) => busy(`Uploading music… ${Math.round(x * 100)}%`, x));
      busy(null);
      p.music = fresh.music;
      preview.setMusic(`/files/projects/${p.id}/${p.music.file}?v=${Date.now()}`);
      refreshSheet();
      toast("Music added — press play to hear it.");
    } catch (e) { busy(null); toast(e.message); }
  });
  return [
    el("div", { class: "row" },
      el("div", { class: "music-name" }, m.file ? `♪ ${m.name || "Music"}` : "No music yet"),
      el("label", { class: "small-btn" }, inp, m.file ? "Change" : "Choose music")),
    m.file ? null : el("p", { class: "note" }, "Optional. Pick an MP3/M4A from your Files app (Apple Music songs can't be used)."),
    m.file ? toggle("Use music", m.enabled !== false, (v) => { m.enabled = v; changed(); }) : null,
    m.file ? volumeRocker(m, changed) : null,
    more(recall("lp_more_music"),
      m.file ? toggle("Auto-lower music while I talk", m.autoDuck === true, (v) => { m.autoDuck = v; changed(); }) : null,
      toggle("Clean up my voice", p.audio?.clean !== false, (v) => { p.audio = { ...(p.audio || {}), clean: v }; save(["audio"]); }),
      el("p", { class: "note" }, "Voice cleanup removes background noise and evens out loudness when you save.")),
  ];
}

// ----- ZOOM -----
function zoomSheet() {
  const z = state.project.zoom;
  const changed = () => save(["zoom"]);
  const n = (z.segments || []).length;
  return [
    toggle("Auto zoom", z.enabled !== false, (v) => { z.enabled = v; changed(); }),
    chips("Strength", [["subtle", "Subtle"], ["medium", "Medium"], ["strong", "Strong"]], z.intensity || "medium", (v) => {
      const old = INTENSITY[z.intensity || "medium"], nu = INTENSITY[v];
      for (const s of z.segments || []) s.scale = +(nu + (s.scale - old)).toFixed(3);
      z.intensity = v; changed();
    }),
    el("p", { class: "note" }, n
      ? `${n} zoom moment${n === 1 ? "" : "s"} found on the words you emphasize. Your face stays framed.`
      : "Tap Auto Edit to find zoom moments in your speech."),
  ];
}

// ----- guided-step builders -----
// Three simple looks: big & boxy, thin, fun & curly.
const CAPTION_PRESETS = [
  { name: "Big & Boxy", style: { font: "Montserrat", color: "#FFFFFF", highlight: "#E3202A", highlightStyle: "box", boxText: "#FFFFFF", stroke: 7, uppercase: true, animation: "pop", size: 64 } },
  { name: "Thin", style: { font: "Bebas Neue", color: "#FFFFFF", highlight: "#F2C230", highlightStyle: "color", stroke: 6, uppercase: true, animation: "pop", size: 84 } },
  { name: "Fun & Curly", style: { font: "Lobster", color: "#FFFFFF", highlight: "#F2C230", highlightStyle: "color", stroke: 6, uppercase: false, animation: "pop", size: 72 } },
];
const HEADLINE_PRESETS = [
  { name: "Big & Boxy", font: "Anton", color: "#EFE6D2", accent: "#7F1A22", block: true },
  { name: "Thin", font: "Bebas Neue", color: "#FFFFFF", accent: "#C9A227", block: true },
  { name: "Fun & Curly", font: "Lobster", color: "#FFFFFF", accent: "#C9A227", block: false },
];

function presetCard({ label, sample, font, color, accent, upper, on, onpick, box = false, boxText = "#FFFFFF" }) {
  const words = sample.split(" ");
  const txt = (w) => (upper ? w.toUpperCase() : w);
  const accentStyle = box ? `background:${accent};color:${boxText};border-radius:5px;padding:0 3px;text-shadow:none` : `color:${accent}`;
  return el("button", { class: `preset${on ? " on" : ""}`, onclick: onpick },
    el("div", { class: "preset-sample", style: `font-family:"${font}";color:${color}` },
      ...words.map((w, i) => el("span", { style: i === 1 ? accentStyle : "" }, txt(w)), " ").flatMap((x) => [x, " "])),
    el("div", { class: "preset-name" }, label));
}

function captionsStep() {
  const p = state.project, c = p.captions, s = c.style;
  const changed = () => save(["captions"]);
  const same = (st) => c.enabled !== false && st.font === s.font && st.highlight === s.highlight
    && (st.highlightStyle || "color") === (s.highlightStyle || "color");
  const grid = el("div", { class: "presets presets-4" },
    ...CAPTION_PRESETS.map((pr) => presetCard({
      label: pr.name, sample: "Your first home", font: pr.style.font, color: pr.style.color, accent: pr.style.highlight,
      upper: pr.style.uppercase, on: same(pr.style), box: pr.style.highlightStyle === "box", boxText: pr.style.boxText,
      onpick: () => { Object.assign(s, pr.style); c.enabled = true; changed(); refreshSheet(); },
    })),
    el("button", { class: `preset off${c.enabled === false ? " on" : ""}`, onclick: () => { c.enabled = false; changed(); refreshSheet(); } },
      el("div", { class: "preset-sample" }, "—"), el("div", { class: "preset-name" }, "None")));
  const out = [];
  if (!(c.lines || []).length) {
    out.push(el("p", { class: "note warn" }, "No speech was found, so there are no captions to show."));
  }
  out.push(el("p", { class: "note" }, "Tap a look."), grid);
  if (c.enabled !== false) {
    out.push(
      chips("Where on screen?", [["top", "Top"], ["middle", "Middle"], ["bottom", "Bottom"]],
        s.y < 0.35 ? "top" : s.y < 0.6 ? "middle" : "bottom",
        (v) => { s.y = { top: 0.2, middle: 0.5, bottom: 0.72 }[v]; s.x = 0.5; changed(); }),
      slider("Size", { min: 32, max: 140, value: s.size || 66, oninput: (v) => { s.size = v; changed(); } }),
      more(recall("lp_more_captions"),
        fontPicker("Font", FONTS_CAPTION, s.font, (v) => { s.font = v; changed(); }),
        (c.lines || []).length ? el("div", { class: "field" }, el("label", { class: "label" }, "Fix a misspelled word"), captionLinesList()) : null));
  }
  return out;
}

function captionLinesList() {
  const p = state.project, c = p.captions;
  const list = el("div", { class: "cap-lines" });
  captionRows = [];
  c.lines.forEach((line, i) => {
    const input = el("input", { type: "text", value: line.words.map((w) => w.w).join(" "), enterkeyhint: "done" });
    input.addEventListener("focus", () => { preview.pause(); video.currentTime = line.start + 0.01; });
    input.addEventListener("change", () => {
      const updated = retimeLine(line, input.value);
      if (updated) c.lines[i] = updated; else c.lines.splice(i, 1);
      save(["captions"]);
      if (!updated) refreshSheet();
    });
    const row = el("div", { class: "cap-line" }, el("span", { class: "t" }, fmt(line.start - p.trim.start)), input);
    captionRows.push({ row, line });
    list.append(row);
  });
  return list;
}

function headlineStep() {
  const h = state.project.headline;
  const changed = () => { save(["headline"]); if (preview.needsMask()) preview.ensureMasker(); };
  const ta = el("textarea", { rows: 2, placeholder: "Type a headline (or leave empty)\ne.g. YOUR *FIRST HOME*" });
  ta.value = h.text || "";
  ta.addEventListener("input", () => { h.text = ta.value; h.enabled = !!h.text.trim(); changed(); });
  const sample = (h.text || "").replace(/\*/g, "").split(/\s+/).filter(Boolean).slice(0, 3).join(" ") || "Big news today";
  return [
    el("p", { class: "note" }, "Big words behind you. Optional — leave empty to skip. *Stars* color a word."),
    ta,
    el("div", { class: "presets presets-3" }, ...HEADLINE_PRESETS.map((pr) => presetCard({
      label: pr.name, sample, font: pr.font, color: pr.color, accent: pr.accent, upper: pr.font !== "Lobster",
      on: h.font === pr.font,
      onpick: () => { Object.assign(h, { font: pr.font, color: pr.color, accent: pr.accent, block: pr.block, uppercase: pr.font !== "Lobster" }); changed(); refreshSheet(); },
    }))),
    slider("Size", { min: 50, max: 320, value: h.size || 130, oninput: (v) => { h.size = v; changed(); } }),
    more(recall("lp_more_headline"),
      swatches("Color", HEADLINE_PALETTE, h.color, (v) => { h.color = v; changed(); }),
      swatches("*Starred* word color", HEADLINE_PALETTE, h.accent, (v) => { h.accent = v; changed(); }),
      fontPicker("Font", FONTS_HEADLINE, h.font, (v) => { h.font = v; changed(); }),
      el("div", { class: "toggles" },
        toggle("Square block", h.block !== false, (v) => { h.block = v; changed(); }),
        toggle("Behind me (AI cut-out)", h.behind !== false, (v) => { h.behind = v; changed(); refreshSheet(); }),
        h.behind !== false ? toggle("Extra-sharp (slower save)", h.cutout === "best", (v) => { h.cutout = v ? "best" : "sharp"; changed(); }) : null),
      el("p", { class: "note" }, "Tip: drag the headline on the video to move it, pinch to resize.")),
  ];
}

function zoomStep() {
  const z = state.project.zoom;
  const n = (z.segments || []).length;
  const cur = z.enabled === false ? "off" : z.intensity || "medium";
  return [
    el("p", { class: "note" }, n
      ? `AI found ${n} moment${n === 1 ? "" : "s"} where you emphasize a word. Pick how strong the zoom-in should be.`
      : "No zoom moments were found in this video."),
    chips(null, [["off", "Off"], ["subtle", "Subtle"], ["medium", "Medium"], ["strong", "Strong"]], cur, (v) => {
      if (v === "off") z.enabled = false;
      else {
        const old = INTENSITY[z.intensity || "medium"], nu = INTENSITY[v];
        for (const s of z.segments || []) s.scale = +(nu + (s.scale - old)).toFixed(3);
        z.intensity = v; z.enabled = true;
      }
      save(["zoom"]);
    }),
  ];
}

function brollStep() {
  const p = state.project;
  const base = `/files/projects/${p.id}`;
  const list = p.broll || [];
  if (!list.length) {
    return [el("p", { class: "note" }, state.status?.stock
      ? "No good B-roll moments were found in this video. That's OK — tap Next."
      : "B-roll is off. Add a Pixabay key in Render, or upload your own clips under “My clips”.")];
  }
  return [
    el("p", { class: "note" }, "AI picked these clips to show while you talk. Tap one to see it."),
    el("div", { class: "bgrid" }, ...list.map((b) => el("div", { class: `bclip${b.removed ? " removed" : ""}` },
      el("div", { class: "bclip-thumb", onclick: () => { preview.pause(); video.currentTime = b.start + 0.05; } },
        el("img", { src: `${base}/${b.thumb}`, alt: "" }),
        el("span", { class: "bclip-time" }, fmt(b.start - p.trim.start))),
      el("div", { class: "bclip-q" }, b.query),
      el("div", { class: "bclip-actions" },
        b.removed
          ? el("button", { class: "keep", onclick: () => { b.removed = false; save(["broll"]); renderBroll(); refreshSheet(); } }, "Keep")
          : el("button", { class: "remove", onclick: () => { b.removed = true; save(["broll"]); renderBroll(); refreshSheet(); } }, "Remove"),
        b.source === "stock" ? el("button", { onclick: () => swapBroll(b) }, "Swap") : null)))),
  ];
}

// ----- MY CLIPS (b-roll library) -----
function clipsSheet() {
  const clips = state.settings?.clips || [];
  const tag = el("input", { type: "text", placeholder: "Topic, e.g. keys, new home, office" });
  const inp = el("input", { type: "file", accept: "video/*", hidden: true });
  inp.addEventListener("change", async () => {
    const f = inp.files[0];
    if (!f) return;
    if (!tag.value.trim()) { toast("Type a topic first, so Auto Edit knows when to use this clip."); inp.value = ""; return; }
    try {
      busy("Uploading clip…", 0);
      await upload("/api/clips", { file: f, tag: tag.value }, (x) => busy(`Uploading clip… ${Math.round(x * 100)}%`, x));
      busy(null);
      state.settings = await api("/api/settings");
      refreshSheet();
      toast("Clip saved. It will be used when you say that topic.");
    } catch (e) { busy(null); toast(e.message); }
  });
  return [
    el("p", { class: "note" }, "Upload your own footage and give it a topic. When you mention that topic in a video, Auto Edit uses your clip as B-roll. Otherwise it picks licensed stock footage (Pixabay / Pexels)."),
    el("div", { class: "field" }, el("label", { class: "label" }, "Topic"), tag),
    el("label", { class: "small-btn wide" }, inp, "+ Upload clip"),
    ...clips.map((c) => el("div", { class: "row" }, el("span", {}, `🎬 ${c.tag}`),
      el("button", { class: "link", onclick: async () => {
        await api(`/api/clips/${c.id}`, { method: "DELETE" });
        state.settings = await api("/api/settings");
        refreshSheet();
      } }, "Delete"))),
  ];
}

// ---------- login ----------
function showLogin() { $("login").hidden = false; setTimeout(() => $("loginPw").focus(), 50); }
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/login", { method: "POST", json: { password: $("loginPw").value } });
    $("login").hidden = true;
    $("loginErr").textContent = "";
    boot();
  } catch (err) { $("loginErr").textContent = err.message; }
});

// ---------- boot ----------
async function boot() {
  try {
    state.status = await api("/api/status");
    state.settings = await api("/api/settings");
    loadBrandFonts();
    await Promise.all(["Anton", "Bebas Neue", "Oswald", "Montserrat", "Poppins", "Playfair", "Lobster"].map((f) => document.fonts.load(`40px "${f}"`)));
    // Always open on the start page; the last video is one tap away.
    const last = recall("lp_project");
    if (last) {
      $("btnContinue").hidden = false;
      $("btnContinue").onclick = async () => {
        try {
          const p = await api(`/api/projects/${last}`);
          if (p.status === "ready") await openProject(p);
          else {
            // An upload that was interrupted (e.g. the server restarted): finish preparing it.
            const start = () => api(`/api/projects/${last}/prepare`, { method: "POST" });
            busy("Finishing your video…", 0);
            await runJob(await start(), start, (j) => busy(j.message, j.progress));
            busy(null);
            await openProject(await api(`/api/projects/${last}`));
          }
        } catch (e) {
          busy(null);
          if (e instanceof AuthError) return;
          store("lp_project", null); $("btnContinue").hidden = true; toast("That video isn't available any more.");
        }
      };
    }
  } catch (e) {
    if (!(e instanceof AuthError)) toast(e.message, 5000);
  }
}
document.querySelectorAll(".tools button").forEach((b) => (b.disabled = true));
document.fonts.ready.then(() => preview.draw());
boot();
