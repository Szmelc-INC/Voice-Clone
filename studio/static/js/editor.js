// Editor controller: wires player, timeline, transcript and the inspector, and
// owns every edit action (Edit & Generate, takes, lock, preview, render).

import { api, waitJob } from "./api.js";
import { S, emit, on, words, edits, currentEdit, activeTake, selection, editEnd } from "./state.js";
import { Player } from "./player.js";
import { Timeline } from "./timeline.js";
import { Transcript } from "./transcript.js";
import { $, h, esc, fmtTime, fmtAgo, toast, openMenu, closeMenu, openModal, closeModal, modalOpen, icons } from "./util.js";

export class Editor {
  constructor() {
    this.player = new Player($("#media"));
    this.timeline = new Timeline($("#timeline"), this.player);
    this.transcript = new Transcript($("#transcript"), this.player);
    this.wordsVersion = 0;
    this.saveTimer = null;
    this.watching = new Set();
    this.generating = new Map();  // edit id -> generations this tab is waiting for
    this.bindUi();
    this.bindBus();
  }

  // ------------------------------------------------------------- loading
  async open(pid) {
    if (S.project?.id === pid) return;
    S.project = await api.project(pid);
    S.sel = S.range = S.editId = null;
    S.peaks = null;
    $("#editorEmpty").classList.add("hidden");
    $("#editor").classList.remove("hidden");
    this.renderHead();
    if (S.project.status === "ready") await this.loadMedia();
    else this.watchImport();
    this.refreshAll();
  }

  close() {
    S.project = null;
    this.player.media.removeAttribute("src");
    this.player.media.load();
    $("#editor").classList.add("hidden");
    $("#editorEmpty").classList.remove("hidden");
  }

  async loadMedia() {
    const p = S.project;
    this.player.load(p);
    $("#audioArt").classList.toggle("hidden", !!p.source.has_video);
    $("#tcDur").textContent = fmtTime(p.source.duration);
    try { S.peaks = await api.peaks(p.id); } catch { S.peaks = null; }
    this.timeline.setProject();
    this.player.preloadTakes();
    if (!p.source.has_video) this.drawAudioArt();
  }

  async watchImport() {
    const job = (S.status?.jobs || []).find(j => j.project === S.project.id && j.kind === "import" && j.status !== "done");
    if (job) await this.track(job, "Importing").catch(() => {});
    await this.reload();
    if (S.project.status === "ready") await this.loadMedia();
    this.refreshAll();
  }

  async reload() {
    if (!S.project) return;
    const fresh = await api.project(S.project.id);
    // keep local words if the user has unsaved changes
    if (this.saveTimer) fresh.words = S.project.words;
    S.project = fresh;
    if (S.editId && !edits().some(e => e.id === S.editId)) S.editId = null;
    this.player.preloadTakes();
    this.refreshAll();
  }

  refreshAll() {
    this.renderHead();
    this.transcript.render();
    this.renderInspector();
    this.updateSelUi();
    this.timeline.dirty = true;
  }

  // Track a job: toast-free progress in the jobs menu, reload project when done.
  async track(job, what) {
    this.watching.add(job.id);
    try {
      const done = await waitJob(job);
      return done;
    } catch (err) {
      toast(`${what} failed: ${err.message}`, "err");
      throw err;
    } finally {
      this.watching.delete(job.id);
    }
  }

  // ------------------------------------------------------------- header
  renderHead() {
    const p = S.project;
    if (!p) return;
    const name = $("#projectName");
    if (document.activeElement !== name) name.value = p.name;
    const src = p.source;
    $("#projectMeta").textContent = src
      ? `${fmtTime(src.duration)} · ${src.has_video ? `${src.width}×${src.height} ${src.video_codec}` : src.audio_codec} · ${Math.round(src.master_sr / 1000)} kHz`
      : p.status === "error" ? "import failed" : "importing…";
    const lang = $("#langSelect");
    if (!lang.options.length) {
      for (const l of S.status?.languages || ["auto"]) lang.append(h("option", { value: l }, l === "auto" ? "Language: auto" : l[0].toUpperCase() + l.slice(1)));
    }
    lang.value = p.language || "auto";
    $("#srtLink").href = `/api/projects/${p.id}/transcript.srt`;
    $("#srtLink").download = `${p.name}.srt`;
    const ready = p.status === "ready";
    $("#btnTranscribeAll").disabled = !ready;
    $("#btnRender").disabled = !ready;
  }

  updateSelUi() {
    const sel = selection();
    $("#btnTranscribeRange").disabled = !sel || S.project?.status !== "ready";
    $("#tlSel").textContent = sel ? `Selection ${fmtTime(sel.start)} → ${fmtTime(sel.end)} · ${(sel.end - sel.start).toFixed(2)} s` : "";
  }

  // ------------------------------------------------------------- inspector
  renderInspector() {
    const root = $("#inspector");
    root.innerHTML = "";
    if (!S.project) return;
    const e = currentEdit();
    if (e) root.append(...this.editInspector(e));
    else root.append(...this.projectInspector());
  }

  projectInspector() {
    const p = S.project, ed = edits();
    const locked = ed.filter(e => e.locked).length;
    const out = [
      h("div", { class: "insp-title" }, h("h2", {}, "Project"), h("span", { class: "chip idle" }, p.status)),
      h("div", { class: "stat-grid" },
        h("div", { class: "stat" }, h("b", {}, words().length), h("span", {}, "words")),
        h("div", { class: "stat" }, h("b", {}, ed.length), h("span", {}, "edits")),
        h("div", { class: "stat" }, h("b", {}, locked), h("span", {}, "locked"))),
    ];
    if (!words().length && p.status === "ready") {
      out.push(h("div", { class: "insp-sec" }, h("label", {}, "Start here"),
        h("div", { class: "dim" }, "1. Auto-transcribe (or drag on the waveform → right-click → Transcribe range)."),
        h("div", { class: "dim" }, "2. Select words → right-click → ✨ Edit & Generate."),
        h("div", { class: "dim" }, "3. Preview, regenerate, lock 🔒, then Render.")));
    }
    if (ed.length) {
      const list = h("div", { class: "edit-list" });
      for (const e of ed) {
        list.append(h("div", { class: "edit-item", onclick: () => this.selectEdit(e.id, true) },
          h("span", { class: `chip ${e.locked ? "locked" : "draft"}` }, e.locked ? "lock" : S.busyEdits.has(e.id) ? "…" : "draft"),
          h("span", { class: "ei-text" }, e.text),
          h("span", { class: "ei-time" }, fmtTime(e.cut_start))));
      }
      out.push(h("div", { class: "insp-sec" }, h("label", {}, "Edits"), list));
    }
    const renders = (p.renders || []).slice().reverse();
    const rsec = h("div", { class: "insp-sec" }, h("label", {}, "Render"),
      h("div", { class: "row" },
        h("button", { class: "btn primary", onclick: () => this.renderDialog(), disabled: p.status !== "ready" }, "Render final…")));
    for (const r of renders.slice(0, 6)) {
      const f = r.video || r.audio;
      rsec.append(h("div", { class: "render-item" },
        h("span", { html: r.video ? icons.film : icons.wave, style: { width: "16px", height: "16px", display: "inline-flex" } }),
        h("a", { href: `/api/outputs/${encodeURIComponent(f)}`, target: "_blank" }, f),
        h("span", { class: "dim" }, `· ${r.edits} edits · ${fmtAgo(r.created)}`)));
    }
    out.push(rsec);
    out.push(h("div", { class: "insp-sec dim", style: { fontSize: "12px" } },
      h("label", {}, "Shortcuts"),
      h("div", { html: `<span class="kbd">Space</span> play · <span class="kbd">E</span> edit &amp; generate · <span class="kbd">P</span> play selection · <span class="kbd">G</span> regenerate · <span class="kbd">L</span> lock · <span class="kbd">←/→</span> seek · <span class="kbd">Ctrl+wheel</span> zoom · <span class="kbd">Esc</span> clear` })));
    return out;
  }

  editInspector(e) {
    const busy = S.busyEdits.has(e.id);
    const queued = this.pendingFor(e.id);
    const take = activeTake(e);
    const idx = edits().indexOf(e) + 1;
    const out = [];
    out.push(h("div", { class: "insp-title" },
      h("button", { class: "icon-btn small", title: "Back to project", onclick: () => this.selectEdit(null), html: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>' }),
      h("h2", {}, `Edit #${idx}`),
      h("span", { class: `chip ${e.locked ? "locked" : "draft"}` }, e.locked ? "Locked" : busy ? "Generating" : "Draft")));

    out.push(h("div", { class: "insp-sec" }, h("label", {}, "Original"),
      h("div", { class: "orig-text" }, e.original_text || "(silence)")));

    const ta = h("textarea", { rows: 2, disabled: e.locked, spellcheck: "false" });
    ta.value = e.text;
    out.push(h("div", { class: "insp-sec" }, h("label", {}, "New words"), ta));

    // timing
    const cut = (label, key) => {
      const inp = h("input", { type: "number", step: "0.01", value: e[key].toFixed(3), disabled: e.locked });
      inp.addEventListener("change", () => this.patchEdit(e.id, { [key]: +inp.value }));
      const nudge = d => h("button", { class: "btn ghost small", disabled: e.locked, onclick: () => this.patchEdit(e.id, { [key]: +(e[key] + d).toFixed(3) }) }, d > 0 ? "+10ms" : "−10ms");
      return h("div", { class: "cut-row" }, h("span", { class: "dim" }, label), inp, nudge(-0.01), nudge(0.01));
    };
    out.push(h("div", { class: "insp-sec" }, h("label", {}, `Region · ${(e.cut_end - e.cut_start).toFixed(2)} s · ${e.fit === "fit" ? "fit to length" : "natural length"}`),
      cut("In ", "cut_start"), cut("Out", "cut_end")));
    if (take && e.cut_start + take.duration > e.cut_end + 0.05) {
      out.push(h("div", { class: "warn-box" }, `This take runs ${(e.cut_start + take.duration - e.cut_end).toFixed(2)} s past the original words and covers what follows. Switch to “Fit to original length” or widen the region.`));
    }

    // actions
    const regen = h("button", { class: "btn primary", disabled: e.locked, title: "Queue another take (up to 10 jobs in the queue)", onclick: async () => {
      if (ta.value.trim() && ta.value.trim() !== e.text) await this.patchEdit(e.id, { text: ta.value.trim() }, false);
      this.regenerate(e.id);
    } }, h("span", { html: icons.redo, style: { width: "16px", height: "16px", display: "inline-flex" } }), queued > 1 ? `Regenerate · ${queued} queued` : busy ? "Regenerate · 1 running" : "Regenerate");
    const lock = h("button", { class: `btn ${e.locked ? "warn" : "success"}`, disabled: !take, onclick: () => this.toggleLock(e) },
      h("span", { html: e.locked ? icons.unlock : icons.lock, style: { width: "16px", height: "16px", display: "inline-flex" } }), e.locked ? "Unlock" : "Lock take");
    const prev = h("button", { class: "btn", disabled: !take, onclick: () => this.previewEdit(e.id) },
      h("span", { html: icons.ear, style: { width: "16px", height: "16px", display: "inline-flex" } }), "Preview in context");
    out.push(h("div", { class: "row" }, regen, lock), h("div", { class: "row" }, prev,
      h("button", { class: "btn", onclick: () => this.player.playRange(Math.max(0, e.cut_start - 2), editEnd(e) + 2) }, "Play ±2 s")));

    // takes
    const list = h("div", { class: "takes" });
    e.takes.slice().reverse().forEach((t, k) => {
      const n = e.takes.length - k;
      const row = h("div", { class: `take${t.id === e.active_take ? " active" : ""}`, title: "Click to use this take" },
        h("span", { class: "tnum" }, `T${n}`),
        h("div", {},
          h("div", { style: { fontSize: "13px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, t.text),
          h("div", { class: "tmeta" }, h("span", {}, `${t.duration.toFixed(2)} s`), h("span", {}, t.voice === "context" ? "context voice" : `voice: ${t.voice}`), h("span", {}, `seed ${t.seed}`)),
          t.heard != null ? h("div", { class: "tmeta", title: "What Whisper hears in this take", style: { color: sameWords(t.heard, t.text) ? "var(--locked)" : "var(--draft)" } },
            `${sameWords(t.heard, t.text) ? "✓" : "⚠"} heard: “${t.heard}”`) : null),
        h("div", { class: "tbtns" },
          h("button", { class: "icon-btn small", title: "Play take alone", html: icons.play, onclick: ev => { ev.stopPropagation(); this.player.playUrl(this.player.takeUrl(e.id, t.id)); } }),
          h("button", { class: "icon-btn small", title: "Preview this take in context", html: icons.ear, onclick: ev => { ev.stopPropagation(); this.previewEdit(e.id, t.id); } }),
          h("button", { class: "icon-btn small", title: "Delete take", html: icons.trash, disabled: e.locked && t.id === e.active_take, onclick: ev => { ev.stopPropagation(); this.deleteTake(e, t); } })));
      row.addEventListener("click", () => { if (!e.locked && t.id !== e.active_take) this.patchEdit(e.id, { active_take: t.id }); });
      list.append(row);
    });
    if (!e.takes.length) list.append(h("div", { class: "dim" }, busy ? "Generating the first take…" : "No takes yet."));
    out.push(h("div", { class: "insp-sec" }, h("label", {}, `Takes (${e.takes.length})`), list));

    // mix
    const slider = (label, key, min, max, step, fmt) => {
      const inp = h("input", { type: "range", min, max, step, value: e[key] ?? 0 });
      const o = h("output", {}, fmt(e[key] ?? 0));
      inp.addEventListener("input", () => { o.textContent = fmt(+inp.value); });
      inp.addEventListener("change", () => this.patchEdit(e.id, { [key]: +inp.value }));
      return h("label", { class: "slider-row" }, label, inp, o);
    };
    out.push(h("div", { class: "insp-sec" }, h("label", {}, "Mix"),
      slider("Gain", "gain_db", -12, 12, 0.5, v => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`),
      slider("Keep original", "bleed", 0, 0.6, 0.02, v => `${Math.round(v * 100)}%`)));

    out.push(h("div", { class: "row tight" },
      h("button", { class: "btn ghost small", onclick: () => this.patchEdit(e.id, { muted: !e.muted }) }, e.muted ? "Unmute edit" : "Mute edit"),
      h("button", { class: "btn ghost small", onclick: () => this.openEditDialog({ edit: e }) }, "Settings…"),
      h("button", { class: "btn ghost small danger", onclick: () => this.deleteEdit(e) }, "Delete edit")));
    return out;
  }

  selectEdit(id, reveal = false) {
    S.editId = id;
    const e = currentEdit();
    if (e && reveal) { this.timeline.reveal(e.cut_start); this.player.seek(e.cut_start); }
    this.renderInspector();
    this.transcript.updateSelection();
    this.timeline.dirty = true;
  }

  // ------------------------------------------------------------- edit actions
  async patchEdit(eid, body, refresh = true) {
    try {
      const updated = await api.patch(`/api/projects/${S.project.id}/edits/${eid}`, body);
      const i = S.project.edits.findIndex(e => e.id === eid);
      if (i >= 0) S.project.edits[i] = updated;
      if ("active_take" in body) this.player.preloadTakes();
      if (refresh) this.refreshAll();
    } catch (err) { toast(err.message, "err"); }
  }

  async regenerate(eid) {
    try {
      const job = await api.post(`/api/projects/${S.project.id}/edits/${eid}/generate`);
      this.afterGenerate(job, eid);
    } catch (err) { toast(err.message, "err"); }
  }

  pendingFor(eid) { return this.generating.get(eid) || 0; }

  // Generations are queued on the server (up to 10); several can be pending per edit.
  async afterGenerate(job, eid) {
    this.generating.set(eid, this.pendingFor(eid) + 1);
    S.busyEdits.add(eid);
    this.refreshAll();
    let done = null;
    try {
      done = await this.track(job, "Generation");
    } catch { /* toast shown by track */ }
    const left = this.pendingFor(eid) - 1;
    if (left > 0) this.generating.set(eid, left);
    else { this.generating.delete(eid); S.busyEdits.delete(eid); }
    await this.reload();
    if (!done) return;
    await this.player.buffer(eid, done.result.id).catch(() => {});
    this.timeline.dirty = true;
    // only auto-preview the last take of a batch, so previews don't pile up
    const auto = left <= 0 && !this.player.playing && !this.player.solo;
    if (auto) this.previewEdit(eid, done.result.id);
    toast(`New take ready (${done.result.duration.toFixed(2)} s)${auto ? " - previewing" : left > 0 ? ` · ${left} more queued` : ""}`, "ok");
  }

  async toggleLock(e) {
    await this.patchEdit(e.id, { locked: !e.locked });
    toast(e.locked ? "Edit unlocked" : "Take locked - it will be used in the final render", "ok");
  }

  async deleteTake(e, t) {
    try {
      const updated = await api.del(`/api/projects/${S.project.id}/edits/${e.id}/takes/${t.id}`);
      Object.assign(e, updated);
      this.refreshAll();
    } catch (err) { toast(err.message, "err"); }
  }

  async deleteEdit(e) {
    if (!(await confirmModal("Delete edit?", `“${e.text}” and its ${e.takes.length} take(s) will be removed. The original audio comes back.`, "Delete", true))) return;
    await api.del(`/api/projects/${S.project.id}/edits/${e.id}`);
    S.editId = null;
    await this.reload();
  }

  previewEdit(eid, tid) {
    const e = edits().find(x => x.id === eid);
    if (!e?.active_take && !tid) { toast("No take yet"); return; }
    const q = tid ? `?take=${tid}` : "";
    this.player.playUrl(`/api/projects/${S.project.id}/edits/${eid}/preview.wav${q}`).catch(err => toast(err.message, "err"));
  }

  // ------------------------------------------------------------- dialogs
  openEditDialog({ edit = null } = {}) {
    const sel = edit ? { start: edit.cut_start, end: edit.cut_end, text: edit.original_text } : selection();
    if (!sel) { toast("Select some words (or drag a range on the timeline) first"); return; }
    const voices = S.voices;
    const v = edit?.voice || { mode: "context" };
    const form = h("form", {});
    form.innerHTML = `
      <div class="modal-head">
        <div class="badge">${icons.sparkle}</div>
        <div><h2>${edit ? "Edit settings" : "Edit &amp; Generate"}</h2>
        <p>${fmtTime(sel.start)} → ${fmtTime(sel.end)} · ${(sel.end - sel.start).toFixed(2)} s</p></div>
      </div>
      <div class="modal-body">
        <div class="insp-sec"><label>Original</label><div class="orig-text">${esc(sel.text || "(no words here - new speech will be inserted)")}</div></div>
        <div class="insp-sec"><label>Say instead</label>
          <textarea class="big-text" name="text" rows="3" autofocus required spellcheck="false">${esc(edit ? edit.text : sel.text)}</textarea>
          <span class="dim" style="font-size:12px">Punctuation shapes intonation. Tags like [laughter] work too. <span class="kbd">Ctrl+Enter</span> generates.</span>
        </div>
        <div class="insp-sec"><label>Voice</label>
          <div class="voice-pick">
            <label class="voice-opt"><input type="radio" name="vmode" value="context" ${v.mode !== "library" ? "checked" : ""}>
              <b>🎯 Clone from context</b><span>Uses the surrounding words in this file</span></label>
            <label class="voice-opt"><input type="radio" name="vmode" value="library" ${v.mode === "library" ? "checked" : ""} ${voices.length ? "" : "disabled"}>
              <b>📚 Library voice</b><span>${voices.length ? "A saved voice prompt" : "No saved voices yet"}</span>
              <select name="vname">${voices.map(x => `<option ${x.name === v.name ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
          </div>
        </div>
        <div class="row">
          <div class="insp-sec"><label>Timing</label>
            <div class="seg"><label><input type="radio" name="fit" value="fit" ${(edit?.fit || "fit") === "fit" ? "checked" : ""}>Fit to original</label>
            <label><input type="radio" name="fit" value="natural" ${edit?.fit === "natural" ? "checked" : ""}>Natural</label></div>
          </div>
          <div class="insp-sec"><label>Quality</label>
            <div class="seg">${[16, 32, 48].map(n => `<label><input type="radio" name="num_step" value="${n}" ${(edit?.num_step || 32) === n ? "checked" : ""}>${n === 16 ? "Fast" : n === 32 ? "Good" : "Best"}</label>`).join("")}</div>
          </div>
        </div>
        <details class="adv"><summary>Advanced</summary>
          <label class="slider-row">Speed <input type="range" name="speed" min="0.6" max="1.6" step="0.05" value="${edit?.speed || 1}"><output>${(edit?.speed || 1).toFixed(2)}×</output></label>
          <label class="slider-row">Gain <input type="range" name="gain_db" min="-12" max="12" step="0.5" value="${edit?.gain_db || 0}"><output>${(edit?.gain_db || 0).toFixed(1)} dB</output></label>
          <label class="slider-row">Keep original <input type="range" name="bleed" min="0" max="0.6" step="0.02" value="${edit?.bleed || 0}"><output>${Math.round((edit?.bleed || 0) * 100)}%</output></label>
          <span class="dim" style="font-size:12px">Speed applies to natural timing. “Keep original” leaves some of the original under the new words (background music, room tone).</span>
        </details>
      </div>
      <div class="modal-foot">
        <span class="spacer">${S.status?.models?.state?.tts === "ready" ? "" : "First run loads OmniVoice (a few seconds)."}</span>
        <button type="button" class="btn" data-x>Cancel</button>
        <button type="submit" class="btn primary">${icons.sparkle}<span>${edit ? "Save &amp; regenerate" : "Generate"}</span></button>
      </div>`;
    form.querySelectorAll("button svg").forEach(s => { s.style.width = "16px"; s.style.height = "16px"; });
    form.querySelectorAll("input[type=range]").forEach(r => r.addEventListener("input", () => {
      const o = r.nextElementSibling;
      o.textContent = r.name === "speed" ? `${(+r.value).toFixed(2)}×` : r.name === "bleed" ? `${Math.round(r.value * 100)}%` : `${(+r.value).toFixed(1)} dB`;
    }));
    form.querySelector("select[name=vname]").addEventListener("change", () => { form.vmode.value = "library"; });
    form.querySelector("[data-x]").addEventListener("click", closeModal);
    form.text.addEventListener("keydown", ev => { if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); form.requestSubmit(); } });
    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      const fd = new FormData(form);
      const body = {
        text: fd.get("text").trim(),
        voice: fd.get("vmode") === "library" ? { mode: "library", name: fd.get("vname") } : { mode: "context" },
        fit: fd.get("fit"), num_step: +fd.get("num_step"),
        speed: +fd.get("speed") === 1 ? null : +fd.get("speed"),
        gain_db: +fd.get("gain_db"), bleed: +fd.get("bleed"),
      };
      if (!body.text) return;
      const submit = form.querySelector("button[type=submit]");
      submit.disabled = true;
      try {
        if (edit) {
          if (edit.locked) await this.patchEdit(edit.id, { locked: false }, false);
          await this.patchEdit(edit.id, body, false);
          closeModal();
          this.regenerate(edit.id);
        } else {
          const res = await api.post(`/api/projects/${S.project.id}/edits`, { ...body, start: sel.start, end: sel.end });
          closeModal();
          S.project.edits.push(res.edit);
          S.project.edits.sort((a, b) => a.cut_start - b.cut_start);
          S.sel = S.range = null;
          S.editId = res.edit.id;
          emit("selection");
          this.afterGenerate(res.job, res.edit.id);
        }
      } catch (err) {
        submit.disabled = false;
        toast(err.message, "err");
      }
    });
    openModal(form);
  }

  renderDialog() {
    const ed = edits();
    const locked = ed.filter(e => e.locked && e.active_take).length;
    const drafts = ed.filter(e => !e.locked && e.active_take).length;
    const form = h("form", {});
    form.innerHTML = `
      <div class="modal-head"><div class="badge">${icons.film}</div>
        <div><h2>Render final</h2><p>${esc(S.project.name)} · ${fmtTime(S.project.source.duration)}</p></div></div>
      <div class="modal-body">
        <div class="voice-pick">
          <label class="voice-opt"><input type="radio" name="include" value="locked" ${locked ? "checked" : ""}>
            <b>🔒 Locked only</b><span>${locked} locked edit${locked === 1 ? "" : "s"}</span></label>
          <label class="voice-opt"><input type="radio" name="include" value="active" ${locked ? "" : "checked"}>
            <b>✨ Everything</b><span>${locked + drafts} edits (drafts use their current take)</span></label>
        </div>
        <span class="dim" style="font-size:12px">The video stream is copied as is (no re-encode); only the audio track is replaced. Files go to the Outputs library.</span>
      </div>
      <div class="modal-foot"><span class="spacer"></span>
        <button type="button" class="btn" data-x>Cancel</button>
        <button type="submit" class="btn primary">Render</button></div>`;
    form.querySelector("[data-x]").addEventListener("click", closeModal);
    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      const include = new FormData(form).get("include");
      closeModal();
      try {
        const job = await api.post(`/api/projects/${S.project.id}/render`, { include });
        toast("Rendering…");
        const done = await this.track(job, "Render");
        const f = done.result.video || done.result.audio;
        toast(h("span", {}, "Rendered ", h("a", { href: `/api/outputs/${encodeURIComponent(f)}`, target: "_blank", style: { color: "var(--accent-2)" } }, f)), "ok");
        await this.reload();
      } catch (err) { /* toast shown by track */ }
    });
    openModal(form);
  }

  cloneVoiceDialog() {
    const sel = selection();
    if (!sel) return;
    const dur = sel.end - sel.start;
    const form = h("form", {});
    form.innerHTML = `
      <div class="modal-head"><div class="badge">${icons.dna}</div>
        <div><h2>Save voice to library</h2><p>${fmtTime(sel.start)} → ${fmtTime(sel.end)} · ${dur.toFixed(2)} s</p></div></div>
      <div class="modal-body">
        <input name="name" placeholder="Voice name" required autofocus pattern="[\\w.\\- ]+" spellcheck="false">
        <div class="orig-text" style="text-decoration:none">${esc(sel.text || "(Whisper will transcribe it)")}</div>
        ${dur < 3 || dur > 15 ? `<div class="warn-box">3–10 s of clean speech from one speaker works best (this is ${dur.toFixed(1)} s).</div>` : ""}
      </div>
      <div class="modal-foot"><span class="spacer"></span><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Clone voice</button></div>`;
    form.querySelector("[data-x]").addEventListener("click", closeModal);
    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      const name = form.name.value.trim();
      try {
        const job = await api.post(`/api/projects/${S.project.id}/clone-voice`, { start: sel.start, end: sel.end, name });
        closeModal();
        toast(`Cloning “${name}”…`);
        await this.track(job, "Voice clone");
        toast(`Voice “${name}” saved to the library`, "ok");
        emit("voicesChanged");
      } catch (err) { if (modalOpen()) toast(err.message, "err"); }
    });
    openModal(form);
  }

  addWordsDialog() {
    const sel = selection();
    if (!sel) return;
    const form = h("form", {});
    form.innerHTML = `
      <div class="modal-head"><div class="badge">${icons.pen}</div>
        <div><h2>Type the transcript for this range</h2><p>${fmtTime(sel.start)} → ${fmtTime(sel.end)}</p></div></div>
      <div class="modal-body">
        <textarea class="big-text" name="text" rows="3" autofocus spellcheck="false" placeholder="What is said here…">${esc(sel.text)}</textarea>
        <span class="dim" style="font-size:12px">Words in this range are replaced; timing is spread evenly, drag word edges on the timeline to refine.</span>
      </div>
      <div class="modal-foot"><span class="spacer"></span><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Set transcript</button></div>`;
    form.querySelector("[data-x]").addEventListener("click", closeModal);
    form.addEventListener("submit", ev => {
      ev.preventDefault();
      const parts = form.text.value.trim().split(/\s+/).filter(Boolean);
      const keep = words().filter(w => (w.start + w.end) / 2 < sel.start || (w.start + w.end) / 2 > sel.end);
      const step = (sel.end - sel.start) / Math.max(1, parts.length);
      const added = parts.map((p, k) => ({ id: "", text: p, start: +(sel.start + k * step).toFixed(3), end: +(sel.start + (k + 1) * step).toFixed(3) }));
      S.project.words = [...keep, ...added].sort((a, b) => a.start - b.start);
      S.sel = S.range = null;
      closeModal();
      emit("wordsChanged");
      this.refreshAll();
    });
    openModal(form);
  }

  deleteSelectedWords() {
    const sel = selection();
    if (!sel) return;
    S.project.words = words().filter(w => (w.start + w.end) / 2 < sel.start || (w.start + w.end) / 2 > sel.end);
    S.sel = S.range = null;
    emit("wordsChanged");
    this.refreshAll();
  }

  async transcribe(range) {
    if (!S.project || S.project.status !== "ready") return;
    if (!range && words().length && !(await confirmModal("Transcribe everything again?", "The current transcript (including your corrections) is replaced. Edits and takes are kept.", "Transcribe"))) return;
    try {
      const job = await api.post(`/api/projects/${S.project.id}/transcribe`, {
        start: range?.start ?? null, end: range?.end ?? null, language: $("#langSelect").value,
      });
      toast(range ? "Transcribing selection…" : "Transcribing… (first run loads Whisper)");
      const done = await this.track(job, "Transcription");
      toast(`Transcribed ${done.result.words} words`, "ok");
      S.sel = S.range = null;
      await this.reload();
    } catch { /* toast shown by track */ }
  }

  // ------------------------------------------------------------- menus
  showMenu({ x, y, edit }) {
    if (edit) {
      openMenu(x, y, `Edit: “${edit.text}”`, [
        { label: "Preview in context", icon: icons.ear, key: "P", run: () => this.previewEdit(edit.id), disabled: !edit.active_take },
        { label: "Regenerate", icon: icons.redo, key: "G", run: () => this.regenerate(edit.id), disabled: edit.locked },
        { label: edit.locked ? "Unlock" : "Lock take", icon: edit.locked ? icons.unlock : icons.lock, key: "L", run: () => this.toggleLock(edit), disabled: !edit.active_take },
        { label: "Change words / voice…", icon: icons.pen, run: () => this.openEditDialog({ edit }) },
        { label: edit.muted ? "Unmute" : "Mute (hear original)", icon: icons.mute, run: () => this.patchEdit(edit.id, { muted: !edit.muted }) },
        "-",
        { label: "Delete edit", icon: icons.trash, cls: "danger", run: () => this.deleteEdit(edit) },
      ]);
      return;
    }
    const sel = selection();
    if (!sel) return;
    const head = sel.text ? `“${sel.text.length > 60 ? sel.text.slice(0, 60) + "…" : sel.text}”` : `${fmtTime(sel.start)} → ${fmtTime(sel.end)}`;
    openMenu(x, y, head, [
      { label: "Edit & Generate…", icon: icons.sparkle, key: "E", cls: "hero", run: () => this.openEditDialog() },
      { label: "Play selection", icon: icons.play, key: "P", run: () => this.player.playRange(sel.start, sel.end) },
      { label: "Zoom to selection", icon: icons.zoom, key: "Z", run: () => this.timeline.zoomTo(sel.start, sel.end) },
      "-",
      { label: "Transcribe this range", icon: icons.mic, run: () => this.transcribe({ start: sel.start, end: sel.end }) },
      { label: sel.text ? "Correct transcript…" : "Type transcript…", icon: icons.pen, run: () => sel.a != null && sel.a === sel.b ? this.transcript.editWord(sel.a) : this.addWordsDialog() },
      { label: "Save voice to library…", icon: icons.dna, run: () => this.cloneVoiceDialog() },
      "-",
      { label: "Delete words from transcript", icon: icons.trash, cls: "danger", run: () => this.deleteSelectedWords(), hidden: !sel.text },
    ]);
  }

  // ------------------------------------------------------------- persistence
  scheduleWordsSave() {
    clearTimeout(this.saveTimer);
    const version = ++this.wordsVersion;
    this.saveTimer = setTimeout(async () => {
      try {
        const res = await api.put(`/api/projects/${S.project.id}/words`, { words: words() });
        if (version === this.wordsVersion) {
          this.saveTimer = null;
          S.project.words = res.words;
          this.transcript.render();
          this.timeline.dirty = true;
        }
      } catch (err) { toast(`Saving transcript failed: ${err.message}`, "err"); this.saveTimer = null; }
    }, 500);
  }

  // ------------------------------------------------------------- wiring
  bindBus() {
    on("selection", () => { this.transcript.updateSelection(); this.updateSelUi(); this.timeline.dirty = true; });
    on("editSelected", () => this.selectEdit(S.editId));
    on("previewEdit", eid => this.previewEdit(eid));
    on("menu", m => this.showMenu(m));
    on("editWord", i => this.transcript.editWord(i));
    on("wordsTouched", () => { this.timeline.dirty = true; });
    on("wordsChanged", () => { this.scheduleWordsSave(); this.timeline.dirty = true; });
    on("transcriptChanged", () => this.transcript.render());
    on("transcribeAll", () => this.transcribe(null));
    on("time", t => {
      $("#tcNow").textContent = fmtTime(t);
      const e = edits().find(x => t >= x.cut_start && t < editEnd(x) && x.active_take && !x.muted);
      const badge = $("#editBadge");
      badge.classList.toggle("hidden", !(e && this.player.abEnabled && this.player.playing));
      if (e) { badge.textContent = e.locked ? "EDITED · LOCKED" : "EDITED · DRAFT"; badge.classList.toggle("locked", !!e.locked); }
    });
    on("playstate", playing => {
      $("#btnPlay .ico-play").classList.toggle("hidden", playing);
      $("#btnPlay .ico-pause").classList.toggle("hidden", !playing);
      if (!playing) $("#editBadge").classList.add("hidden");
    });
    on("zoom", v => { $("#zoomRange").value = v; });
    on("buffers", () => { this.timeline.dirty = true; });
  }

  bindUi() {
    $("#btnPlay").addEventListener("click", () => this.player.toggle());
    $("#btnBack").addEventListener("click", () => this.player.seek(this.player.time - 5));
    $("#btnFwd").addEventListener("click", () => this.player.seek(this.player.time + 5));
    $("#volume").addEventListener("input", e => this.player.setVolume(+e.target.value));
    $("#abToggle").addEventListener("change", e => { this.player.abEnabled = e.target.checked; this.player.stopOverlay(); this.timeline.dirty = true; });
    $("#zoomIn").addEventListener("click", () => this.timeline.setPps(this.timeline.pps * 1.5, this.timeline.x(this.player.time)));
    $("#zoomOut").addEventListener("click", () => this.timeline.setPps(this.timeline.pps / 1.5, this.timeline.x(this.player.time)));
    $("#zoomFit").addEventListener("click", () => this.timeline.fit());
    $("#zoomRange").addEventListener("input", e => this.timeline.setZoomValue(+e.target.value));
    $("#btnTranscribeAll").addEventListener("click", () => this.transcribe(null));
    $("#btnTranscribeRange").addEventListener("click", () => { const s = selection(); if (s) this.transcribe({ start: s.start, end: s.end }); });
    $("#btnRender").addEventListener("click", () => this.renderDialog());
    $("#media").addEventListener("click", () => this.player.toggle());
    $("#langSelect").addEventListener("change", async e => {
      await api.patch(`/api/projects/${S.project.id}`, { language: e.target.value });
      S.project.language = e.target.value;
    });
    const name = $("#projectName");
    name.addEventListener("change", async () => {
      if (!name.value.trim()) { name.value = S.project.name; return; }
      await api.patch(`/api/projects/${S.project.id}`, { name: name.value.trim() });
      S.project.name = name.value.trim();
    });
    name.addEventListener("keydown", e => { if (e.key === "Enter") name.blur(); });

    document.addEventListener("keydown", e => {
      if (!S.project || !$("#view-editor").classList.contains("active")) return;
      if (modalOpen()) { if (e.key === "Escape") closeModal(); return; }
      const tag = document.activeElement?.tagName;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || document.activeElement?.isContentEditable) return;
      const e0 = currentEdit(), sel = selection();
      const k = e.key.toLowerCase();
      if (e.key === " ") { e.preventDefault(); this.player.toggle(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); this.player.seek(this.player.time - (e.shiftKey ? 5 : 1)); }
      else if (e.key === "ArrowRight") { e.preventDefault(); this.player.seek(this.player.time + (e.shiftKey ? 5 : 1)); }
      else if (e.key === "Escape") { closeMenu(); this.player.stopSolo(); S.sel = S.range = null; emit("selection"); }
      else if (k === "e" || (e.key === "Enter" && sel)) { e.preventDefault(); this.openEditDialog(); }
      else if (k === "p") { if (sel) this.player.playRange(sel.start, sel.end); else if (e0) this.previewEdit(e0.id); }
      else if (k === "g" && e0 && !e0.locked) this.regenerate(e0.id);
      else if (k === "l" && e0 && e0.active_take) this.toggleLock(e0);
      else if (k === "z" && sel) this.timeline.zoomTo(sel.start, sel.end);
      else if (e.key === "+" || e.key === "=") this.timeline.setPps(this.timeline.pps * 1.5, this.timeline.x(this.player.time));
      else if (e.key === "-") this.timeline.setPps(this.timeline.pps / 1.5, this.timeline.x(this.player.time));
      else if (e.key === "Delete" && e0) this.deleteEdit(e0);
    });
  }

  drawAudioArt() {
    const c = $("#audioViz"), g = c.getContext("2d");
    const r = c.getBoundingClientRect();
    c.width = r.width * devicePixelRatio; c.height = r.height * devicePixelRatio;
    const peaks = S.peaks;
    if (!peaks) return;
    const n = 120, step = Math.floor(peaks.length / n) || 1, w = c.width / n;
    const grad = g.createLinearGradient(0, 0, c.width, 0);
    grad.addColorStop(0, "#7c5cff"); grad.addColorStop(1, "#22d3ee");
    g.fillStyle = grad;
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = i * step; j < (i + 1) * step && j < peaks.length; j++) m = Math.max(m, peaks[j]);
      const hh = Math.max(4, (m / 255) * c.height * 0.9);
      g.fillRect(i * w + w * 0.2, (c.height - hh) / 2, w * 0.6, hh);
    }
  }
}

// Loose comparison of the take's ASR text with what was asked for.
function sameWords(a, b) {
  const norm = s => (s || "").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean).join(" ");
  return norm(a) === norm(b);
}

export function confirmModal(title, text, ok = "OK", danger = false) {
  return new Promise(resolve => {
    let answered = false;
    const node = h("div", {},
      h("div", { class: "modal-head" }, h("div", {}, h("h2", {}, title))),
      h("div", { class: "modal-body" }, h("div", { class: "dim" }, text)),
      h("div", { class: "modal-foot" }, h("span", { class: "spacer" }),
        h("button", { class: "btn", onclick: () => closeModal() }, "Cancel"),
        h("button", { class: `btn ${danger ? "danger" : "primary"}`, autofocus: true, onclick: () => { answered = true; closeModal(); } }, ok)));
    openModal(node, () => resolve(answered));
  });
}
