import { Preview } from "./preview.js";
import { buildCaptionLines, effectiveCuts, keptDuration, keptSegments, outToSrc, retimeLine, srcToOut } from "./timeline.js";

const $ = (id) => document.getElementById(id);
const video = document.createElement("video");
video.playsInline = true;
video.setAttribute("playsinline", "");
video.preload = "auto";

const state = { project: null, settings: null, status: null, sheet: null, wizard: null, exportUrl: null };
const FONTS_CAPTION = ["Montserrat", "Anton", "Bebas Neue", "Poppins", "Oswald", "Playfair"];
const FONTS_HEADLINE = ["Anton", "Bebas Neue", "Oswald", "Montserrat", "Playfair"];
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
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const x = new XMLHttpRequest();
    x.open("POST", url);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    x.onload = () => {
      if (x.status === 401) { showLogin(); return reject(new AuthError("login")); }
      let d = {}; try { d = JSON.parse(x.responseText); } catch {}
      x.status < 300 ? resolve(d) : reject(new Error(d.detail || `Upload failed (${x.status})`));
    };
    x.onerror = () => reject(new Error("Upload failed — check your connection."));
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
        throw new Error("The server restarted while working (this happens when the app updates). Please tap the button again.");
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

function showError(title, err, retry) {
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
  preview.draw();
  placeSizeHint();
  setTimeout(placeSizeHint, 260); // after the resize animation
}

// The note + moving arrow beside the size button (shown while editing, when there's room).
function placeSizeHint() {
  const hint = $("sizeHint");
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
$("exitFull").addEventListener("click", () => setSize(document.body.classList.contains("sheet-open") ? "s" : "m"));
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
  const w = state.project?.warnings || [];
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
  ["scrub", "hint", "brollStrip", "warnings", "btnNew", "btnSave", "btnFine", "fineTune"].forEach((id) => ($(id).hidden = true));
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
  try {
    busy("Uploading… 0%", 0);
    const res = await upload("/api/projects", { file }, (f) => busy(`Uploading… ${Math.round(f * 100)}%`, f));
    busy("Preparing your video…", 0);
    await waitJob(res.job, (j) => busy(j.message, j.progress));
    const p = await api(`/api/projects/${res.project.id}`);
    busy(null);
    await openProject(p);
    toast("Video ready! Tap ✨ AI Edit");
  } catch (e) {
    busy(null);
    if (!(e instanceof AuthError)) toast(e.message, 5000);
  }
}
$("inRecord").addEventListener("change", (e) => { handleVideoFile(e.target.files[0]); e.target.value = ""; });
$("inUpload").addEventListener("change", (e) => { handleVideoFile(e.target.files[0]); e.target.value = ""; });
$("btnNew").addEventListener("click", () => { if (confirm("Start a new video? (This one stays saved on the server for 14 days.)")) resetToEmpty(); });

// ---------- AI edit (analysis + guided steps) ----------
async function runAnalysis() {
  const p = state.project;
  preview.pause();
  closeSheet();
  await flush();
  busy("Starting AI Edit…", 0);
  const job = await api(`/api/projects/${p.id}/auto-edit`, { method: "POST" });
  await waitJob(job, (j) => busy(j.message, j.progress));
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
    const job = await api(`/api/projects/${p.id}/render`, { method: "POST" });
    const done = await waitJob(job, (j) => busy(j.status === "queued" ? "Waiting for the server…" : j.message, j.progress * 0.9));
    url = done.result.url;
  } catch (e) {
    busy(null);
    if (!(e instanceof AuthError)) showError("Saving didn't finish", e, saveVideo);
    return;
  }
  let blob = null;
  try {
    busy("Saving to your phone", 0.9);
    blob = await fetchWithProgress(url, (f, got, total) =>
      busy(`Saving to your phone (${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB)`, 0.9 + 0.1 * f));
  } catch (e) {
    console.warn("download failed", e); // still offer the direct link below
  }
  busy(null);
  showExport(blob, url);
}
$("btnSave").addEventListener("click", saveVideo);

function showExport(blob, url) {
  if (state.exportUrl) URL.revokeObjectURL(state.exportUrl);
  state.exportUrl = blob ? URL.createObjectURL(blob) : null;
  const file = blob ? new File([blob], "lollipop-video.mp4", { type: "video/mp4" }) : null;
  const canShare = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
  closeSheet();
  preview.pause();
  const v = $("resultVideo");
  v.src = state.exportUrl || url;
  const acts = $("resultActions");
  acts.innerHTML = "";
  if (canShare) {
    acts.append(el("button", {
      class: "btn btn-primary", onclick: async () => {
        v.pause();
        try { await navigator.share({ files: [file] }); }
        catch (e) { if (e.name !== "AbortError") toast("Sharing didn't open — use “Open video” instead.", 5000); }
      },
    }, "Save to iPhone / Share"));
  }
  acts.append(socialBubbles(file, url, v));
  acts.append(
    el("p", { class: "note center" }, canShare
      ? "Then choose “Save Video” for Photos — or send to Messages, Instagram, TikTok, Facebook, LinkedIn or YouTube."
      : "Tap “Open video”, then Share (square with arrow) → “Save Video”."),
    el("a", { class: "small-btn wide", href: url, target: "_blank", rel: "noopener" }, "Open video"));
  $("result").hidden = false;
  document.body.classList.add("result-open");
  v.play().catch(() => {}); // starts right away when allowed; otherwise tap ▶
}

// Instagram / TikTok / Facebook bubbles: save the video, then jump into the app.
const SOCIAL = [
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

$("resultBack").addEventListener("click", () => {
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
    const job = await api(`/api/projects/${p.id}/broll/${b.id}/swap`, { method: "POST" });
    await waitJob(job, (j) => busy(j.message, j.progress));
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
  if (state.size === "s") setSize("m");
  placeSizeHint();
  state.sheet = null;
  state.wizard = null;
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
  if (!document.body.classList.contains("sheet-open") || state.size === "full") setSize("s");
  document.body.classList.add("sheet-open");
  $("sheet").hidden = false; // no backdrop: the preview stays draggable while a panel is open
  [60, 300, 700].forEach((ms) => setTimeout(placeSizeHint, ms));
  preview.draw();
}

function openSheet(tool, title, content) {
  if (!state.project && tool !== "clips") return;
  state.wizard = null;
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
const PALETTE = ["#FFFFFF", "#E9E1D3", "#E3202A", "#F2C230", "#FF7A1A", "#FF3D8B", "#8B5CF6", "#2F80ED", "#14B8A6", "#22C55E"];
function swatches(label, _colors, current, onpick) {
  const wrap = el("div", { class: "swatches" });
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
  return [
    el("p", { class: "note" }, "Drag the yellow handles to cut the start and end. The preview shows the exact frame. Tap the strip to scrub."),
    labels,
    wrap,
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
    ...cutControls(paint),
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
    swatches("Text color", TEXT_COLORS, s.color, (v) => { s.color = v; changed(); }),
    chips("Spoken-word highlight", [["color", "Colored word"], ["box", "Box behind word"]], s.highlightStyle || "color", (v) => { s.highlightStyle = v; changed(); }),
    swatches("Highlight color", ACCENT_COLORS, s.highlight, (v) => { s.highlight = v; changed(); }),
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
    toggle("Place behind me (AI cut-out)", h.behind !== false, (v) => { h.behind = v; changed(); refreshSheet(); }),
    h.behind !== false ? toggle("Extra-sharp cut-out (slower save)", h.cutout === "best", (v) => { h.cutout = v ? "best" : "sharp"; changed(); }) : null,
    el("p", { class: "note" }, "Drag the headline on the preview to move it. Pinch to resize."),
    fontPicker("Font", FONTS_HEADLINE, h.font, (v) => { h.font = v; changed(); }),
    slider("Size", { min: 50, max: 320, value: h.size || 150, oninput: (v) => { h.size = v; changed(); } }),
    swatches("Main color", TEXT_COLORS, h.color, (v) => { h.color = v; changed(); }),
    swatches("*Starred* word color", ACCENT_COLORS, h.accent, (v) => { h.accent = v; changed(); }),
    toggle("ALL CAPS", h.uppercase !== false, (v) => { h.uppercase = v; changed(); }),
  ];
}

// ----- LOGO -----
function logoSheet() {
  const p = state.project, l = p.logo;
  const changed = () => save(["logo"]);
  const grid = el("div", { class: "logos" });
  for (const opt of state.settings.logos) {
    grid.append(el("div", { class: `logo-opt${opt.id === l.id ? " on" : ""}`, onclick: () => { l.id = opt.id; l.enabled = true; preview.setLogo(opt.url); changed(); refreshSheet(); } },
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
    toggle("Show logo", !!l.enabled, (v) => { l.enabled = v; changed(); }),
    el("div", { class: "field" }, el("label", { class: "label" }, "Choose logo"), grid,
      el("p", { class: "note" }, "PNG with a transparent background looks best.")),
    el("p", { class: "note" }, "Drag the logo on the preview to move it. Pinch to resize."),
    chips("Quick position", [["tl", "↖"], ["top", "Top"], ["tr", "↗"], ["bl", "↙"], ["bottom", "Bottom"], ["br", "↘"]], null, (v) => { [l.x, l.y] = pos[v]; changed(); }),
    slider("Size", { min: 0.06, max: 0.9, step: 0.01, value: l.w ?? 0.3, fmt: (v) => `${Math.round(v * 100)}%`, oninput: (v) => { l.w = v; changed(); } }),
    slider("Opacity", { min: 0.2, max: 1, step: 0.05, value: l.opacity ?? 1, fmt: (v) => `${Math.round(v * 100)}%`, oninput: (v) => { l.opacity = v; changed(); } }),
    el("button", { class: "small-btn wide", onclick: async () => {
      state.settings = await api("/api/settings", { method: "PUT", json: { defaultLogo: l.id, logoDefaults: { x: l.x, y: l.y, w: l.w, opacity: l.opacity ?? 1 } } });
      toast("Saved — new videos will use this logo and position.");
    } }, "★ Save as my default"),
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
    el("p", { class: "note" }, "Pick an MP3/M4A saved in your Files app. (Songs from Apple Music are copy-protected and can't be used.)"),
    m.file ? toggle("Use music", m.enabled !== false, (v) => { m.enabled = v; changed(); }) : null,
    m.file ? volumeRocker(m, changed) : null,
    m.file ? toggle("Auto-lower music while I talk", m.autoDuck === true, (v) => { m.autoDuck = v; changed(); }) : null,
    m.file ? el("p", { class: "note" }, "Off = the music stays at exactly the level you set. Press ▶ to hear it while you adjust.") : null,
    el("hr", { style: "border:0;border-top:1px solid rgba(255,255,255,.08);width:100%" }),
    toggle("Clean up my voice", p.audio?.clean !== false, (v) => { p.audio = { ...(p.audio || {}), clean: v }; save(["audio"]); }),
    el("p", { class: "note" }, "Removes background noise, makes speech clearer and evens out loudness. Applied when you save."),
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
const CAPTION_PRESETS = [
  { name: "Red Box", style: { font: "Montserrat", color: "#FFFFFF", highlight: "#E3202A", highlightStyle: "box", boxText: "#FFFFFF", stroke: 7, uppercase: true, animation: "pop", size: 64 } },
  { name: "Gold Box", style: { font: "Montserrat", color: "#FFFFFF", highlight: "#F2C230", highlightStyle: "box", boxText: "#111111", stroke: 7, uppercase: true, animation: "pop", size: 64 } },
  { name: "Bold Pop", style: { font: "Montserrat", color: "#FFFFFF", highlight: "#F2C230", highlightStyle: "color", stroke: 7, uppercase: true, animation: "pop", size: 66 } },
  { name: "LolliPOP Red", style: { font: "Anton", color: "#FFFFFF", highlight: "#E3202A", highlightStyle: "color", stroke: 7, uppercase: true, animation: "pop", size: 78 } },
  { name: "News", style: { font: "Oswald", color: "#FFFFFF", highlight: "#E3202A", highlightStyle: "color", stroke: 6, uppercase: true, animation: "pop", size: 72 } },
  { name: "Clean", style: { font: "Poppins", color: "#FFFFFF", highlight: "#FFFFFF", highlightStyle: "color", stroke: 5, uppercase: false, animation: "none", size: 58 } },
  { name: "Elegant", style: { font: "Playfair", color: "#F4EFE9", highlight: "#F2C230", highlightStyle: "color", stroke: 6, uppercase: false, animation: "pop", size: 70 } },
  { name: "Bebas Gold", style: { font: "Bebas Neue", color: "#FFFFFF", highlight: "#F2C230", highlightStyle: "color", stroke: 6, uppercase: true, animation: "pop", size: 84 } },
];
const HEADLINE_PRESETS = [
  { name: "Cinematic", font: "Anton", color: "#E9E1D3", accent: "#D7262E" },
  { name: "Bold Gold", font: "Bebas Neue", color: "#FFFFFF", accent: "#F2C230" },
  { name: "Classic", font: "Playfair", color: "#F4EFE9", accent: "#E3202A" },
  { name: "Modern", font: "Montserrat", color: "#FFFFFF", accent: "#E3202A" },
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
  const same = (st) => c.enabled !== false && st.font === s.font && st.highlight === s.highlight && st.color === s.color
    && (st.highlightStyle || "color") === (s.highlightStyle || "color");
  const grid = el("div", { class: "presets" },
    ...CAPTION_PRESETS.map((pr) => presetCard({
      label: pr.name, sample: "Your first home", font: pr.style.font, color: pr.style.color, accent: pr.style.highlight,
      upper: pr.style.uppercase, on: same(pr.style), box: pr.style.highlightStyle === "box", boxText: pr.style.boxText,
      onpick: () => { Object.assign(s, pr.style); c.enabled = true; changed(); refreshSheet(); },
    })),
    el("button", { class: `preset off${c.enabled === false ? " on" : ""}`, onclick: () => { c.enabled = false; changed(); refreshSheet(); } },
      el("div", { class: "preset-sample" }, "—"), el("div", { class: "preset-name" }, "No captions")));
  const out = [];
  if (!(c.lines || []).length) {
    out.push(el("p", { class: "note warn" }, "No speech was transcribed, so there are no captions to show. (Check the yellow note on the main screen.)"));
  }
  out.push(grid);
  if (c.enabled !== false) {
    out.push(
      chips("Position", [["top", "Top"], ["middle", "Middle"], ["bottom", "Bottom"]],
        s.y < 0.35 ? "top" : s.y < 0.6 ? "middle" : "bottom",
        (v) => { s.y = { top: 0.2, middle: 0.5, bottom: 0.72 }[v]; s.x = 0.5; changed(); }),
      slider("Size", { min: 32, max: 140, value: s.size || 66, oninput: (v) => { s.size = v; changed(); } }),
      fontPicker("Or choose a font", FONTS_CAPTION, s.font, (v) => { s.font = v; changed(); }));
    if ((c.lines || []).length) {
      const det = el("details", { class: "fix" }, el("summary", {}, "Fix a misspelled word"));
      det.append(captionLinesList());
      out.push(det);
    }
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
  const ta = el("textarea", { rows: 2, placeholder: "YOUR *FIRST HOME*\nSTARTS HERE" });
  ta.value = h.text || "";
  ta.addEventListener("input", () => { h.text = ta.value; h.enabled = !!h.text.trim(); changed(); });
  const sample = (h.text || "").replace(/\*/g, "").split(/\s+/).filter(Boolean).slice(0, 3).join(" ") || "Big news today";
  return [
    el("p", { class: "note" }, "Type a short headline that sits behind you (optional — leave it empty to skip). Put *stars* around words to color them."),
    ta,
    el("div", { class: "presets" }, ...HEADLINE_PRESETS.map((pr) => presetCard({
      label: pr.name, sample, font: pr.font, color: pr.color, accent: pr.accent, upper: true,
      on: h.font === pr.font && h.accent === pr.accent,
      onpick: () => { Object.assign(h, { font: pr.font, color: pr.color, accent: pr.accent }); changed(); refreshSheet(); },
    }))),
    slider("Size", { min: 50, max: 320, value: h.size || 130, oninput: (v) => { h.size = v; changed(); } }),
    swatches("Headline color", null, h.color, (v) => { h.color = v; changed(); }),
    swatches("*Starred* word color", null, h.accent, (v) => { h.accent = v; changed(); }),
    fontPicker("Or choose a font", FONTS_HEADLINE, h.font, (v) => { h.font = v; changed(); }),
    toggle("Place behind me (AI cut-out)", h.behind !== false, (v) => { h.behind = v; changed(); refreshSheet(); }),
    h.behind !== false ? toggle("Extra-sharp cut-out (slower save)", h.cutout === "best", (v) => { h.cutout = v ? "best" : "sharp"; changed(); }) : null,
    el("p", { class: "note" }, "Tip: drag the headline on the preview to move it, pinch to resize."),
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
    el("p", { class: "note" }, "AI picked these clips to show while you talk. Tap one to preview it. Remove any you don't like, or Swap for a different clip."),
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
    await Promise.all(["Anton", "Bebas Neue", "Oswald", "Montserrat", "Poppins", "Playfair"].map((f) => document.fonts.load(`40px "${f}"`)));
    // Always open on the start page; the last video is one tap away.
    const last = recall("lp_project");
    if (last) {
      $("btnContinue").hidden = false;
      $("btnContinue").onclick = async () => {
        try {
          const p = await api(`/api/projects/${last}`);
          if (p.status === "ready") await openProject(p);
          else { store("lp_project", null); $("btnContinue").hidden = true; toast("That video isn't available any more."); }
        } catch (e) {
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
