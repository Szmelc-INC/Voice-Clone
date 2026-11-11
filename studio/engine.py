"""Model engine and job queue.

All model work (Whisper, OmniVoice) runs on one GPU worker thread so jobs never
fight over VRAM; ffmpeg imports and renders run on a separate CPU worker.
"""

import logging
import queue
import random
import re
import shutil
import threading
import time
import traceback
from pathlib import Path
from typing import Callable, Optional

import numpy as np
import soundfile as sf

from . import config, media, store

log = logging.getLogger("studio.engine")


# --------------------------------------------------------------------------- jobs

class Jobs:
    def __init__(self) -> None:
        self.jobs: dict[str, dict] = {}
        self.queues = {"gpu": queue.Queue(), "cpu": queue.Queue()}
        self.lock = threading.Lock()
        for lane, q in self.queues.items():
            threading.Thread(target=self._worker, args=(q,), daemon=True,
                             name=f"studio-{lane}").start()

    def submit(self, lane: str, kind: str, label: str, fn: Callable[[dict], object],
               project: Optional[str] = None, meta: Optional[dict] = None) -> dict:
        job = {
            "id": store.new_id("j"), "kind": kind, "label": label, "lane": lane,
            "project": project, "meta": meta or {}, "status": "queued",
            "progress": "", "result": None, "error": None,
            "created": store.now(), "started": None, "finished": None,
        }
        with self.lock:
            self.jobs[job["id"]] = job
            # Keep memory bounded: drop the oldest finished jobs.
            done = [j for j in self.jobs.values() if j["status"] in ("done", "error")]
            for old in sorted(done, key=lambda j: j["created"])[:-200]:
                self.jobs.pop(old["id"], None)
        self.queues[lane].put((job, fn))
        return job

    def _worker(self, q: queue.Queue) -> None:
        while True:
            job, fn = q.get()
            job["status"], job["started"] = "running", store.now()
            try:
                job["result"] = fn(job)
                job["status"] = "done"
            except Exception as exc:  # surfaced to the UI
                log.error("job %s failed\n%s", job["kind"], traceback.format_exc())
                job["status"], job["error"] = "error", str(exc) or type(exc).__name__
            job["finished"] = store.now()

    def get(self, jid: str) -> dict:
        return self.jobs[jid]

    def recent(self) -> list[dict]:
        cutoff = time.time() - 600
        return sorted((j for j in self.jobs.values()
                       if j["status"] in ("queued", "running") or (j["finished"] or 0) > cutoff),
                      key=lambda j: j["created"])


jobs = Jobs()


# ------------------------------------------------------------------------- models

class Models:
    def __init__(self) -> None:
        self.tts = None
        self.asr = None
        self.state = {"tts": "unloaded", "asr": "unloaded"}
        self.errors: dict[str, str] = {}
        self.lock = threading.Lock()

    def _device(self) -> str:
        import torch
        return config.DEVICE if torch.cuda.is_available() else "cpu"

    def get_asr(self):
        with self.lock:
            if self.asr is None:
                import torch
                from transformers import pipeline
                self.state["asr"] = "loading"
                try:
                    dev = self._device()
                    self.asr = pipeline(
                        "automatic-speech-recognition", model=config.ASR_MODEL_ID,
                        dtype=torch.float16 if dev != "cpu" else torch.float32, device=dev)
                except Exception as exc:
                    self.state["asr"], self.errors["asr"] = "error", str(exc)
                    raise
                self.state["asr"] = "ready"
                if self.tts is not None:
                    self.tts._asr_pipe = self.asr
            return self.asr

    def get_tts(self):
        with self.lock:
            if self.tts is None:
                import torch
                from omnivoice import OmniVoice
                self.state["tts"] = "loading"
                try:
                    dev = self._device()
                    self.tts = OmniVoice.from_pretrained(
                        config.MODEL_ID, device_map=dev,
                        dtype=torch.float16 if dev != "cpu" else torch.float32)
                except Exception as exc:
                    self.state["tts"], self.errors["tts"] = "error", str(exc)
                    raise
                self.state["tts"] = "ready"
                # Share one Whisper instance with OmniVoice's auto ref-text.
                if self.asr is not None:
                    self.tts._asr_pipe = self.asr
            return self.tts

    def status(self) -> dict:
        info = {"state": dict(self.state), "errors": dict(self.errors), "device": None}
        try:
            import torch
            if torch.cuda.is_available():
                info["device"] = torch.cuda.get_device_name(0)
                free, total = torch.cuda.mem_get_info()
                info["vram"] = {"used": total - free, "total": total}
            else:
                info["device"] = "cpu"
        except Exception:
            pass
        return info


models = Models()


def preload() -> None:
    def work(job):
        job["progress"] = "Loading Whisper"
        models.get_asr()
        job["progress"] = "Loading OmniVoice"
        models.get_tts()
    jobs.submit("gpu", "preload", "Loading models", work)


# ------------------------------------------------------------------ voice prompts

def save_prompt(prompt, path: Path) -> None:
    import torch
    torch.save({"format_version": 1, "ref_audio_tokens": prompt.ref_audio_tokens.detach().cpu(),
                "ref_text": prompt.ref_text, "ref_rms": float(prompt.ref_rms)}, str(path))


def load_prompt(path: Path):
    import torch
    from omnivoice import VoiceClonePrompt
    data = torch.load(str(path), map_location="cpu", weights_only=True)
    return VoiceClonePrompt(ref_audio_tokens=data["ref_audio_tokens"],
                            ref_text=data["ref_text"], ref_rms=data["ref_rms"])


_voice_meta_cache: dict[str, tuple[float, dict]] = {}


def voice_name_ok(name: str) -> bool:
    return bool(re.fullmatch(r"[\w.\- ]{1,80}", name)) and not name.startswith(".")


def list_voices() -> list[dict]:
    import torch
    out = []
    for pt in sorted(config.VOICES_DIR.glob("*.pt")):
        st = pt.stat()
        cached = _voice_meta_cache.get(str(pt))
        if cached and cached[0] == st.st_mtime:
            meta = cached[1]
        else:
            try:
                data = torch.load(str(pt), map_location="cpu", weights_only=True)
                tokens = data.get("ref_audio_tokens")
                meta = {"ref_text": data.get("ref_text", ""),
                        "seconds": round(tokens.shape[-1] / 25, 1) if tokens is not None else None}
            except Exception as exc:
                meta = {"ref_text": "", "error": str(exc)[:200]}
            _voice_meta_cache[str(pt)] = (st.st_mtime, meta)
        out.append({"name": pt.stem, "size": st.st_size, "modified": st.st_mtime,
                    "has_audio": pt.with_suffix(".wav").is_file(), **meta})
    return out


def _make_voice(wav24: np.ndarray, ref_text: Optional[str], name: str) -> dict:
    import torch
    model = models.get_tts()
    if not ref_text:
        models.get_asr()  # create_voice_clone_prompt transcribes through the shared pipe
        model._asr_pipe = models.asr
    prompt = model.create_voice_clone_prompt(
        ref_audio=(torch.from_numpy(wav24).unsqueeze(0), config.TTS_SR),
        ref_text=ref_text or None)
    config.VOICES_DIR.mkdir(parents=True, exist_ok=True)
    save_prompt(prompt, config.VOICES_DIR / f"{name}.pt")
    sf.write(str(config.VOICES_DIR / f"{name}.wav"), wav24[: config.TTS_SR * 30], config.TTS_SR)
    return {"name": name, "ref_text": prompt.ref_text}


def clone_voice_from_file(path: Path, name: str, ref_text: Optional[str]) -> dict:
    def work(job):
        job["progress"] = "Decoding audio"
        import librosa
        wav, _ = librosa.load(str(path), sr=config.TTS_SR, mono=True)
        path.unlink(missing_ok=True)
        if len(wav) > config.TTS_SR * 20:
            wav = wav[: config.TTS_SR * 20]
        job["progress"] = "Building voice prompt"
        return _make_voice(wav, ref_text, name)
    return jobs.submit("gpu", "clone", f"Clone voice “{name}”", work)


def clone_voice_from_range(pid: str, start: float, end: float, name: str) -> dict:
    def work(job):
        project = store.load(pid)
        master = store.project_dir(pid) / "master.wav"
        all_words = sorted(project["words"], key=lambda w: w["start"])
        words = [w for w in all_words if start - 0.02 <= (w["start"] + w["end"]) / 2 <= end + 0.02]
        text = " ".join(w["text"] for w in words).strip()
        s, e = (padded_span(all_words, words[0], words[-1], 0.0, project["source"]["duration"])
                if words else (start, end))
        wav = media.read_mono(master, s, e, config.TTS_SR)
        job["progress"] = "Building voice prompt"
        return _make_voice(wav, text or None, name)
    return jobs.submit("gpu", "clone", f"Clone voice “{name}”", work, project=pid)


def quick_tts(voice: Optional[str], text: str, language: Optional[str], num_step: int,
              speed: Optional[float], instruct: Optional[str], name: str) -> dict:
    def work(job):
        import torch
        model = models.get_tts()
        kwargs = {}
        if voice:
            kwargs["voice_clone_prompt"] = load_prompt(config.VOICES_DIR / f"{voice}.pt")
        elif instruct:
            kwargs["instruct"] = instruct
        seed = random.randrange(2 ** 31)
        torch.manual_seed(seed)
        job["progress"] = "Synthesizing"
        audio = model.generate(text=text, language=_lang(language), num_step=num_step,
                               speed=speed, **kwargs)[0]
        config.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        dst = _unique(config.OUTPUT_DIR / f"{name}.wav")
        sf.write(str(dst), audio, config.TTS_SR)
        return {"file": dst.name, "seconds": round(len(audio) / config.TTS_SR, 2), "seed": seed}
    return jobs.submit("gpu", "tts", f"TTS → {name}.wav", work)


def _lang(language: Optional[str]) -> Optional[str]:
    return None if not language or language == "auto" else language


def _unique(path: Path) -> Path:
    if not path.exists():
        return path
    for i in range(2, 10000):
        cand = path.with_name(f"{path.stem}-{i}{path.suffix}")
        if not cand.exists():
            return cand
    raise RuntimeError("Too many files with the same name")


# ---------------------------------------------------------------------- projects

def import_media(pid: str, src: Path) -> dict:
    def work(job):
        d = store.project_dir(pid)
        try:
            job["progress"] = "Probing"
            info = media.probe(src)
            sr = min(info["sample_rate"], config.MASTER_MAX_SR)
            channels = min(info["channels"], 2)
            job["progress"] = "Extracting audio"
            media.extract_master(src, d / "master.wav", sr, channels)
            job["progress"] = "Computing waveform"
            (d / "peaks.bin").write_bytes(media.compute_peaks(d / "master.wav"))
            frames = sf.info(str(d / "master.wav")).frames
            source = {**info, "file": src.name, "duration": frames / sr, "master_sr": sr,
                      "master_channels": channels, "proxy": None,
                      "peaks_per_sec": media.PEAKS_PER_SEC}
            if media.needs_proxy(src, info):
                job["progress"] = "Making a browser-playable proxy"
                proxy = d / ("proxy.mp4" if info["has_video"] else "proxy.m4a")
                media.make_proxy(src, proxy, info["has_video"])
                source["proxy"] = proxy.name
            with store.edit(pid) as project:
                project["source"], project["status"] = source, "ready"
        except Exception:
            with store.edit(pid) as project:
                project["status"] = "error"
            raise
        return {"project": pid}
    return jobs.submit("cpu", "import", f"Import {src.name}", work, project=pid)


def _clean_words(chunks: list[dict], offset: float, limit: float) -> list[dict]:
    words, prev_end = [], offset
    for c in chunks:
        text = c.get("text", "").strip()
        s, e = c.get("timestamp") or (None, None)
        if not text or s is None:
            continue
        s = max(prev_end, offset + float(s))
        e = offset + float(e) if e is not None else s + 0.3
        e = min(max(e, s + 0.06), limit)
        if s >= limit:
            break
        words.append({"id": store.new_id("w"), "text": text,
                      "start": round(s, 3), "end": round(e, 3)})
        prev_end = e
    return words


def transcribe(pid: str, start: Optional[float], end: Optional[float], language: str) -> dict:
    def work(job):
        project = store.load(pid)
        master = store.project_dir(pid) / "master.wav"
        dur = project["source"]["duration"]
        a = max(0.0, start or 0.0)
        b = min(dur, end if end is not None else dur)
        job["progress"] = "Loading Whisper" if models.asr is None else "Preparing audio"
        asr = models.get_asr()
        # Whisper guesses badly on clips cut mid-sentence, so give a range some
        # context on both sides and keep only the words whose middle is inside.
        pad = 0.0 if (a == 0 and b == dur) else 1.5
        pa, pb = max(0.0, a - pad), min(dur, b + pad)
        audio = media.read_mono(master, pa, pb, config.ASR_SR)
        job["progress"] = f"Transcribing {b - a:.1f}s"
        gen = {"task": "transcribe"}
        if language and language != "auto":
            gen["language"] = language
        result = asr({"array": audio, "sampling_rate": config.ASR_SR},
                     return_timestamps="word", chunk_length_s=30, batch_size=8,
                     generate_kwargs=gen)
        new_words = [w for w in _clean_words(result.get("chunks", []), pa, pb)
                     if a <= (w["start"] + w["end"]) / 2 <= b]
        with store.edit(pid) as p:
            keep = [w for w in p["words"] if not (a <= (w["start"] + w["end"]) / 2 <= b)]
            p["words"] = sorted(keep + new_words, key=lambda w: w["start"])
            if language and language != "auto":
                p["language"] = language
        return {"words": len(new_words), "range": [a, b]}
    label = "Transcribe all" if start is None and end is None else f"Transcribe {start:.1f}–{end:.1f}s"
    return jobs.submit("gpu", "transcribe", label, work, project=pid)


def padded_span(words: list[dict], first: dict, last: dict, lo: float, hi: float) -> tuple[float, float]:
    """Audio span for words first..last, padded so no word is clipped.

    Whisper word ends are often early; a reference whose last word is cut off
    makes OmniVoice finish that word at the start of the new speech. Pad into
    the silence around the words, without reaching a neighbouring word.
    """
    prev_end = max((w["end"] for w in words if w["end"] <= first["start"] + 1e-3 and w is not first), default=lo)
    next_start = min((w["start"] for w in words if w["start"] >= last["end"] - 1e-3 and w is not last), default=hi)
    s = max(lo, prev_end, first["start"] - 0.12)
    e = min(hi, next_start, last["end"] + 0.35)
    return s, max(e, last["end"])


def context_reference(project: dict, cut_start: float, cut_end: float,
                      master: Path) -> tuple[np.ndarray, str]:
    """Reference audio/text for cloning: words around the edit, never the edited ones."""
    words = sorted(project["words"], key=lambda w: w["start"])
    before = [w for w in words if w["end"] <= cut_start + 0.02]
    after = [w for w in words if w["start"] >= cut_end - 0.02]
    pick_b: list[dict] = []
    for w in reversed(before):
        if pick_b and pick_b[0]["start"] - w["end"] > 1.5 and pick_b[-1]["end"] - pick_b[0]["start"] > 3:
            break  # long pause: likely a different speaker or scene
        if pick_b and pick_b[-1]["end"] - w["start"] > 9:
            break
        pick_b.insert(0, w)
    span_b = (pick_b[-1]["end"] - pick_b[0]["start"]) if pick_b else 0
    pick_a: list[dict] = []
    if span_b < 3:
        for w in after:
            if pick_a and w["end"] - pick_a[0]["start"] > 9 - span_b:
                break
            pick_a.append(w)
    parts, texts = [], []
    gap = np.zeros(int(config.TTS_SR * 0.2), np.float32)
    duration = project["source"]["duration"]
    for group, lo, hi in ((pick_b, 0.0, cut_start), (pick_a, cut_end, duration)):
        if not group:
            continue
        s, e = padded_span(words, group[0], group[-1], lo, hi)
        parts += [media.read_mono(master, s, e, config.TTS_SR), gap]
        texts.append(" ".join(w["text"] for w in group))
    if not parts:
        raise ValueError("No transcript around this edit to clone from. "
                         "Transcribe the media first or pick a library voice.")
    return np.concatenate(parts[:-1]), " ".join(texts)


def generate_take(pid: str, eid: str) -> dict:
    def work(job):
        import torch
        project = store.load(pid)
        e = store.find_edit(project, eid)
        d = store.project_dir(pid)
        master = d / "master.wav"
        msr = project["source"]["master_sr"]
        job["progress"] = "Loading OmniVoice" if models.tts is None else "Cloning voice"
        model = models.get_tts()
        voice = e.get("voice") or {"mode": "context"}
        if voice.get("mode") == "library" and voice.get("name"):
            prompt = load_prompt(config.VOICES_DIR / f"{voice['name']}.pt")
            voice_label = voice["name"]
        else:
            ref, ref_text = context_reference(project, e["cut_start"], e["cut_end"], master)
            prompt = model.create_voice_clone_prompt(
                ref_audio=(torch.from_numpy(ref).unsqueeze(0), config.TTS_SR), ref_text=ref_text)
            voice_label = "context"
        region = e["cut_end"] - e["cut_start"]
        fit = e.get("fit", "fit") == "fit"
        seed = random.randrange(2 ** 31)
        torch.manual_seed(seed)
        job["progress"] = "Generating"
        raw = model.generate(
            text=e["text"], language=_lang(project.get("language")),
            voice_clone_prompt=prompt,
            duration=region if fit else None,
            speed=None if fit else (e.get("speed") or None),
            num_step=int(e.get("num_step", 32)),
            postprocess_output=False, pad_duration=0.0, fade_duration=0.0)[0]
        job["progress"] = "Fitting take"
        reference = media.read_mono(master, e["cut_start"], e["cut_end"], msr)
        placed = media.prepare_take(raw, config.TTS_SR, msr, region if fit else None, reference)
        tid = store.new_id("t")
        raw_path, placed_path = store.take_paths(pid, eid, tid)
        sf.write(str(raw_path), raw, config.TTS_SR)
        sf.write(str(placed_path), placed, msr, subtype="FLOAT")
        take = {"id": tid, "created": store.now(), "text": e["text"], "seed": seed,
                "voice": voice_label, "fit": e.get("fit", "fit"),
                "duration": round(len(placed) / msr, 3),
                "raw_duration": round(len(raw) / config.TTS_SR, 3),
                "heard": _heard(raw, project.get("language"))}
        with store.edit(pid) as p:
            pe = store.find_edit(p, eid)
            pe["takes"].append(take)
            if not pe.get("locked"):
                pe["active_take"] = tid
        return take
    return jobs.submit("gpu", "generate", "Generate take", work, project=pid, meta={"edit": eid})


def _heard(raw: np.ndarray, language: Optional[str]) -> Optional[str]:
    """What Whisper hears in a take, so the UI can flag garbled generations.

    Only runs when Whisper is already loaded (it usually is after transcribing).
    """
    if models.asr is None:
        return None
    try:
        gen = {"task": "transcribe"}
        if language and language != "auto":
            gen["language"] = language
        audio = media.resample(raw, config.TTS_SR, config.ASR_SR)
        return models.asr({"array": audio, "sampling_rate": config.ASR_SR},
                          generate_kwargs=gen)["text"].strip()
    except Exception:
        log.warning("take check failed", exc_info=True)
        return None


def placements(pid: str, project: dict, include: str = "active",
               override: Optional[tuple[str, str]] = None) -> list[media.Placement]:
    """Edits to mix: include='locked' only locked edits, 'active' every edit's active take.

    `override=(edit_id, take_id)` forces a specific take for one edit (take preview).
    """
    out = []
    for e in project["edits"]:
        tid = e.get("active_take")
        if override and e["id"] == override[0]:
            tid = override[1]
        elif include == "locked" and not e.get("locked"):
            continue
        if not tid or e.get("muted"):
            continue
        _, path = store.take_paths(pid, e["id"], tid)
        if not path.is_file():
            continue
        audio, _ = sf.read(str(path), dtype="float32")
        out.append(media.Placement(
            start=e["cut_start"], mute_end=e["cut_end"], audio=audio,
            gain=10 ** (float(e.get("gain_db", 0)) / 20), bleed=float(e.get("bleed", 0))))
    return out


def _safe_name(name: str) -> str:
    return re.sub(r"[^\w.\-]+", "_", name).strip("_") or "render"


def render(pid: str, include: str) -> dict:
    def work(job):
        project = store.load(pid)
        d = store.project_dir(pid)
        src = project["source"]
        job["progress"] = "Mixing audio"
        mixed, sr = media.mix_window(d / "master.wav", placements(pid, project, include))
        config.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        base = f"{_safe_name(project['name'])}-{stamp}"
        wav = config.OUTPUT_DIR / f"{base}.wav"
        sf.write(str(wav), mixed, sr, subtype="PCM_16")
        result = {"audio": wav.name, "video": None, "include": include,
                  "edits": len(placements(pid, project, include)), "created": store.now()}
        if src["has_video"]:
            job["progress"] = "Muxing video"
            ext = Path(src["file"]).suffix.lower()
            ext = ext if ext in (".mp4", ".mkv", ".mov", ".webm") else ".mp4"
            video = config.OUTPUT_DIR / f"{base}{ext}"
            try:
                media.mux_video(d / src["file"], wav, video)
            except RuntimeError:
                # Source codec does not fit the container: fall back to Matroska.
                video = video.with_suffix(".mkv")
                media.mux_video(d / src["file"], wav, video)
            result["video"] = video.name
        with store.edit(pid) as p:
            p.setdefault("renders", []).append(result)
        return result
    return jobs.submit("cpu", "render", "Render final", work, project=pid)


def copy_upload(fileobj, dst: Path) -> None:
    with open(dst, "wb") as f:
        shutil.copyfileobj(fileobj, f, length=1 << 20)
