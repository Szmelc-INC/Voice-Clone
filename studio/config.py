"""Paths and runtime settings, overridable through environment variables."""

import os
from pathlib import Path


def _path(env: str, default: str) -> Path:
    return Path(os.environ.get(env, default)).expanduser().resolve()


DATA_DIR = _path("OMNIVOICE_STUDIO_DATA", "studio_data")
PROJECTS_DIR = DATA_DIR / "projects"
VOICES_DIR = _path("OMNIVOICE_VOICES_DIR", "voices")
OUTPUT_DIR = _path("OMNIVOICE_OUTPUT_DIR", "outputs")
STATIC_DIR = Path(__file__).parent / "static"

MODEL_ID = os.environ.get("OMNIVOICE_MODEL", "k2-fsa/OmniVoice")
ASR_MODEL_ID = os.environ.get("OMNIVOICE_ASR_MODEL", "openai/whisper-large-v3-turbo")
DEVICE = os.environ.get("OMNIVOICE_DEVICE", "cuda:0")

TTS_SR = 24000          # OmniVoice output rate
ASR_SR = 16000          # Whisper input rate
MASTER_MAX_SR = 48000   # project master audio is stored at <= 48 kHz

# Whisper language names accepted by the transcription UI ("auto" = detect).
LANGUAGES = [
    "auto", "polish", "english", "german", "french", "spanish", "italian",
    "portuguese", "russian", "ukrainian", "czech", "slovak", "dutch",
    "swedish", "norwegian", "danish", "finnish", "turkish", "japanese",
    "korean", "chinese", "arabic", "hindi",
]


def ensure_dirs() -> None:
    for d in (PROJECTS_DIR, VOICES_DIR, OUTPUT_DIR):
        d.mkdir(parents=True, exist_ok=True)
