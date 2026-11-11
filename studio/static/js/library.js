// Library views: projects, voices (+ clone and quick TTS) and outputs.

import { api, waitJob } from "./api.js";
import { S, emit } from "./state.js";
import { $, h, esc, fmtTime, fmtBytes, fmtAgo, avatarStyle, toast, icons } from "./util.js";
import { confirmModal } from "./editor.js";

// ---------------------------------------------------------------- projects
export async function renderProjects(target = $("#projectCards"), limit = 0) {
  let list = [];
  try { list = await api.projects(); } catch (err) { toast(err.message, "err"); }
  if (limit) list = list.slice(0, limit);
  target.innerHTML = "";
  if (!list.length) {
    target.append(h("div", { class: "empty-state" }, "No projects yet. Drop a video or audio file anywhere to start."));
    return list;
  }
  for (const p of list) {
    const src = p.source;
    const card = h("div", { class: "card clickable", onclick: () => { location.hash = `#/editor/${p.id}`; } },
      h("div", { class: "card-top" },
        h("div", { class: "avatar", style: avatarStyle(p.name), html: src?.has_video ? icons.film : icons.wave }),
        h("div", { style: { minWidth: 0 } }, h("h4", {}, p.name),
          h("div", { class: "meta" }, src ? `${fmtTime(src.duration, false)} · ${src.has_video ? "video" : "audio"} · ${fmtAgo(p.updated)}` : p.status))),
      h("div", { class: "badges" },
        h("span", {}, `${p.words} words`), h("span", {}, `${p.edits} edits`), p.locked ? h("span", {}, `🔒 ${p.locked}`) : null,
        p.status !== "ready" ? h("span", {}, p.status) : null),
      h("div", { class: "acts" },
        h("button", { class: "btn small", onclick: ev => { ev.stopPropagation(); location.hash = `#/editor/${p.id}`; } }, "Open"),
        h("button", { class: "btn ghost small danger", onclick: async ev => {
          ev.stopPropagation();
          if (!(await confirmModal("Delete project?", `“${p.name}”, its media copy, transcript and all takes will be deleted. Rendered outputs stay.`, "Delete", true))) return;
          await api.del(`/api/projects/${p.id}`);
          if (S.project?.id === p.id) emit("projectDeleted");
          renderProjects(target, limit);
        } }, "Delete")));
    card.querySelector(".avatar svg").style.cssText = "width:20px;height:20px;stroke:#fff";
    target.append(card);
  }
  return list;
}

// ---------------------------------------------------------------- voices
export async function loadVoices() {
  try { S.voices = await api.voices(); } catch { S.voices = []; }
  const sel = $("#ttsVoice"), cur = sel.value;
  sel.innerHTML = "";
  sel.append(h("option", { value: "" }, "🎲 Auto voice"), h("option", { value: "__design" }, "🎨 Voice design (describe it)"));
  for (const v of S.voices) sel.append(h("option", { value: v.name }, v.name));
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  return S.voices;
}

export async function renderVoices() {
  await loadVoices();
  const root = $("#voiceCards");
  root.innerHTML = "";
  if (!S.voices.length) root.append(h("div", { class: "empty-state" }, "No voices yet. Clone one from a file on the right, or select speech in the editor → right-click → Save voice to library."));
  for (const v of S.voices) {
    let audio = null;
    const play = h("button", { class: "btn small", disabled: !v.has_audio, title: v.has_audio ? "Play reference" : "No reference audio stored (cloned outside the studio)" },
      h("span", { html: icons.play, style: { width: "14px", height: "14px", display: "inline-flex" } }), "Reference");
    play.addEventListener("click", () => {
      if (audio && !audio.paused) { audio.pause(); return; }
      audio = new Audio(`/api/voices/${encodeURIComponent(v.name)}/audio`);
      audio.play();
    });
    root.append(h("div", { class: "card" },
      h("div", { class: "card-top" },
        h("div", { class: "avatar", style: avatarStyle(v.name) }, v.name.slice(0, 2).toUpperCase()),
        h("div", { style: { minWidth: 0 } }, h("h4", {}, v.name),
          h("div", { class: "meta" }, `${v.seconds ? `${v.seconds} s prompt · ` : ""}${fmtBytes(v.size)} · ${fmtAgo(v.modified)}`))),
      h("div", { class: "quote" }, v.ref_text ? `“${v.ref_text}”` : v.error ? `⚠ ${v.error}` : "(no transcript)"),
      h("div", { class: "acts" }, play,
        h("button", { class: "btn small", onclick: () => { $("#ttsVoice").value = v.name; $("#ttsVoice").dispatchEvent(new Event("change")); $("#ttsForm textarea").focus(); } }, "Use in TTS"),
        h("button", { class: "btn ghost small", onclick: () => renameVoice(v.name) }, "Rename"),
        h("a", { class: "btn ghost small", href: `/api/voices/${encodeURIComponent(v.name)}/download` }, ".pt"),
        h("button", { class: "btn ghost small danger", onclick: async () => {
          if (!(await confirmModal("Delete voice?", `“${v.name}.pt” will be removed from ${S.status?.paths?.voices || "the voices folder"}.`, "Delete", true))) return;
          await api.del(`/api/voices/${encodeURIComponent(v.name)}`);
          renderVoices();
        } }, "Delete"))));
  }
}

async function renameVoice(name) {
  const input = h("input", { value: name, autofocus: true, spellcheck: "false" });
  const { openModal, closeModal } = await import("./util.js");
  const form = h("form", {},
    h("div", { class: "modal-head" }, h("h2", {}, "Rename voice")),
    h("div", { class: "modal-body" }, input),
    h("div", { class: "modal-foot" }, h("button", { type: "button", class: "btn", onclick: () => closeModal() }, "Cancel"), h("button", { class: "btn primary" }, "Rename")));
  form.addEventListener("submit", async e => {
    e.preventDefault();
    try {
      await api.patch(`/api/voices/${encodeURIComponent(name)}`, { name: input.value.trim() });
      closeModal();
      renderVoices();
    } catch (err) { toast(err.message, "err"); }
  });
  openModal(form);
}

export function bindVoiceForms() {
  const form = $("#newVoiceForm"), drop = $("#voiceDrop"), file = form.file;
  const setFile = f => {
    const dt = new DataTransfer(); dt.items.add(f); file.files = dt.files;
    $("#voiceDropText").textContent = f.name;
    if (!form.name.value) form.name.value = f.name.replace(/\.[^.]+$/, "").replace(/[^\w.\- ]+/g, "_");
  };
  file.addEventListener("change", () => file.files[0] && setFile(file.files[0]));
  drop.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", e => { e.preventDefault(); e.stopPropagation(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const name = form.name.value;
    const data = new FormData(form);
    // Clear right away so the next voice can be queued while this one clones.
    form.reset();
    $("#voiceDropText").textContent = "Drop 3–10 s of clean speech";
    try {
      const job = await api.upload("/api/voices", data);
      toast(`Cloning “${name}”…`);
      await waitJob(job);
      toast(`Voice “${name}” saved`, "ok");
      renderVoices();
    } catch (err) { toast(err.message, "err"); }
  });

  const tts = $("#ttsForm");
  const speed = tts.speed, out = speed.nextElementSibling;
  speed.addEventListener("input", () => { out.textContent = `${(+speed.value).toFixed(2)}×`; });
  $("#ttsVoice").addEventListener("change", e => $("#ttsInstruct").classList.toggle("hidden", e.target.value !== "__design"));
  tts.addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(tts);
    const voice = fd.get("voice");
    const body = {
      text: fd.get("text"), language: fd.get("language"), num_step: +fd.get("num_step"),
      speed: +fd.get("speed") === 1 ? null : +fd.get("speed"), name: fd.get("name") || "tts",
      voice: voice && voice !== "__design" ? voice : null,
      instruct: voice === "__design" ? fd.get("instruct") || null : null,
    };
    // Each submit queues its own job (the server takes up to 10); results stack up, newest on top.
    const row = h("div", { class: "tts-row" }, h("span", { class: "spinner small" }), " ",
      h("span", { class: "dim" }, `“${body.text.slice(0, 40)}${body.text.length > 40 ? "…" : ""}” · queued`));
    $("#ttsResult").prepend(row);
    try {
      const job = await api.post("/api/tts", body);
      const done = await waitJob(job, j => {
        row.querySelector(".dim").textContent = j.status === "queued" && j.position
          ? `#${j.position} in queue` : `${j.progress || "Generating"}…`;
      });
      const url = `/api/outputs/${encodeURIComponent(done.result.file)}`;
      const audio = h("audio", { controls: true, src: url, style: { width: "100%" } });
      row.replaceChildren(audio, h("div", { class: "dim", style: { fontSize: "12px" } }, `${done.result.file} · ${done.result.seconds} s · seed ${done.result.seed}`));
      if (![...document.querySelectorAll("#ttsResult audio")].some(a => !a.paused)) audio.play().catch(() => {});
    } catch (err) { row.remove(); toast(err.message, "err"); }
  });
}

// ---------------------------------------------------------------- outputs
export async function renderOutputs() {
  const root = $("#outputList");
  $("#outputsPath").textContent = S.status?.paths?.outputs || "outputs/";
  let list = [];
  try { list = await api.outputs(); } catch (err) { toast(err.message, "err"); }
  root.innerHTML = "";
  if (!list.length) root.append(h("div", { class: "empty-state" }, "Nothing here yet. Renders and quick-TTS samples show up here."));
  for (const o of list) {
    const url = `/api/outputs/${encodeURIComponent(o.name)}`;
    const media = o.kind === "video"
      ? h("video", { controls: true, preload: "metadata", src: url })
      : h("audio", { controls: true, preload: "none", src: url });
    root.append(h("div", { class: "out-row" },
      h("div", { class: "ic", html: o.kind === "video" ? icons.film : icons.wave }),
      h("div", { style: { minWidth: 0 } }, h("div", { class: "nm", title: o.name }, o.name),
        h("div", { class: "dim", style: { fontSize: "12px" } }, `${fmtBytes(o.size)} · ${fmtAgo(o.modified)}`)),
      media,
      h("div", { class: "row tight" },
        h("a", { class: "btn small", href: `${url}?download=1`, html: `${icons.download}<span>Save</span>` }),
        h("button", { class: "btn ghost small danger", onclick: async () => {
          if (!(await confirmModal("Delete file?", `${o.name} will be deleted from disk.`, "Delete", true))) return;
          await api.del(url);
          renderOutputs();
        } }, "Delete"))));
  }
  root.querySelectorAll(".btn svg").forEach(s => { s.style.width = "14px"; s.style.height = "14px"; });
}

export function fillLanguageSelect(sel) {
  sel.innerHTML = "";
  for (const l of S.status?.languages || ["auto"]) sel.append(h("option", { value: l }, l === "auto" ? "Auto language" : l[0].toUpperCase() + l.slice(1)));
}

export { esc };
