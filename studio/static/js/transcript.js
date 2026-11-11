// Transcript panel: flowing words, drag selection, inline correction, edit chips.

import { S, emit, on, words, edits, wordIndexAt, selection } from "./state.js";
import { $, h, fmtTime, icons } from "./util.js";

export class Transcript {
  constructor(root, player) {
    this.root = root;
    this.player = player;
    this.spans = [];
    this.nowIdx = -1;
    this.dragging = false;
    this.follow = true;
    this.matches = [];
    this.matchPos = -1;
    this.bind();
    on("time", t => this.markNow(t));
  }

  render() {
    const root = this.root, w = words();
    root.innerHTML = "";
    this.spans = [];
    this.nowIdx = -1;
    if (!S.project) return;
    if (!w.length) {
      const ready = S.project.status === "ready";
      root.append(h("div", { class: "transcript-empty" },
        h("div", { html: icons.mic, style: { width: "36px", height: "36px", margin: "0 auto 10px", color: "var(--accent)" } }),
        ready ? "No transcript yet." : "Importing media…",
        h("br"),
        ready ? "Auto-transcribe the whole file, or drag across the waveform and transcribe just that range. You can also type words in by hand." : "",
        ready ? h("div", {}, h("button", { class: "btn primary", onclick: () => emit("transcribeAll") }, "Auto-transcribe all")) : ""));
      return;
    }
    // map each word to the edit covering it; chips go after the edit's last word
    const owner = new Array(w.length).fill(null);
    for (const e of edits()) {
      for (let i = 0; i < w.length; i++) {
        const mid = (w[i].start + w[i].end) / 2;
        if (mid >= e.cut_start && mid <= e.cut_end) owner[i] = e;
      }
    }
    const placedChip = new Set();
    let para = null;
    for (let i = 0; i < w.length; i++) {
      const wd = w[i], prev = w[i - 1];
      const brk = !prev || wd.start - prev.end > 1.2 || (/[.!?…]$/.test(prev.text) && wd.start - prev.end > 0.45);
      if (brk) {
        para = h("p", { class: "para" }, h("span", { class: "para-ts", "data-t": wd.start }, fmtTime(wd.start, false)));
        root.append(para);
      }
      // chip for an edit that has no words (inserted in a gap) goes before the next word
      for (const e of edits()) {
        if (!placedChip.has(e.id) && e.cut_end <= wd.start && !owner.includes(e)) {
          para.append(this.chip(e)); placedChip.add(e.id);
        }
      }
      const e = owner[i];
      const span = h("span", { class: `w${e ? " edited" + (e.locked ? " locked" : "") : ""}`, "data-i": i }, wd.text);
      this.spans.push(span);
      para.append(span, " ");
      if (e && (i === w.length - 1 || owner[i + 1] !== e) && !placedChip.has(e.id)) {
        para.append(this.chip(e), " ");
        placedChip.add(e.id);
      }
    }
    for (const e of edits()) if (!placedChip.has(e.id)) para.append(this.chip(e));
    this.updateSelection();
    this.markNow(this.player.time, true);
    this.applyFind();
  }

  chip(e) {
    const busy = S.busyEdits.has(e.id);
    return h("span", {
      class: `repl${e.locked ? " locked" : ""}${busy ? " busy" : ""}${S.editId === e.id ? " cur" : ""}`,
      "data-edit": e.id, title: `${e.locked ? "Locked" : "Draft"} edit · click to inspect, double-click to preview`,
    }, (e.locked ? "🔒 " : "✨ ") + e.text);
  }

  updateSelection() {
    const sel = selection();
    const a = sel?.a ?? -1, b = sel?.b ?? -2;
    this.spans.forEach((s, i) => s.classList.toggle("sel", i >= a && i <= b));
    this.root.querySelectorAll(".repl").forEach(c => c.classList.toggle("cur", c.dataset.edit === S.editId));
  }

  markNow(t, force = false) {
    const i = wordIndexAt(t);
    if (i === this.nowIdx && !force) return;
    this.spans[this.nowIdx]?.classList.remove("now");
    this.nowIdx = i;
    const s = this.spans[i];
    if (!s) return;
    s.classList.add("now");
    if (this.follow && this.player.playing) {
      const r = s.getBoundingClientRect(), pr = this.root.getBoundingClientRect();
      if (r.top < pr.top + 30 || r.bottom > pr.bottom - 30) {
        this.root.scrollTo({ top: this.root.scrollTop + r.top - pr.top - pr.height / 3, behavior: "smooth" });
      }
    }
  }

  scrollToWord(i) {
    const s = this.spans[i];
    if (!s) return;
    const r = s.getBoundingClientRect(), pr = this.root.getBoundingClientRect();
    if (r.top < pr.top || r.bottom > pr.bottom) this.root.scrollTo({ top: this.root.scrollTop + r.top - pr.top - pr.height / 3 });
  }

  bind() {
    const root = this.root;
    root.addEventListener("mousedown", e => {
      if (e.button !== 0 || e.target.closest(".editing")) return;
      const span = e.target.closest(".w");
      if (!span) return;
      e.preventDefault();
      const i = +span.dataset.i;
      const anchor = e.shiftKey && S.sel ? S.sel.a : i;
      S.sel = { a: anchor, b: i };
      S.range = null;
      this.dragging = { anchor, moved: false, shift: e.shiftKey };
      emit("selection");
    });
    root.addEventListener("mouseover", e => {
      if (!this.dragging) return;
      const span = e.target.closest(".w");
      if (!span) return;
      const i = +span.dataset.i;
      if (i !== S.sel.b) { S.sel = { a: this.dragging.anchor, b: i }; this.dragging.moved = true; emit("selection"); }
    });
    window.addEventListener("mouseup", () => {
      const d = this.dragging;
      this.dragging = false;
      if (d && !d.moved && !d.shift && S.sel) this.player.seek(words()[S.sel.a].start);
    });
    root.addEventListener("click", e => {
      const ts = e.target.closest(".para-ts");
      if (ts) { this.player.seek(+ts.dataset.t); return; }
      const chip = e.target.closest(".repl");
      if (chip) { S.editId = chip.dataset.edit; emit("editSelected", S.editId); }
    });
    root.addEventListener("dblclick", e => {
      const chip = e.target.closest(".repl");
      if (chip) { emit("previewEdit", chip.dataset.edit); return; }
      const span = e.target.closest(".w");
      if (span) this.editWord(+span.dataset.i);
    });
    root.addEventListener("contextmenu", e => {
      const chip = e.target.closest(".repl");
      if (chip) {
        e.preventDefault();
        S.editId = chip.dataset.edit;
        emit("editSelected", S.editId);
        emit("menu", { x: e.clientX, y: e.clientY, edit: edits().find(x => x.id === S.editId) });
        return;
      }
      const span = e.target.closest(".w");
      if (!span) return;
      e.preventDefault();
      const i = +span.dataset.i, sel = selection();
      if (!sel || sel.a == null || i < sel.a || i > sel.b) { S.sel = { a: i, b: i }; S.range = null; emit("selection"); }
      emit("menu", { x: e.clientX, y: e.clientY });
    });

    const find = $("#findInput");
    find.addEventListener("input", () => { this.matchPos = -1; this.applyFind(); });
    find.addEventListener("keydown", e => {
      if (e.key === "Enter" && this.matches.length) {
        e.preventDefault();
        this.matchPos = (this.matchPos + (e.shiftKey ? -1 : 1) + this.matches.length) % this.matches.length;
        const [a, b] = this.matches[this.matchPos];
        S.sel = { a, b }; S.range = null;
        emit("selection");
        this.scrollToWord(a);
        this.player.seek(words()[a].start);
      } else if (e.key === "Escape") { find.value = ""; this.applyFind(); find.blur(); }
    });
    $("#followToggle").addEventListener("change", e => { this.follow = e.target.checked; });
  }

  // Phrase search across word boundaries; matches are [firstIdx, lastIdx].
  applyFind() {
    const q = $("#findInput").value.trim().toLowerCase();
    this.spans.forEach(s => s.classList.remove("find"));
    this.matches = [];
    if (!q) return;
    const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, "");
    const target = norm(q).split(/\s+/).filter(Boolean);
    const w = words().map(x => norm(x.text));
    for (let i = 0; i < w.length; i++) {
      if (target.every((t, k) => (k === target.length - 1 ? w[i + k]?.startsWith(t) : w[i + k] === t))) {
        this.matches.push([i, i + target.length - 1]);
        for (let k = 0; k < target.length; k++) this.spans[i + k]?.classList.add("find");
      }
    }
  }

  // Inline correction: one word stays one word; several words split its time evenly.
  editWord(i) {
    const span = this.spans[i];
    if (!span) return;
    this.scrollToWord(i);
    const before = span.textContent;
    span.classList.add("editing");
    span.contentEditable = "plaintext-only";
    span.focus();
    const r = document.createRange();
    r.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    let done = false;
    const finish = commit => {
      if (done) return;
      done = true;
      span.contentEditable = "false";
      span.classList.remove("editing");
      const text = span.textContent.trim();
      if (!commit || text === before) { span.textContent = before; return; }
      const w = words(), wd = w[i];
      const parts = text.split(/\s+/).filter(Boolean);
      if (!parts.length) {
        w.splice(i, 1);
      } else {
        const step = (wd.end - wd.start) / parts.length;
        const repl = parts.map((p, k) => ({
          id: k === 0 ? wd.id : "", text: p,
          start: +(wd.start + step * k).toFixed(3), end: +(wd.start + step * (k + 1)).toFixed(3),
        }));
        w.splice(i, 1, ...repl);
      }
      S.sel = null;
      emit("wordsChanged");
      emit("transcriptChanged");
    };
    span.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
      e.stopPropagation();
    });
    span.addEventListener("blur", () => finish(true), { once: true });
  }
}
