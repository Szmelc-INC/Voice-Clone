"""FastAPI app: REST API for the studio plus the static single-page UI."""

import shutil
import tempfile
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__, config, engine, media, store

app = FastAPI(title="OmniVoice Voice Edit Studio", version=__version__)


def _project(pid: str) -> dict:
    try:
        return store.load(pid)
    except KeyError:
        raise HTTPException(404, "Project not found")


def _edit(project: dict, eid: str) -> dict:
    try:
        return store.find_edit(project, eid)
    except KeyError:
        raise HTTPException(404, "Edit not found")


def _voice_path(name: str, suffix: str = ".pt") -> Path:
    if not engine.voice_name_ok(name):
        raise HTTPException(400, "Invalid voice name")
    return config.VOICES_DIR / f"{name}{suffix}"


def _output_path(name: str) -> Path:
    path = (config.OUTPUT_DIR / name).resolve()
    if path.parent != config.OUTPUT_DIR or not path.is_file():
        raise HTTPException(404, "Output not found")
    return path


# ------------------------------------------------------------------------ status

@app.get("/api/status")
def status():
    return {"version": __version__, "models": engine.models.status(),
            "jobs": engine.jobs.recent(), "languages": config.LANGUAGES,
            "paths": {"voices": str(config.VOICES_DIR), "outputs": str(config.OUTPUT_DIR),
                      "data": str(config.DATA_DIR)}}


@app.post("/api/models/load")
def load_models():
    engine.preload()
    return {"ok": True}


@app.get("/api/jobs/{jid}")
def job(jid: str):
    try:
        return engine.jobs.get(jid)
    except KeyError:
        raise HTTPException(404, "Job not found")


# ---------------------------------------------------------------------- projects

@app.get("/api/projects")
def projects():
    return store.list_all()


@app.post("/api/projects")
def create_project(file: Optional[UploadFile] = File(None), path: str = Form(""),
                   name: str = Form("")):
    if file is None and not path:
        raise HTTPException(400, "Upload a file or give a local path")
    local = Path(path).expanduser() if path else None
    if local is not None and not local.is_file():
        raise HTTPException(400, f"No such file: {path}")
    filename = file.filename if file is not None else local.name
    suffix = Path(filename or "media").suffix.lower() or ".bin"
    project = store.create(name or Path(filename or "Untitled").stem)
    dst = store.project_dir(project["id"]) / f"source{suffix}"
    if file is not None:
        engine.copy_upload(file.file, dst)
    else:
        try:
            dst.hardlink_to(local)
        except OSError:
            shutil.copyfile(local, dst)
    job = engine.import_media(project["id"], dst)
    return {"project": project, "job": job}


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    return _project(pid)


class ProjectPatch(BaseModel):
    name: Optional[str] = None
    language: Optional[str] = None


@app.patch("/api/projects/{pid}")
def patch_project(pid: str, body: ProjectPatch):
    _project(pid)
    with store.edit(pid) as p:
        if body.name:
            p["name"] = body.name.strip()[:120]
        if body.language:
            p["language"] = body.language
    return p


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    _project(pid)
    store.delete(pid)
    return {"ok": True}


@app.get("/api/projects/{pid}/media")
def project_media(pid: str):
    p = _project(pid)
    if not p.get("source"):
        raise HTTPException(409, "Media is still importing")
    d = store.project_dir(pid)
    return FileResponse(d / (p["source"]["proxy"] or p["source"]["file"]))


@app.get("/api/projects/{pid}/peaks")
def project_peaks(pid: str):
    path = store.project_dir(pid) / "peaks.bin"
    if not path.is_file():
        raise HTTPException(409, "Waveform not ready")
    return FileResponse(path, media_type="application/octet-stream")


@app.get("/api/projects/{pid}/audio")
def project_audio(pid: str, start: float = 0.0, end: Optional[float] = None):
    p = _project(pid)
    end = min(end if end is not None else p["source"]["duration"], start + 600)
    samples, sr = media.mix_window(store.project_dir(pid) / "master.wav", [], start, end)
    return Response(media.wav_bytes(samples, sr), media_type="audio/wav")


class Word(BaseModel):
    id: str = ""
    text: str
    start: float
    end: float


class WordsBody(BaseModel):
    words: list[Word]


@app.put("/api/projects/{pid}/words")
def put_words(pid: str, body: WordsBody):
    _project(pid)
    words = []
    for w in sorted(body.words, key=lambda w: w.start):
        text = w.text.strip()
        if not text:
            continue
        start, end = round(max(0.0, w.start), 3), round(max(w.end, w.start + 0.02), 3)
        words.append({"id": w.id or store.new_id("w"), "text": text, "start": start, "end": end})
    with store.edit(pid) as p:
        p["words"] = words
    return {"words": words}


class TranscribeBody(BaseModel):
    start: Optional[float] = None
    end: Optional[float] = None
    language: str = "auto"


@app.post("/api/projects/{pid}/transcribe")
def transcribe(pid: str, body: TranscribeBody):
    p = _project(pid)
    if p.get("status") != "ready":
        raise HTTPException(409, "Media is still importing")
    if body.start is not None and body.end is not None and body.end - body.start < 0.2:
        raise HTTPException(400, "Range is too short")
    return engine.transcribe(pid, body.start, body.end, body.language)


@app.get("/api/projects/{pid}/transcript.srt", response_class=PlainTextResponse)
def export_srt(pid: str):
    p = _project(pid)
    return _srt(p["words"])


def _srt(words: list[dict]) -> str:
    def ts(t: float) -> str:
        ms = int(round(t * 1000))
        return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"
    lines, cues, cur = [], [], []
    for w in words:
        if cur and (w["start"] - cur[-1]["end"] > 0.7 or len(cur) >= 12
                    or cur[-1]["text"].endswith((".", "?", "!"))):
            cues.append(cur)
            cur = []
        cur.append(w)
    if cur:
        cues.append(cur)
    for i, c in enumerate(cues, 1):
        lines += [str(i), f"{ts(c[0]['start'])} --> {ts(c[-1]['end'])}",
                  " ".join(w["text"] for w in c), ""]
    return "\n".join(lines)


# ------------------------------------------------------------------------- edits

class Voice(BaseModel):
    mode: Literal["context", "library"] = "context"
    name: Optional[str] = None


class EditBody(BaseModel):
    start: float
    end: float
    text: str = Field(min_length=1, max_length=2000)
    voice: Voice = Voice()
    fit: Literal["fit", "natural"] = "fit"
    speed: Optional[float] = Field(None, ge=0.5, le=2.0)
    num_step: int = Field(32, ge=4, le=64)
    gain_db: float = Field(0.0, ge=-24, le=24)
    bleed: float = Field(0.0, ge=0, le=1)
    generate: bool = True


def _overlaps(project: dict, start: float, end: float, skip: str = "") -> Optional[dict]:
    for e in project["edits"]:
        if e["id"] != skip and e["cut_start"] < end - 0.01 and start < e["cut_end"] - 0.01:
            return e
    return None


@app.post("/api/projects/{pid}/edits")
def create_edit(pid: str, body: EditBody):
    p = _project(pid)
    if body.end - body.start < 0.05:
        raise HTTPException(400, "Selection is too short")
    if body.voice.mode == "library" and not _voice_path(body.voice.name or "").is_file():
        raise HTTPException(400, "Voice not found")
    master = store.project_dir(pid) / "master.wav"
    cut_start, cut_end = media.snap_cut(master, body.start), media.snap_cut(master, body.end)
    if cut_end - cut_start < 0.05:
        cut_start, cut_end = body.start, body.end
    original = " ".join(w["text"] for w in p["words"]
                        if body.start - 0.02 <= (w["start"] + w["end"]) / 2 <= body.end + 0.02)
    with store.edit(pid) as p:
        clash = _overlaps(p, cut_start, cut_end)
        if clash:
            raise HTTPException(409, f"Overlaps an existing edit (“{clash['text']}”)")
        edit = {
            "id": store.new_id("e"), "created": store.now(),
            "start": round(body.start, 3), "end": round(body.end, 3),
            "cut_start": cut_start, "cut_end": cut_end, "original_text": original,
            "text": body.text.strip(), "voice": body.voice.model_dump(), "fit": body.fit,
            "speed": body.speed, "num_step": body.num_step, "gain_db": body.gain_db,
            "bleed": body.bleed, "takes": [], "active_take": None, "locked": False,
            "muted": False,
        }
        p["edits"].append(edit)
        p["edits"].sort(key=lambda e: e["cut_start"])
    job = engine.generate_take(pid, edit["id"]) if body.generate else None
    return {"edit": edit, "job": job}


class EditPatch(BaseModel):
    text: Optional[str] = Field(None, min_length=1, max_length=2000)
    voice: Optional[Voice] = None
    fit: Optional[Literal["fit", "natural"]] = None
    speed: Optional[float] = Field(None, ge=0.5, le=2.0)
    num_step: Optional[int] = Field(None, ge=4, le=64)
    gain_db: Optional[float] = Field(None, ge=-24, le=24)
    bleed: Optional[float] = Field(None, ge=0, le=1)
    active_take: Optional[str] = None
    locked: Optional[bool] = None
    muted: Optional[bool] = None
    cut_start: Optional[float] = None
    cut_end: Optional[float] = None


@app.patch("/api/projects/{pid}/edits/{eid}")
def patch_edit(pid: str, eid: str, body: EditPatch):
    _edit(_project(pid), eid)
    changes = body.model_dump(exclude_unset=True)
    with store.edit(pid) as p:
        e = store.find_edit(p, eid)
        if e.get("locked") and changes.get("locked") is not False and \
                set(changes) - {"locked", "muted", "gain_db", "bleed"}:
            raise HTTPException(409, "Edit is locked - unlock it first")
        if "active_take" in changes and changes["active_take"] not in {t["id"] for t in e["takes"]}:
            raise HTTPException(400, "Unknown take")
        if "cut_start" in changes or "cut_end" in changes:
            s = changes.pop("cut_start", e["cut_start"])
            t = changes.pop("cut_end", e["cut_end"])
            if t - s < 0.05:
                raise HTTPException(400, "Region is too short")
            if _overlaps(p, s, t, skip=eid):
                raise HTTPException(409, "Overlaps another edit")
            e["cut_start"], e["cut_end"] = round(s, 3), round(t, 3)
        if "voice" in changes and changes["voice"] is not None:
            changes["voice"] = body.voice.model_dump()
        e.update(changes)
    return e


@app.delete("/api/projects/{pid}/edits/{eid}")
def delete_edit(pid: str, eid: str):
    _edit(_project(pid), eid)
    with store.edit(pid) as p:
        p["edits"] = [e for e in p["edits"] if e["id"] != eid]
    shutil.rmtree(store.project_dir(pid) / "takes" / eid, ignore_errors=True)
    return {"ok": True}


@app.post("/api/projects/{pid}/edits/{eid}/generate")
def regenerate(pid: str, eid: str):
    e = _edit(_project(pid), eid)
    if e.get("locked"):
        raise HTTPException(409, "Edit is locked - unlock it to regenerate")
    return engine.generate_take(pid, eid)


@app.delete("/api/projects/{pid}/edits/{eid}/takes/{tid}")
def delete_take(pid: str, eid: str, tid: str):
    _edit(_project(pid), eid)
    with store.edit(pid) as p:
        e = store.find_edit(p, eid)
        if e.get("locked") and e.get("active_take") == tid:
            raise HTTPException(409, "Cannot delete the locked take")
        e["takes"] = [t for t in e["takes"] if t["id"] != tid]
        if e.get("active_take") == tid:
            e["active_take"] = e["takes"][-1]["id"] if e["takes"] else None
    for path in store.take_paths(pid, eid, tid):
        path.unlink(missing_ok=True)
    return e


@app.get("/api/projects/{pid}/edits/{eid}/takes/{tid}.wav")
def take_audio(pid: str, eid: str, tid: str, raw: bool = False):
    if not store.valid_id(eid) or not store.valid_id(tid):
        raise HTTPException(400, "Bad id")
    raw_path, placed = store.take_paths(pid, eid, tid)
    path = raw_path if raw else placed
    if not path.is_file():
        raise HTTPException(404, "Take not found")
    return FileResponse(path, media_type="audio/wav")


@app.get("/api/projects/{pid}/edits/{eid}/preview.wav")
def edit_preview(pid: str, eid: str, take: Optional[str] = None, pad: float = 1.5):
    """Server-mixed snippet around an edit, made by the same mixer as the render."""
    p = _project(pid)
    e = _edit(p, eid)
    tid = take or e.get("active_take")
    places = engine.placements(pid, p, "active", override=(eid, tid) if tid else None)
    end = e["cut_end"]
    for pl in places:
        if abs(pl.start - e["cut_start"]) < 1e-3:
            end = max(end, pl.start + len(pl.audio) / p["source"]["master_sr"])
    pad = min(max(pad, 0.0), 5.0)
    samples, sr = media.mix_window(store.project_dir(pid) / "master.wav", places,
                                   max(0.0, e["cut_start"] - pad), end + pad)
    return Response(media.wav_bytes(samples, sr), media_type="audio/wav")


class RenderBody(BaseModel):
    include: Literal["locked", "active"] = "locked"


@app.post("/api/projects/{pid}/render")
def render(pid: str, body: RenderBody):
    p = _project(pid)
    if p.get("status") != "ready":
        raise HTTPException(409, "Media is still importing")
    return engine.render(pid, body.include)


class CloneRangeBody(BaseModel):
    start: float
    end: float
    name: str


@app.post("/api/projects/{pid}/clone-voice")
def clone_from_range(pid: str, body: CloneRangeBody):
    _project(pid)
    if _voice_path(body.name).exists():
        raise HTTPException(409, "A voice with that name already exists")
    if not 0.5 <= body.end - body.start <= 30:
        raise HTTPException(400, "Pick 0.5–30 s of speech (3–10 s works best)")
    return engine.clone_voice_from_range(pid, body.start, body.end, body.name)


# ------------------------------------------------------------------------ voices

@app.get("/api/voices")
def voices():
    return engine.list_voices()


@app.post("/api/voices")
def create_voice(file: UploadFile = File(...), name: str = Form(...), ref_text: str = Form("")):
    if _voice_path(name).exists():
        raise HTTPException(409, "A voice with that name already exists")
    tmp = Path(tempfile.mkstemp(suffix=Path(file.filename or "a.wav").suffix,
                                dir=config.DATA_DIR)[1])
    engine.copy_upload(file.file, tmp)
    return engine.clone_voice_from_file(tmp, name, ref_text.strip() or None)


class RenameBody(BaseModel):
    name: str


@app.patch("/api/voices/{name}")
def rename_voice(name: str, body: RenameBody):
    src, dst = _voice_path(name), _voice_path(body.name)
    if not src.is_file():
        raise HTTPException(404, "Voice not found")
    if dst.exists():
        raise HTTPException(409, "A voice with that name already exists")
    src.rename(dst)
    if src.with_suffix(".wav").is_file():
        src.with_suffix(".wav").rename(dst.with_suffix(".wav"))
    return {"name": body.name}


@app.delete("/api/voices/{name}")
def delete_voice(name: str):
    path = _voice_path(name)
    if not path.is_file():
        raise HTTPException(404, "Voice not found")
    path.unlink()
    path.with_suffix(".wav").unlink(missing_ok=True)
    return {"ok": True}


@app.get("/api/voices/{name}/audio")
def voice_audio(name: str):
    path = _voice_path(name, ".wav")
    if not path.is_file():
        raise HTTPException(404, "This voice has no stored reference audio")
    return FileResponse(path, media_type="audio/wav")


@app.get("/api/voices/{name}/download")
def voice_download(name: str):
    path = _voice_path(name)
    if not path.is_file():
        raise HTTPException(404, "Voice not found")
    return FileResponse(path, filename=path.name)


# ----------------------------------------------------------------------- outputs

OUTPUT_EXT = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".mp4", ".mkv", ".mov", ".webm"}


@app.get("/api/outputs")
def outputs():
    items = []
    for f in config.OUTPUT_DIR.iterdir() if config.OUTPUT_DIR.is_dir() else []:
        if f.is_file() and f.suffix.lower() in OUTPUT_EXT:
            st = f.stat()
            items.append({"name": f.name, "size": st.st_size, "modified": st.st_mtime,
                          "kind": "video" if f.suffix.lower() in {".mp4", ".mkv", ".mov", ".webm"}
                          else "audio"})
    return sorted(items, key=lambda x: x["modified"], reverse=True)


@app.get("/api/outputs/{name}")
def output_file(name: str, download: bool = False):
    path = _output_path(name)
    return FileResponse(path, filename=path.name if download else None)


@app.delete("/api/outputs/{name}")
def delete_output(name: str):
    _output_path(name).unlink()
    return {"ok": True}


class TTSBody(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    voice: Optional[str] = None
    instruct: Optional[str] = None
    language: str = "auto"
    num_step: int = Field(32, ge=4, le=64)
    speed: Optional[float] = Field(None, ge=0.5, le=2.0)
    name: str = "tts"


@app.post("/api/tts")
def tts(body: TTSBody):
    if body.voice and not _voice_path(body.voice).is_file():
        raise HTTPException(400, "Voice not found")
    name = engine._safe_name(body.name)
    return engine.quick_tts(body.voice, body.text, body.language, body.num_step, body.speed,
                            body.instruct, name)


# ------------------------------------------------------------------------ static

app.mount("/", StaticFiles(directory=config.STATIC_DIR, html=True), name="static")
