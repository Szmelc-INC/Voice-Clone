// Canvas timeline: ruler, original waveform, word lane and the voice-edit track.

import { S, emit, words, edits, editEnd, activeTake, selection } from "./state.js";
import { fmtTime } from "./util.js";

const GUTTER = 92;
const MAX_PPS = 2400;
const EDGE_PX = 5;
const STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];

const C = {
  bg: "#0f121a", lane: "#121621", laneAlt: "#141926", grid: "#1d2331", text: "#8b93a7", textHi: "#e7eaf2",
  wave: "#4d5a78", waveMuted: "#262d3e", waveHi: "#7f8db3", sel: "rgba(124,92,255,.22)", selEdge: "#7c5cff",
  word: "#1e2433", wordHi: "#7c5cff", wordEdited: "#1a1d26", playhead: "#ff4d6d",
  draft: "#f5a524", draftSoft: "rgba(245,165,36,.16)", locked: "#2fd27c", lockedSoft: "rgba(47,210,124,.15)",
  muted: "#5d657a",
};

export class Timeline {
  constructor(canvas, player) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d");
    this.player = player;
    this.pps = 100;            // pixels per second
    this.scroll = 0;           // seconds at the left edge of the track area
    this.dirty = true;
    this.drag = null;
    this.hover = null;
    this.takePeaks = new Map();
    this.layout();
    new ResizeObserver(() => { this.layout(); this.dirty = true; }).observe(canvas.parentElement);
    this.bind();
    const loop = () => { if (this.dirty || this.player.playing) this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  // --------------------------------------------------------------- geometry
  layout() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.W = Math.max(200, r.width);
    this.H = Math.max(160, r.height);
    this.canvas.width = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ruler = 24, scrollbar = 12, words = 34, editsH = 66;
    const wave = this.H - ruler - words - editsH - scrollbar;
    this.L = {
      ruler: { y: 0, h: ruler },
      wave: { y: ruler, h: wave },
      words: { y: ruler + wave, h: words },
      edits: { y: ruler + wave + words, h: editsH },
      bar: { y: this.H - scrollbar, h: scrollbar },
    };
  }

  get trackW() { return this.W - GUTTER; }
  get duration() { return S.project?.source?.duration || 0; }
  x(t) { return GUTTER + (t - this.scroll) * this.pps; }
  t(x) { return this.scroll + (x - GUTTER) / this.pps; }
  laneAt(y) {
    for (const [k, v] of Object.entries(this.L)) if (y >= v.y && y < v.y + v.h) return k;
    return null;
  }
  minPps() { return this.duration ? this.trackW / this.duration : 50; }

  setPps(pps, anchorX = GUTTER + this.trackW / 2) {
    const at = this.t(anchorX);
    this.pps = Math.max(this.minPps(), Math.min(MAX_PPS, pps));
    this.scroll = at - (anchorX - GUTTER) / this.pps;
    this.clampScroll();
    emit("zoom", this.zoomValue());
  }
  zoomValue() {
    const lo = Math.log(this.minPps()), hi = Math.log(MAX_PPS);
    return hi > lo ? Math.round(1000 * (Math.log(this.pps) - lo) / (hi - lo)) : 0;
  }
  setZoomValue(v) {
    const lo = Math.log(this.minPps()), hi = Math.log(MAX_PPS);
    this.setPps(Math.exp(lo + (hi - lo) * v / 1000), this.x(this.player.time));
  }
  clampScroll() {
    const maxScroll = Math.max(0, this.duration - this.trackW / this.pps);
    this.scroll = Math.max(0, Math.min(maxScroll, this.scroll));
    this.dirty = true;
  }
  fit() { this.pps = this.minPps(); this.scroll = 0; this.dirty = true; emit("zoom", this.zoomValue()); }
  zoomTo(start, end) {
    const span = Math.max(0.2, end - start);
    this.pps = Math.max(this.minPps(), Math.min(MAX_PPS, this.trackW / (span * 1.4)));
    this.scroll = start - span * 0.2;
    this.clampScroll();
    emit("zoom", this.zoomValue());
  }
  reveal(t) {
    const x = this.x(t);
    if (x < GUTTER + 20 || x > this.W - 40) { this.scroll = t - (this.trackW / this.pps) * 0.15; this.clampScroll(); }
  }
  setProject() {
    this.takePeaks.clear();
    this.fit();
    this.pps = Math.min(MAX_PPS, Math.max(this.minPps(), this.duration > 60 ? this.trackW / 60 : this.minPps()));
    this.dirty = true;
    emit("zoom", this.zoomValue());
  }

  // --------------------------------------------------------------- hit tests
  wordAt(x) {
    const t = this.t(x), w = words();
    let lo = 0, hi = w.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (w[m].end < t) lo = m + 1; else if (w[m].start > t) hi = m - 1; else return m;
    }
    return -1;
  }
  wordEdgeAt(x) {
    const w = words();
    const t = this.t(x), tol = EDGE_PX / this.pps;
    for (let i = 0; i < w.length; i++) {
      if (w[i].start - tol > t) break;
      if (Math.abs(w[i].start - t) <= tol) return { i, side: "start" };
      if (Math.abs(w[i].end - t) <= tol) return { i, side: "end" };
    }
    return null;
  }
  editAtX(x) {
    const t = this.t(x);
    return edits().find(e => t >= e.cut_start && t <= editEnd(e)) || null;
  }

  // --------------------------------------------------------------- input
  bind() {
    const c = this.canvas;
    const pos = e => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    c.addEventListener("wheel", e => {
      if (!S.project) return;
      e.preventDefault();
      const { x } = pos(e);
      if (e.ctrlKey || e.metaKey || e.altKey) {
        this.setPps(this.pps * Math.exp(-e.deltaY * 0.0022), Math.max(GUTTER, x));
      } else {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        this.scroll += d / this.pps;
        this.clampScroll();
      }
    }, { passive: false });

    c.addEventListener("mousedown", e => {
      if (!S.project || e.button !== 0) return;
      const p = pos(e), lane = this.laneAt(p.y);
      if (p.x < GUTTER && lane !== "bar") return;
      if (lane === "bar") return this.startBarDrag(p);
      if (lane === "ruler") { this.drag = { kind: "scrub" }; this.player.seek(this.t(p.x)); return; }
      if (lane === "words") {
        const edge = this.wordEdgeAt(p.x);
        if (edge) { this.drag = { kind: "edge", ...edge, moved: false }; return; }
        const i = this.wordAt(p.x);
        if (i >= 0) {
          const anchor = e.shiftKey && S.sel ? S.sel.a : i;
          S.sel = { a: anchor, b: i };
          S.range = null;
          this.drag = { kind: "words", anchor, x0: p.x };
          emit("selection");
          return;
        }
      }
      if (lane === "edits") {
        const ed = this.editAtX(p.x);
        if (ed) { S.editId = ed.id; emit("editSelected", ed.id); this.dirty = true; this.drag = { kind: "none" }; return; }
      }
      this.drag = { kind: "range", t0: this.t(p.x), x0: p.x };
    });

    window.addEventListener("mousemove", e => {
      if (!S.project) return;
      const p = pos(e);
      if (!this.drag) { this.updateCursor(p); return; }
      const t = Math.max(0, Math.min(this.duration, this.t(p.x)));
      const d = this.drag;
      if (d.kind === "scrub") this.player.seek(t);
      else if (d.kind === "bar") {
        this.scroll = d.s0 + (p.x - d.x0) * (this.duration / this.trackW);
        this.clampScroll();
      } else if (d.kind === "range" && Math.abs(p.x - d.x0) > 3) {
        S.range = { start: Math.min(d.t0, t), end: Math.max(d.t0, t) };
        S.sel = null;
        emit("selection");
      } else if (d.kind === "words") {
        const i = this.wordAt(p.x);
        if (i >= 0 && i !== S.sel.b) { S.sel = { a: d.anchor, b: i }; emit("selection"); }
      } else if (d.kind === "edge") {
        const w = words(), wd = w[d.i];
        const minGap = 0.02;
        if (d.side === "start") {
          const lo = d.i > 0 ? w[d.i - 1].end : 0;
          wd.start = Math.round(Math.max(lo, Math.min(wd.end - minGap, t)) * 1000) / 1000;
        } else {
          const hi = d.i < w.length - 1 ? w[d.i + 1].start : this.duration;
          wd.end = Math.round(Math.min(hi, Math.max(wd.start + minGap, t)) * 1000) / 1000;
        }
        d.moved = true;
        emit("wordsTouched");
      }
      this.dirty = true;
    });

    window.addEventListener("mouseup", e => {
      const d = this.drag;
      this.drag = null;
      if (!d || !S.project) return;
      const p = pos(e);
      if (d.kind === "range" && Math.abs(p.x - d.x0) <= 3) {
        S.range = null; S.sel = null;
        emit("selection");
        this.player.seek(this.t(p.x));
      } else if (d.kind === "words" && Math.abs(p.x - d.x0) <= 3 && S.sel && S.sel.a === S.sel.b && !e.shiftKey) {
        this.player.seek(words()[S.sel.a].start);
      } else if (d.kind === "edge" && d.moved) {
        emit("wordsChanged");
      }
      this.dirty = true;
    });

    c.addEventListener("dblclick", e => {
      const p = pos(e);
      if (this.laneAt(p.y) === "words") {
        const i = this.wordAt(p.x);
        if (i >= 0) emit("editWord", i);
      } else if (this.laneAt(p.y) === "edits") {
        const ed = this.editAtX(p.x);
        if (ed) emit("previewEdit", ed.id);
      }
    });

    c.addEventListener("contextmenu", e => {
      if (!S.project) return;
      e.preventDefault();
      const p = pos(e), lane = this.laneAt(p.y), t = this.t(p.x);
      if (lane === "edits") {
        const ed = this.editAtX(p.x);
        if (ed) { S.editId = ed.id; emit("editSelected", ed.id); emit("menu", { x: e.clientX, y: e.clientY, edit: ed }); return; }
      }
      const sel = selection();
      if (!sel || t < sel.start || t > sel.end) {
        const i = this.wordAt(p.x);
        if (i >= 0) { S.sel = { a: i, b: i }; S.range = null; emit("selection"); }
      }
      emit("menu", { x: e.clientX, y: e.clientY });
    });
  }

  startBarDrag(p) {
    const { x0, w } = this.thumb();
    if (p.x < x0 || p.x > x0 + w) {
      this.scroll = (p.x - GUTTER - w / 2) / this.trackW * this.duration;
      this.clampScroll();
    }
    this.drag = { kind: "bar", x0: p.x, s0: this.scroll };
  }

  updateCursor(p) {
    const lane = this.laneAt(p.y);
    let cur = "crosshair";
    if (p.x < GUTTER) cur = "default";
    else if (lane === "words") cur = this.wordEdgeAt(p.x) ? "ew-resize" : this.wordAt(p.x) >= 0 ? "pointer" : "crosshair";
    else if (lane === "edits") cur = this.editAtX(p.x) ? "pointer" : "default";
    else if (lane === "ruler") cur = "col-resize";
    else if (lane === "bar") cur = "grab";
    if (this.canvas.style.cursor !== cur) this.canvas.style.cursor = cur;
  }

  thumb() {
    const vis = this.trackW / this.pps;
    const w = Math.max(30, this.trackW * Math.min(1, vis / Math.max(this.duration, 1e-6)));
    const x0 = GUTTER + (this.trackW - w) * (this.scroll / Math.max(1e-6, this.duration - vis) || 0);
    return { x0, w };
  }

  // --------------------------------------------------------------- drawing
  draw() {
    this.dirty = false;
    const g = this.g, W = this.W, H = this.H, L = this.L;
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    if (!S.project?.source) return;
    if (this.player.playing && !this.drag) this.follow();

    g.fillStyle = C.lane; g.fillRect(GUTTER, L.wave.y, this.trackW, L.wave.h);
    g.fillStyle = C.laneAlt; g.fillRect(GUTTER, L.words.y, this.trackW, L.words.h);
    g.fillStyle = C.lane; g.fillRect(GUTTER, L.edits.y, this.trackW, L.edits.h);

    this.drawRuler();
    this.drawSelection();
    this.drawWave();
    this.drawWords();
    this.drawEdits();
    this.drawGutter();
    this.drawScrollbar();
    this.drawPlayhead();
  }

  follow() {
    const x = this.x(this.player.time);
    if (x > this.W - 30 || x < GUTTER) {
      this.scroll = this.player.time - (this.trackW / this.pps) * 0.1;
      this.clampScroll();
    }
  }

  visible() { return [this.scroll, this.scroll + this.trackW / this.pps]; }

  drawRuler() {
    const g = this.g, L = this.L.ruler;
    const step = STEPS.find(s => s * this.pps >= 80) || 1200;
    const minor = step / 5;
    const [t0, t1] = this.visible();
    g.strokeStyle = C.grid; g.fillStyle = C.text;
    g.font = "11px ui-monospace, monospace";
    g.textBaseline = "middle";
    g.beginPath();
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(this.x(t)) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      g.moveTo(x, L.h - (major ? 10 : 5)); g.lineTo(x, L.h);
      if (major) {
        g.fillText(fmtTime(Math.round(t / step) * step, step < 1).replace(/\.00$/, ""), x + 4, 9);
        g.moveTo(x, L.h); g.lineTo(x, this.L.bar.y);
      }
    }
    g.stroke();
    g.strokeStyle = C.grid;
    g.beginPath(); g.moveTo(GUTTER, L.h + 0.5); g.lineTo(this.W, L.h + 0.5); g.stroke();
  }

  drawSelection() {
    const sel = selection();
    if (!sel) return;
    const g = this.g, x0 = this.x(sel.start), x1 = this.x(sel.end);
    const y0 = this.L.wave.y, y1 = this.L.edits.y;
    g.fillStyle = C.sel;
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    g.strokeStyle = C.selEdge; g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.round(x0) + 0.5, y0); g.lineTo(Math.round(x0) + 0.5, y1);
    g.moveTo(Math.round(x1) + 0.5, y0); g.lineTo(Math.round(x1) + 0.5, y1);
    g.stroke();
  }

  mutedAt(t) {
    if (!this.player.abEnabled) return false;
    for (const e of edits()) if (!e.muted && e.active_take && t >= e.cut_start && t < editEnd(e)) return true;
    return false;
  }

  drawWave() {
    const peaks = S.peaks;
    if (!peaks) return;
    const g = this.g, L = this.L.wave, mid = L.y + L.h / 2, amp = L.h / 2 - 4;
    const pps = S.project.source.peaks_per_sec || 200;
    const startX = Math.max(GUTTER, Math.floor(this.x(0)));
    const endX = Math.min(this.W, Math.ceil(this.x(this.duration)));
    const cols = [[], []];
    for (let x = startX; x < endX; x++) {
      const ta = this.t(x), tb = this.t(x + 1);
      let i0 = Math.floor(ta * pps), i1 = Math.max(i0 + 1, Math.ceil(tb * pps));
      i0 = Math.max(0, i0); i1 = Math.min(peaks.length, i1);
      let m = 0;
      for (let i = i0; i < i1; i++) if (peaks[i] > m) m = peaks[i];
      const v = Math.pow(m / 255, 0.75) * amp;
      cols[this.mutedAt((ta + tb) / 2) ? 1 : 0].push(x, v);
    }
    const paint = (arr, color) => {
      g.fillStyle = color;
      for (let k = 0; k < arr.length; k += 2) g.fillRect(arr[k], mid - arr[k + 1], 1, Math.max(1, arr[k + 1] * 2));
    };
    paint(cols[0], C.wave);
    paint(cols[1], C.waveMuted);
    g.fillStyle = "rgba(255,255,255,.04)";
    g.fillRect(GUTTER, mid, this.trackW, 1);
  }

  drawWords() {
    const g = this.g, L = this.L.words, w = words();
    const [t0, t1] = this.visible();
    const sel = S.sel ? [Math.min(S.sel.a, S.sel.b), Math.max(S.sel.a, S.sel.b)] : null;
    const edited = e => edits().some(ed => (e.start + e.end) / 2 >= ed.cut_start && (e.start + e.end) / 2 <= ed.cut_end);
    g.font = "12px Inter, system-ui, sans-serif";
    g.textBaseline = "middle";
    for (let i = 0; i < w.length; i++) {
      const wd = w[i];
      if (wd.end < t0) continue;
      if (wd.start > t1) break;
      const x0 = this.x(wd.start), x1 = this.x(wd.end), bw = Math.max(1, x1 - x0 - 1);
      const isSel = sel && i >= sel[0] && i <= sel[1];
      const isEd = edited(wd);
      g.fillStyle = isSel ? C.wordHi : isEd ? C.wordEdited : C.word;
      roundRect(g, x0 + 0.5, L.y + 5, bw, L.h - 10, 4);
      g.fill();
      if (bw > 16) {
        g.save();
        g.beginPath(); g.rect(x0 + 3, L.y, bw - 5, L.h); g.clip();
        g.fillStyle = isSel ? "#fff" : isEd ? C.muted : C.textHi;
        g.fillText(wd.text, x0 + 5, L.y + L.h / 2 + 0.5);
        if (isEd) { g.fillRect(x0 + 5, L.y + L.h / 2, Math.min(bw - 8, g.measureText(wd.text).width), 1); }
        g.restore();
      }
    }
  }

  drawEdits() {
    const g = this.g, L = this.L.edits;
    const [t0, t1] = this.visible();
    const now = performance.now();
    for (const e of edits()) {
      const end = editEnd(e);
      if (end < t0 || e.cut_start > t1) continue;
      const x0 = this.x(e.cut_start), x1 = this.x(end), xr = this.x(e.cut_end);
      const busy = S.busyEdits.has(e.id);
      const color = e.locked ? C.locked : C.draft;
      const soft = e.locked ? C.lockedSoft : C.draftSoft;
      const y = L.y + 6, hgt = L.h - 12, w = Math.max(3, x1 - x0);
      g.globalAlpha = e.muted ? 0.4 : 1;
      g.fillStyle = soft;
      roundRect(g, x0, y, w, hgt, 6); g.fill();
      if (busy) {
        g.save(); roundRect(g, x0, y, w, hgt, 6); g.clip();
        g.strokeStyle = "rgba(245,165,36,.35)"; g.lineWidth = 6;
        const off = (now / 30) % 16;
        g.beginPath();
        for (let sx = x0 - hgt - 16 + off; sx < x0 + w; sx += 16) { g.moveTo(sx, y + hgt); g.lineTo(sx + hgt, y); }
        g.stroke(); g.restore();
        this.dirty = true;
      }
      // take waveform
      const take = activeTake(e);
      const peaks = take && this.takePeaksFor(e, take);
      if (peaks) {
        g.fillStyle = color;
        g.globalAlpha = e.muted ? 0.25 : 0.75;
        const mid = y + hgt / 2 + 6, amp = hgt / 2 - 10;
        const dur = take.duration;
        for (let x = Math.max(x0, GUTTER); x < Math.min(x0 + dur * this.pps, this.W); x++) {
          const k = Math.floor(((x - x0) / (dur * this.pps)) * peaks.length);
          const v = (peaks[k] || 0) * amp;
          g.fillRect(x, mid - v, 1, Math.max(1, v * 2));
        }
        g.globalAlpha = e.muted ? 0.4 : 1;
      }
      // overrun past the original region (natural-length takes)
      if (x1 > xr + 1) {
        g.fillStyle = "rgba(255,92,122,.25)";
        g.fillRect(xr, y, x1 - xr, 3);
      }
      g.strokeStyle = color; g.lineWidth = S.editId === e.id ? 2 : 1;
      roundRect(g, x0 + 0.5, y + 0.5, w - 1, hgt - 1, 6); g.stroke();
      if (S.editId === e.id) {
        g.strokeStyle = "#fff"; g.lineWidth = 1;
        roundRect(g, x0 - 1.5, y - 2, w + 3, hgt + 4, 8); g.stroke();
      }
      if (w > 24) {
        g.save(); g.beginPath(); g.rect(x0 + 4, y, w - 8, hgt); g.clip();
        g.fillStyle = C.textHi; g.font = "600 12px Inter, system-ui, sans-serif"; g.textBaseline = "top";
        const label = (e.locked ? "🔒 " : "") + e.text;
        g.fillText(label, x0 + 7, y + 5);
        g.font = "10px ui-monospace, monospace"; g.fillStyle = C.text;
        const n = e.takes.length;
        g.fillText(busy ? "generating…" : `${n} take${n === 1 ? "" : "s"}`, x0 + 7, y + hgt - 14);
        g.restore();
      }
      g.globalAlpha = 1;
    }
  }

  takePeaksFor(e, take) {
    const key = `${e.id}:${take.id}`;
    if (this.takePeaks.has(key)) return this.takePeaks.get(key);
    const buf = this.player.cached(e.id, take.id);
    if (!buf) return null;
    const data = buf.getChannelData(0), n = 400, hop = Math.max(1, Math.floor(data.length / n));
    const out = new Float32Array(n);
    let max = 1e-6;
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = i * hop; j < Math.min(data.length, (i + 1) * hop); j++) { const a = Math.abs(data[j]); if (a > m) m = a; }
      out[i] = m; if (m > max) max = m;
    }
    for (let i = 0; i < n; i++) out[i] = Math.pow(out[i] / max, 0.8);
    this.takePeaks.set(key, out);
    return out;
  }

  drawGutter() {
    const g = this.g, L = this.L;
    g.fillStyle = "#0c0f16";
    g.fillRect(0, 0, GUTTER, this.H);
    g.strokeStyle = C.grid;
    g.beginPath(); g.moveTo(GUTTER - 0.5, 0); g.lineTo(GUTTER - 0.5, this.H); g.stroke();
    g.font = "600 11px Inter, system-ui, sans-serif"; g.textBaseline = "middle";
    const label = (lane, title, sub, color) => {
      g.fillStyle = color; g.fillRect(10, lane.y + lane.h / 2 - 7, 3, 14);
      g.fillStyle = C.textHi; g.fillText(title, 20, lane.y + lane.h / 2 - (sub ? 6 : 0));
      if (sub) { g.fillStyle = C.text; g.font = "10px Inter, system-ui, sans-serif"; g.fillText(sub, 20, lane.y + lane.h / 2 + 8); g.font = "600 11px Inter, system-ui, sans-serif"; }
    };
    label(L.wave, "A1 Original", S.project?.source?.has_video ? "video audio" : "audio", C.wave);
    label(L.words, "Words", `${words().length}`, "#7c5cff");
    label(L.edits, "A2 Voice edits", `${edits().length} edits`, C.draft);
    g.strokeStyle = C.grid;
    g.beginPath();
    for (const k of ["words", "edits"]) { g.moveTo(0, L[k].y + 0.5); g.lineTo(this.W, L[k].y + 0.5); }
    g.stroke();
  }

  drawScrollbar() {
    const g = this.g, L = this.L.bar;
    g.fillStyle = "#0c0f16"; g.fillRect(GUTTER, L.y, this.trackW, L.h);
    const { x0, w } = this.thumb();
    g.fillStyle = this.drag?.kind === "bar" ? "#4a5470" : "#323a4d";
    roundRect(g, x0, L.y + 3, w, L.h - 6, 3); g.fill();
    // edits as ticks on the overview bar
    for (const e of edits()) {
      g.fillStyle = e.locked ? C.locked : C.draft;
      g.fillRect(GUTTER + (e.cut_start / Math.max(this.duration, 1e-6)) * this.trackW, L.y + 1, 2, L.h - 2);
    }
  }

  drawPlayhead() {
    const g = this.g, x = Math.round(this.x(this.player.time)) + 0.5;
    if (x < GUTTER || x > this.W) return;
    g.strokeStyle = C.playhead; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, this.L.bar.y); g.stroke();
    g.fillStyle = C.playhead;
    g.beginPath(); g.moveTo(x - 6, 0); g.lineTo(x + 6, 0); g.lineTo(x, 8); g.closePath(); g.fill();
    g.lineWidth = 1;
  }
}

function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
