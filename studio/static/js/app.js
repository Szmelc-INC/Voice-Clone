// Entry point: routing, status polling, imports and drag-and-drop.

import { api, waitJob } from "./api.js";
import { S, on } from "./state.js";
import { Editor } from "./editor.js";
import { renderProjects, renderVoices, renderOutputs, bindVoiceForms, loadVoices, fillLanguageSelect } from "./library.js";
import { $, $$, h, esc, toast, fmtBytes } from "./util.js";

const editor = new Editor();

// ---------------------------------------------------------------- routing
async function route() {
  const [, view = "projects", id] = location.hash.split("/");
  $$(".view").forEach(v => v.classList.toggle("active", v.id === `view-${view}`));
  $$("#tabs a").forEach(a => a.classList.toggle("active", a.dataset.view === view));
  if (view === "editor") {
    if (id) {
      try { await editor.open(id); }
      catch { toast("Project not found", "err"); location.hash = "#/projects"; }
    } else if (S.project) {
      history.replaceState(null, "", `#/editor/${S.project.id}`);
    } else {
      renderProjects($("#recentProjects .cards") || makeRecent(), 6);
    }
    $("#tabs a[data-view=editor]").href = S.project ? `#/editor/${S.project.id}` : "#/editor";
  } else if (view === "projects") renderProjects();
  else if (view === "voices") renderVoices();
  else if (view === "outputs") renderOutputs();
}

function makeRecent() {
  const wrap = $("#recentProjects");
  wrap.innerHTML = "";
  const cards = h("div", { class: "cards" });
  wrap.append(h("h3", {}, "Recent projects"), cards);
  return cards;
}

window.addEventListener("hashchange", route);
on("projectDeleted", () => { editor.close(); });

// ---------------------------------------------------------------- status
let lastJobs = new Map();
async function pollStatus() {
  try {
    S.status = await api.status();
    renderEngine();
    renderJobs();
    // reload the open project when one of its untracked jobs finishes
    for (const j of S.status.jobs) {
      const prev = lastJobs.get(j.id);
      if (prev && prev !== j.status && ["done", "error"].includes(j.status)
          && j.project && j.project === S.project?.id && !editor.watching.has(j.id)) {
        if (j.kind === "import") editor.watchImport(); else editor.reload();
      }
    }
    lastJobs = new Map(S.status.jobs.map(j => [j.id, j.status]));
    const busy = new Set(S.status.jobs.filter(j => j.kind === "generate" && ["queued", "running"].includes(j.status) && j.project === S.project?.id).map(j => j.meta.edit));
    for (const id of editor.generating) busy.add(id);
    const changed = busy.size !== S.busyEdits.size || [...busy].some(x => !S.busyEdits.has(x));
    if (changed && S.project) {
      S.busyEdits = busy;
      editor.timeline.dirty = true;
    }
  } catch { /* server restarting */ }
  setTimeout(pollStatus, 1500);
}

function renderEngine() {
  const m = S.status.models, st = m.state;
  const dot = (label, s) => `<span class="dot ${s}" title="${label}: ${s}${m.errors?.[label === "OmniVoice" ? "tts" : "asr"] ? " - " + esc(m.errors[label === "OmniVoice" ? "tts" : "asr"]) : ""}"><i></i>${label}</span>`;
  const vram = m.vram ? `<span class="vram" title="${esc(m.device || "")}">${fmtBytes(m.vram.used)} / ${fmtBytes(m.vram.total)}</span>` : "";
  const loadBtn = st.tts === "unloaded" && st.asr === "unloaded" ? `<button class="btn ghost small" id="btnLoad">Load models</button>` : "";
  const html = dot("Whisper", st.asr) + dot("OmniVoice", st.tts) + vram + loadBtn;
  const el = $("#engine");
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
    $("#btnLoad")?.addEventListener("click", async () => { await api.post("/api/models/load"); toast("Loading models in the background…"); });
  }
}

function renderJobs() {
  const jobs = S.status.jobs;
  const active = jobs.filter(j => ["queued", "running"].includes(j.status));
  $("#jobsSpin").classList.toggle("hidden", !active.length);
  $("#jobsBtn").classList.toggle("busy", !!active.length);
  const running = active.find(j => j.status === "running");
  $("#jobsCount").textContent = active.length ? `${running ? running.progress || running.label : "Queued"}${active.length > 1 ? ` (+${active.length - 1})` : ""}` : "Jobs";
  const pop = $("#jobsPop");
  pop.innerHTML = jobs.length ? "" : '<div class="job"><span></span><span class="sub">No recent jobs</span></div>';
  for (const j of jobs.slice().reverse()) {
    const st = j.status === "running" ? '<span class="spinner small"></span>' : j.status === "done" ? '<span class="ok">✓</span>' : j.status === "error" ? "⚠" : "…";
    pop.append(h("div", { class: `job ${j.status}`, html: `<span class="st">${st}</span><span class="lbl">${esc(j.label)}</span><span class="sub">${esc(j.status === "error" ? j.error : j.progress || j.status)}</span>` }));
  }
}

$("#jobsBtn").addEventListener("click", e => { e.stopPropagation(); $("#jobsPop").classList.toggle("hidden"); });
document.addEventListener("click", e => { if (!$("#jobsPop").contains(e.target)) $("#jobsPop").classList.add("hidden"); });

// ---------------------------------------------------------------- import
async function importFile(file, path) {
  const form = new FormData();
  if (file) form.append("file", file);
  if (path) form.append("path", path);
  const label = file ? file.name : path;
  const t = h("div", { class: "toast" }, `Uploading ${label}… `, h("b", {}, "0%"));
  $("#toasts").append(t);
  try {
    const res = await api.upload("/api/projects", form, p => { t.querySelector("b").textContent = `${Math.round(p * 100)}%`; });
    t.remove();
    toast(`Importing ${label}…`);
    location.hash = `#/editor/${res.project.id}`;
  } catch (err) {
    t.remove();
    toast(err.message, "err");
  }
}

for (const id of ["#fileInput", "#fileInput2"]) {
  $(id).addEventListener("change", e => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ""; });
}
$("#pathForm").addEventListener("submit", e => {
  e.preventDefault();
  const p = $("#pathInput").value.trim();
  if (p) importFile(null, p);
});

let dragDepth = 0;
const isFileDrag = e => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", e => { if (!isFileDrag(e)) return; dragDepth++; $("#dropOverlay").classList.remove("hidden"); });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#dropOverlay").classList.add("hidden"); } });
window.addEventListener("dragover", e => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener("drop", e => {
  dragDepth = 0;
  $("#dropOverlay").classList.add("hidden");
  if (!isFileDrag(e)) return;
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (!/^(video|audio)\//.test(f.type) && !/\.(mkv|flac|opus|m4a|wav|mp3|ogg|webm|mp4|mov|avi)$/i.test(f.name)) { toast("Drop a video or audio file", "err"); return; }
  importFile(f);
});

// ---------------------------------------------------------------- boot
(async function boot() {
  try { S.status = await api.status(); } catch { toast("Cannot reach the studio server", "err"); }
  fillLanguageSelect($("#ttsLang"));
  bindVoiceForms();
  await loadVoices();
  on("voicesChanged", loadVoices);
  if (!location.hash) location.hash = "#/projects";
  route();
  pollStatus();
})();

export { editor, waitJob };
