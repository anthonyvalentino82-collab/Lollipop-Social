import { Preview } from "./preview.js";
import { buildCaptionLines, retimeLine } from "./timeline.js";

const $ = (id) => document.getElementById(id);
const video = document.createElement("video");
video.playsInline = true;
video.setAttribute("playsinline", "");
video.preload = "auto";

const state = { project: null, settings: null, status: null, sheet: null, exportUrl: null };
const FONTS_CAPTION = ["Montserrat", "Anton", "Bebas Neue", "Poppins", "Oswald", "Playfair"];
const FONTS_HEADLINE = ["Anton", "Bebas Neue", "Oswald", "Montserrat", "Playfair"];
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
  while (true) {
    const j = await api(`/api/jobs/${job.id}`);
    onProgress && onProgress(j);
    if (j.status === "done") return j;
    if (j.status === "error") throw new Error(j.error || "Something went wrong.");
    await new Promise((r) => setTimeout(r, 900));
  }
}

function busy(msg, p) {
  $("busy").hidden = msg == null;
  if (msg != null) { $("busyMsg").textContent = msg; $("busyBar").style.width = `${Math.round((p || 0) * 100)}%`; }
}

// ---------- preview ----------
const preview = new Preview($("canvas"), video, {
  onChange: (key) => save(key === "logo" ? ["logo"] : key === "headline" ? ["headline"] : ["captions"]),
  onTap: (key) => {
    if (key) openSheet(key);
    else if (video.paused) preview.play(); else preview.pause();
  },
  onTime: (t) => updateScrub(t),
});
video.addEventListener("play", () => ($("playBtn").hidden = true));
video.addEventListener("pause", () => ($("playBtn").hidden = !state.project));

function updateScrub(t) {
  const p = state.project;
  if (!p) return;
  const d = p.trim.end - p.trim.start;
  $("tCur").textContent = fmt(t - p.trim.start);
  $("tDur").textContent = fmt(d);
  const v = Math.round(((t - p.trim.start) / Math.max(0.01, d)) * 1000);
  if (!seekDragging) { $("seek").value = v; }
  $("seek").style.setProperty("--p", `${v / 10}%`);
  highlightCaptionRow(t);
}
let seekDragging = false;
$("seek").addEventListener("input", () => {
  seekDragging = true;
  const p = state.project;
  video.currentTime = p.trim.start + ($("seek").value / 1000) * (p.trim.end - p.trim.start);
});
$("seek").addEventListener("change", () => (seekDragging = false));

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

// ---------- project lifecycle ----------
function logoUrl(id) {
  const l = (state.settings?.logos || []).find((x) => x.id === id);
  return l ? l.url : "/static/brand/lollipop-logo.png";
}

async function openProject(p) {
  state.project = p;
  store("lp_project", p.id);
  const base = `/files/projects/${p.id}`;
  $("empty").hidden = true;
  $("scrub").hidden = false;
  $("hint").hidden = false;
  $("btnNew").hidden = false;
  if (!video.src.endsWith(`${base}/source.mp4`)) {
    video.src = `${base}/source.mp4`;
    video.load();
  }
  preview.setProject(p);
  preview.setLogo(logoUrl(p.logo.id));
  preview.setBroll(p.broll || [], base);
  preview.setMusic(p.music?.file ? `${base}/${p.music.file}?v=${encodeURIComponent(p.music.name || "")}` : null);
  if (preview.needsMask()) preview.ensureMasker();
  $("playBtn").hidden = false;
  document.querySelectorAll(".tools button").forEach((b) => (b.disabled = false));
  $("btnAuto").disabled = false;
  $("btnSave").disabled = false;
  $("btnAuto").classList.toggle("done", !!p.autoEdited);
  $("btnAutoLabel").textContent = p.autoEdited ? "Auto Edited ✓  Tap to redo" : "Auto Edit";
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
  $("empty").hidden = false;
  ["scrub", "hint", "brollStrip", "warnings", "playBtn", "btnNew"].forEach((id) => ($(id).hidden = true));
  document.querySelectorAll(".tools button").forEach((b) => (b.disabled = true));
  $("btnAuto").disabled = $("btnSave").disabled = true;
  $("btnAuto").classList.remove("done");
  $("btnAutoLabel").textContent = "Auto Edit";
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
    toast("Video ready! Tap Auto Edit ✨");
  } catch (e) {
    busy(null);
    if (!(e instanceof AuthError)) toast(e.message, 5000);
  }
}
$("inRecord").addEventListener("change", (e) => { handleVideoFile(e.target.files[0]); e.target.value = ""; });
$("inUpload").addEventListener("change", (e) => { handleVideoFile(e.target.files[0]); e.target.value = ""; });
$("btnNew").addEventListener("click", () => { if (confirm("Start a new video? (This one stays saved on the server for 14 days.)")) resetToEmpty(); });

// ---------- auto edit ----------
$("btnAuto").addEventListener("click", async () => {
  const p = state.project;
  if (!p) return;
  if (p.autoEdited && !confirm("Run Auto Edit again? This replaces your captions, zooms and B-roll (your headline, logo and music stay).")) return;
  preview.pause();
  await flush();
  try {
    busy("Starting Auto Edit…", 0);
    const job = await api(`/api/projects/${p.id}/auto-edit`, { method: "POST" });
    await waitJob(job, (j) => busy(j.message, j.progress));
    const fresh = await api(`/api/projects/${p.id}`);
    busy(null);
    await openProject(fresh);
    toast(fresh.warnings?.length ? "Auto edit done (see notes below)" : "Auto edit complete ✨");
  } catch (e) {
    busy(null);
    if (!(e instanceof AuthError)) toast(e.message, 5000);
  }
});

// ---------- save / export ----------
$("btnSave").addEventListener("click", async () => {
  const p = state.project;
  if (!p) return;
  preview.pause();
  closeSheet();
  await flush();
  try {
    busy("Rendering your video…", 0);
    const job = await api(`/api/projects/${p.id}/render`, { method: "POST" });
    const done = await waitJob(job, (j) => busy(j.message, j.progress));
    busy("Getting your video…", 1);
    const blob = await (await fetch(done.result.url)).blob();
    busy(null);
    showExport(blob, done.result.url);
  } catch (e) {
    busy(null);
    if (!(e instanceof AuthError)) toast(e.message, 6000);
  }
});

function showExport(blob, url) {
  if (state.exportUrl) URL.revokeObjectURL(state.exportUrl);
  state.exportUrl = URL.createObjectURL(blob);
  const file = new File([blob], "lollipop-video.mp4", { type: "video/mp4" });
  const canShare = navigator.canShare && navigator.canShare({ files: [file] });
  openSheet("export", "Your video is ready", [
    el("video", { class: "export-video", src: state.exportUrl, controls: true, playsinline: true }),
    canShare
      ? el("button", {
          class: "btn btn-primary", onclick: async () => {
            try { await navigator.share({ files: [file] }); }
            catch (e) { if (e.name !== "AbortError") toast("Sharing failed — use Download instead."); }
          },
        }, "Save to iPhone / Share")
      : null,
    el("p", { class: "note" }, canShare
      ? "Tap “Save to iPhone / Share”, then choose “Save Video” to put it in Photos — or send it straight to Messages, Instagram, TikTok, Facebook, LinkedIn or YouTube."
      : "Download the MP4, then share it to Photos or any app."),
    el("a", { class: "small-btn wide", href: url, download: "lollipop-video.mp4" }, "Download MP4"),
  ]);
}

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
  } catch (e) { busy(null); if (!(e instanceof AuthError)) toast(e.message, 4000); }
}

$("btnClips").addEventListener("click", () => openSheet("clips"));

// ---------- bottom sheets ----------
function closeSheet() {
  $("sheet").hidden = true;
  document.body.classList.remove("sheet-open");
  state.sheet = null;
  preview.ghostCaptions = false;
  preview.draw();
  markTools();
}
$("sheetDone").addEventListener("click", closeSheet);

const TITLES = { trim: "Trim", captions: "Captions", headline: "Cinematic Headline", logo: "Logo", music: "Music & Voice", zoom: "Auto Zoom", clips: "My B-roll clips" };

function openSheet(tool, title, content) {
  if (!state.project && tool !== "clips") return;
  state.sheet = tool;
  $("sheetTitle").textContent = title || TITLES[tool] || "";
  const body = $("sheetBody");
  body.innerHTML = "";
  preview.ghostCaptions = tool === "captions";
  const builders = { trim: trimSheet, captions: captionsSheet, headline: headlineSheet, logo: logoSheet, music: musicSheet, zoom: zoomSheet, clips: clipsSheet };
  body.append(...(content || builders[tool]()).filter(Boolean));
  window.scrollTo({ top: 0, behavior: "smooth" });
  document.body.classList.add("sheet-open");
  $("sheet").hidden = false; // no backdrop: the preview stays draggable while a panel is open
  preview.draw();
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
function swatches(label, colors, current, onpick) {
  const wrap = el("div", { class: "swatches" });
  const draw = (cur) => {
    wrap.innerHTML = "";
    for (const c of colors) wrap.append(el("button", { class: `swatch${c.toLowerCase() === (cur || "").toLowerCase() ? " on" : ""}`, style: `background:${c}`, onclick: () => { onpick(c); draw(c); } }));
  };
  draw(current);
  return el("div", { class: "field" }, el("label", { class: "label" }, label), wrap);
}

// ----- TRIM -----
function trimSheet() {
  const p = state.project, dur = p.source.duration;
  const info = el("p", { class: "note" });
  const setInfo = () => (info.textContent = `Your video will be ${fmt1(p.trim.end - p.trim.start)} long.`);
  setInfo();
  let startS, endS;
  const startField = slider("Start", { min: 0, max: dur, step: 0.05, value: p.trim.start, fmt: fmt1, oninput: (v) => {
    p.trim.start = Math.min(v, p.trim.end - 1); video.currentTime = p.trim.start; setInfo(); save(["trim"]);
  } });
  const endField = slider("End", { min: 0, max: dur, step: 0.05, value: p.trim.end, fmt: fmt1, oninput: (v) => {
    p.trim.end = Math.max(v, p.trim.start + 1); video.currentTime = Math.max(p.trim.start, p.trim.end - 0.05); setInfo(); save(["trim"]);
  } });
  startS = startField.querySelector("input"); endS = endField.querySelector("input");
  return [
    el("p", { class: "note" }, "Cut off the beginning and end. Scrub the preview, then tap a button — or drag the sliders."),
    startField, endField,
    el("div", { class: "grid2" },
      el("button", { class: "small-btn", onclick: () => { p.trim.start = Math.min(video.currentTime, p.trim.end - 1); startS.value = p.trim.start; startS.dispatchEvent(new Event("input")); } }, "Start here"),
      el("button", { class: "small-btn", onclick: () => { p.trim.end = Math.max(video.currentTime, p.trim.start + 1); endS.value = p.trim.end; endS.dispatchEvent(new Event("input")); } }, "End here")),
    info,
    el("button", { class: "small-btn wide", onclick: () => { p.trim = { start: 0, end: dur }; save(["trim"]); openSheet("trim"); } }, "Reset trim"),
  ];
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
    chips("Font", FONTS_CAPTION.map((f) => [f, f, `font-family:"${f}"`]), s.font, (v) => { s.font = v; changed(); }),
    slider("Size", { min: 32, max: 140, value: s.size || 66, oninput: (v) => { s.size = v; changed(); } }),
    swatches("Text color", TEXT_COLORS, s.color, (v) => { s.color = v; changed(); }),
    swatches("Spoken-word highlight", ACCENT_COLORS, s.highlight, (v) => { s.highlight = v; changed(); }),
    chips("Words at a time", [1, 2, 3, 4].map((n) => [n, String(n)]), s.maxWords || 3, (n) => {
      s.maxWords = n;
      const words = (c.lines || []).flatMap((l) => l.words);
      c.lines = buildCaptionLines(words, n);
      changed(); openSheet("captions");
    }),
    chips("Animation", [["pop", "Pop"], ["none", "None"]], s.animation || "pop", (v) => { s.animation = v; changed(); }),
    toggle("ALL CAPS", s.uppercase !== false, (v) => { s.uppercase = v; changed(); }),
  );
  if ((c.lines || []).length) {
    const list = el("div", { class: "cap-lines" });
    captionRows = [];
    c.lines.forEach((line, i) => {
      const input = el("input", { type: "text", value: line.words.map((w) => w.w).join(" "), enterkeyhint: "done" });
      input.addEventListener("focus", () => { preview.pause(); video.currentTime = line.start + 0.01; });
      input.addEventListener("change", () => {
        const updated = retimeLine(line, input.value);
        if (updated) c.lines[i] = updated; else c.lines.splice(i, 1);
        changed();
        if (!updated) openSheet("captions");
      });
      const row = el("div", { class: "cap-line" }, el("span", { class: "t" }, fmt(line.start - p.trim.start)), input);
      captionRows.push({ row, line });
      list.append(row);
    });
    out.push(el("div", { class: "field" }, el("label", { class: "label" }, "Fix words (tap a line to jump there; clear it to delete)"), list));
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
    toggle("Place behind me (AI cut-out)", h.behind !== false, (v) => { h.behind = v; changed(); }),
    el("p", { class: "note" }, "Drag the headline on the preview to move it. Pinch to resize."),
    chips("Font", FONTS_HEADLINE.map((f) => [f, f, `font-family:"${f}"`]), h.font, (v) => { h.font = v; changed(); }),
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
    grid.append(el("div", { class: `logo-opt${opt.id === l.id ? " on" : ""}`, onclick: () => { l.id = opt.id; l.enabled = true; preview.setLogo(opt.url); changed(); openSheet("logo"); } },
      el("img", { src: opt.url, alt: opt.name }),
      opt.builtin ? null : el("button", { class: "x", onclick: async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete “${opt.name}”?`)) return;
        state.settings = await api(`/api/logos/${opt.id}`, { method: "DELETE" });
        if (l.id === opt.id) { l.id = "lollipop"; preview.setLogo(logoUrl("lollipop")); changed(); }
        openSheet("logo");
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
      preview.setLogo(added.url); changed(); openSheet("logo");
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
      openSheet("music");
      toast("Music added — press play to hear it.");
    } catch (e) { busy(null); toast(e.message); }
  });
  return [
    el("div", { class: "row" },
      el("div", { class: "music-name" }, m.file ? `♪ ${m.name || "Music"}` : "No music yet"),
      el("label", { class: "small-btn" }, inp, m.file ? "Change" : "Choose music")),
    el("p", { class: "note" }, "Pick an MP3/M4A saved in your Files app. (Songs from Apple Music are copy-protected and can't be used.)"),
    m.file ? toggle("Use music", m.enabled !== false, (v) => { m.enabled = v; changed(); }) : null,
    m.file ? slider("Music volume", { min: 0, max: 1, step: 0.01, value: m.volume ?? 0.25, fmt: (v) => `${Math.round(v * 100)}%`, oninput: (v) => { m.volume = v; changed(); } }) : null,
    m.file ? toggle("Lower music while I talk", m.duck !== false, (v) => { m.duck = v; changed(); }) : null,
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
      openSheet("clips");
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
        openSheet("clips");
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
    await Promise.all(["Anton", "Bebas Neue", "Oswald", "Montserrat", "Poppins", "Playfair"].map((f) => document.fonts.load(`40px "${f}"`)));
    const last = recall("lp_project");
    if (last) {
      try {
        const p = await api(`/api/projects/${last}`);
        if (p.status === "ready") await openProject(p); else store("lp_project", null);
      }
      catch (e) { if (e instanceof AuthError) return; store("lp_project", null); }
    }
  } catch (e) {
    if (!(e instanceof AuthError)) toast(e.message, 5000);
  }
}
document.querySelectorAll(".tools button").forEach((b) => (b.disabled = true));
document.fonts.ready.then(() => preview.draw());
boot();
