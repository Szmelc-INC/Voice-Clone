// Media playback with live take overlay: while the playhead is inside an edit,
// the original is ducked and the fitted take plays through WebAudio. This is an
// approximation for scrubbing; the inspector's "Preview in context" button plays
// a server-mixed snippet made by the same mixer as the final render.

import { S, editAt, activeTake, emit } from "./state.js";

export class Player {
  constructor(media) {
    this.media = media;
    this.ctx = null;
    this.buffers = new Map();   // "eid:tid" -> AudioBuffer
    this.loading = new Map();
    this.overlay = null;        // {key, src, gain}
    this.volume = 1;
    this.abEnabled = true;
    this.stopAt = null;
    this.solo = null;           // standalone AudioBufferSource/HTMLAudio for previews
    media.addEventListener("seeking", () => this.stopOverlay());
    media.addEventListener("pause", () => { this.stopOverlay(); emit("playstate", false); });
    media.addEventListener("play", () => { this.stopSolo(); emit("playstate", true); });
    media.addEventListener("ended", () => emit("playstate", false));
    const loop = () => { this.tick(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  audioCtx() {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  load(project) {
    this.stopOverlay();
    this.stopSolo();
    this.buffers.clear();
    this.media.src = `/api/projects/${project.id}/media`;
    this.media.load();
  }

  get time() { return this.media.currentTime || 0; }
  get playing() { return !this.media.paused && !this.media.ended; }
  get duration() { return S.project?.source?.duration || this.media.duration || 0; }

  seek(t) {
    this.stopAt = null;
    this.media.currentTime = Math.max(0, Math.min(this.duration, t));
    emit("time", this.media.currentTime);
  }

  toggle() {
    this.audioCtx();
    if (this.playing) this.media.pause();
    else { this.stopAt = null; this.media.play(); }
  }

  playRange(start, end) {
    this.audioCtx();
    this.media.currentTime = start;
    this.stopAt = end;
    this.media.play();
  }

  takeUrl(eid, tid) { return `/api/projects/${S.project.id}/edits/${eid}/takes/${tid}.wav`; }

  async buffer(eid, tid) {
    const key = `${eid}:${tid}`;
    if (this.buffers.has(key)) return this.buffers.get(key);
    if (!this.loading.has(key)) {
      this.loading.set(key, (async () => {
        const res = await fetch(this.takeUrl(eid, tid));
        const buf = await this.audioCtx().decodeAudioData(await res.arrayBuffer());
        this.buffers.set(key, buf);
        this.loading.delete(key);
        emit("buffers");
        return buf;
      })().catch(err => { this.loading.delete(key); throw err; }));
    }
    return this.loading.get(key);
  }

  cached(eid, tid) { return this.buffers.get(`${eid}:${tid}`) || null; }

  preloadTakes() {
    for (const e of S.project?.edits || []) {
      if (e.active_take) this.buffer(e.id, e.active_take).catch(() => {});
    }
  }

  tick() {
    if (!S.project) return;
    const t = this.time;
    if (this.stopAt != null && t >= this.stopAt && this.playing) {
      this.media.pause();
      this.stopAt = null;
    }
    if (this.playing) emit("time", t);
    let target = null;
    if (this.playing && this.abEnabled) {
      const e = editAt(t);
      if (e && !e.muted && activeTake(e)) target = e;
    }
    const key = target ? `${target.id}:${target.active_take}` : null;
    if (this.overlay && this.overlay.key !== key) this.stopOverlay();
    if (target && !this.overlay) {
      const buf = this.cached(target.id, target.active_take);
      if (buf) this.startOverlay(target, buf, t, key);
      else this.buffer(target.id, target.active_take).catch(() => {});
    }
    const duck = this.overlay ? this.overlay.bleed : 1;
    this.media.volume = Math.max(0, Math.min(1, this.volume * duck));
  }

  startOverlay(e, buf, t, key) {
    const ctx = this.audioCtx();
    const offset = t - e.cut_start;
    if (offset >= buf.duration) { this.overlay = { key, src: null, bleed: e.bleed || 0 }; return; }
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = this.volume * Math.pow(10, (e.gain_db || 0) / 20);
    src.buffer = buf;
    src.connect(gain).connect(ctx.destination);
    src.start(0, Math.max(0, offset));
    this.overlay = { key, src, gain, bleed: e.bleed || 0 };
  }

  stopOverlay() {
    if (this.overlay?.src) { try { this.overlay.src.stop(); } catch { /* already stopped */ } }
    this.overlay = null;
    this.media.volume = this.volume;
  }

  setVolume(v) {
    this.volume = v;
    if (this.overlay?.gain) this.overlay.gain.gain.value = v;
  }

  // Play a standalone clip (take alone or a server-mixed preview).
  async playUrl(url) {
    this.media.pause();
    this.stopSolo();
    const ctx = this.audioCtx();
    const res = await fetch(url);
    if (!res.ok) throw new Error("Preview failed");
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = this.volume;
    src.buffer = buf;
    src.connect(gain).connect(ctx.destination);
    src.onended = () => { if (this.solo === src) { this.solo = null; emit("solo", false); } };
    src.start();
    this.solo = src;
    emit("solo", true);
  }

  stopSolo() {
    if (this.solo) { try { this.solo.stop(); } catch { /* ignore */ } this.solo = null; emit("solo", false); }
  }
}
