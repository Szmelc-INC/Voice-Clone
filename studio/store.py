"""On-disk project store: one folder per project with a project.json document.

Layout of studio_data/projects/<id>/:
    project.json        transcript words, edits, takes, settings
    source.<ext>        uploaded media (untouched)
    master.wav          16-bit PCM at <= 48 kHz, used for analysis, cloning and render
    proxy.mp4|m4a       browser-playable copy when the source is not
    peaks.bin           waveform envelope (media.PEAKS_PER_SEC bytes per second)
    takes/<edit>/<take>.raw.wav     model output (24 kHz)
    takes/<edit>/<take>.wav         fitted, loudness-matched take at master rate
"""

import json
import os
import re
import secrets
import shutil
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from . import config

_locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()


def new_id(prefix: str = "") -> str:
    return prefix + secrets.token_hex(4)


def now() -> float:
    return round(time.time(), 3)


def _lock(pid: str) -> threading.RLock:
    with _locks_guard:
        return _locks.setdefault(pid, threading.RLock())


def valid_id(pid: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9_-]{1,64}", pid))


def project_dir(pid: str) -> Path:
    if not valid_id(pid):
        raise KeyError(pid)
    return config.PROJECTS_DIR / pid


def load(pid: str) -> dict:
    path = project_dir(pid) / "project.json"
    if not path.is_file():
        raise KeyError(pid)
    return json.loads(path.read_text(encoding="utf-8"))


def save(project: dict) -> dict:
    project["updated"] = now()
    path = project_dir(project["id"]) / "project.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(project, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)
    return project


@contextmanager
def edit(pid: str) -> Iterator[dict]:
    """Load-modify-save a project under its lock."""
    with _lock(pid):
        project = load(pid)
        yield project
        save(project)


def create(name: str) -> dict:
    pid = new_id("p")
    d = project_dir(pid)
    (d / "takes").mkdir(parents=True)
    project = {
        "id": pid, "name": name, "created": now(), "updated": now(),
        "language": "auto", "source": None, "status": "importing",
        "words": [], "edits": [], "renders": [],
    }
    return save(project)


def list_all() -> list[dict]:
    out = []
    for p in sorted(config.PROJECTS_DIR.glob("*/project.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        out.append({
            "id": data["id"], "name": data["name"], "created": data["created"],
            "updated": data["updated"], "status": data.get("status"),
            "source": data.get("source"), "words": len(data.get("words", [])),
            "edits": len(data.get("edits", [])),
            "locked": sum(1 for e in data.get("edits", []) if e.get("locked")),
        })
    return sorted(out, key=lambda x: x["updated"], reverse=True)


def delete(pid: str) -> None:
    with _lock(pid):
        shutil.rmtree(project_dir(pid))


def find_edit(project: dict, eid: str) -> dict:
    for e in project["edits"]:
        if e["id"] == eid:
            return e
    raise KeyError(eid)


def take_paths(pid: str, eid: str, tid: str) -> tuple[Path, Path]:
    d = project_dir(pid) / "takes" / eid
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{tid}.raw.wav", d / f"{tid}.wav"
