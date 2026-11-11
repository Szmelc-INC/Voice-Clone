"""ffmpeg/numpy helpers: probing, extraction, take fitting and the shared mixer.

The same `mix_window` function produces both the server-side take preview and
the final render, so what you hear in the preview is what gets rendered.
"""

import io
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf

from . import config

BROWSER_VIDEO_CODECS = {"h264", "vp8", "vp9", "av1"}
BROWSER_CONTAINERS = {".mp4", ".webm", ".mov", ".m4v"}
BROWSER_AUDIO_EXT = {".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac", ".opus", ".webm"}
PEAKS_PER_SEC = 200
FADE_SEC = 0.015


def run(cmd: list[str]) -> str:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed: {proc.stderr.strip()[-800:]}")
    return proc.stdout


def probe(path: Path) -> dict:
    info = json.loads(run([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ]))
    streams = info.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"
                  and not s.get("disposition", {}).get("attached_pic")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if audio is None:
        raise ValueError("File has no audio stream")
    return {
        "duration": float(info["format"].get("duration") or audio.get("duration") or 0),
        "has_video": video is not None,
        "video_codec": video.get("codec_name") if video else None,
        "width": int(video["width"]) if video else None,
        "height": int(video["height"]) if video else None,
        "audio_codec": audio.get("codec_name"),
        "sample_rate": int(audio.get("sample_rate", 48000)),
        "channels": int(audio.get("channels", 1)),
    }


def extract_master(src: Path, dst: Path, sr: int, channels: int, duration: float) -> None:
    """Decode the audio on the container clock: a late-starting audio stream is
    padded at the front, a short one with silence at the end, so master time 0
    and length match what the video player shows."""
    run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-vn", "-map", "0:a:0",
         "-af", "aresample=async=1:first_pts=0,apad", "-t", f"{duration:.6f}",
         "-ac", str(channels), "-ar", str(sr), "-c:a", "pcm_s16le", str(dst)])


def needs_proxy(src: Path, info: dict) -> bool:
    if info["has_video"]:
        return (src.suffix.lower() not in BROWSER_CONTAINERS
                or info["video_codec"] not in BROWSER_VIDEO_CODECS)
    return src.suffix.lower() not in BROWSER_AUDIO_EXT


def make_proxy(src: Path, dst: Path, has_video: bool) -> None:
    if has_video:
        run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-map", "0:v:0", "-map", "0:a:0",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
             "-vf", "scale='min(1280,iw)':-2", "-c:a", "aac", "-b:a", "160k",
             "-movflags", "+faststart", str(dst)])
    else:
        run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-vn", "-c:a", "aac",
             "-b:a", "192k", str(dst)])


def compute_peaks(master: Path) -> bytes:
    """Max-abs envelope of the mono mixdown, PEAKS_PER_SEC uint8 values per second."""
    out = bytearray()
    with sf.SoundFile(str(master)) as f:
        hop = max(1, f.samplerate // PEAKS_PER_SEC)
        block = hop * PEAKS_PER_SEC * 10
        for chunk in f.blocks(blocksize=block, dtype="float32", always_2d=True):
            mono = np.abs(chunk).max(axis=1)
            n = len(mono) // hop
            if n:
                out += (np.minimum(mono[: n * hop].reshape(n, hop).max(axis=1), 1.0) * 255
                        ).astype(np.uint8).tobytes()
            if len(mono) % hop:
                out.append(int(min(mono[n * hop:].max(), 1.0) * 255))
    return bytes(out)


def resample(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    if sr_in == sr_out or len(x) == 0:
        return x.astype(np.float32)
    import librosa
    return librosa.resample(x.astype(np.float32), orig_sr=sr_in, target_sr=sr_out,
                            res_type="soxr_hq")


def read_mono(master: Path, start: float, end: float, sr_out: int) -> np.ndarray:
    with sf.SoundFile(str(master)) as f:
        sr = f.samplerate
        a, b = max(0, int(start * sr)), min(f.frames, int(end * sr))
        if b <= a:
            return np.zeros(0, np.float32)
        f.seek(a)
        data = f.read(b - a, dtype="float32", always_2d=True).mean(axis=1)
    return resample(data, sr, sr_out)


def frame_rms(x: np.ndarray, sr: int, frame_sec: float = 0.005) -> np.ndarray:
    hop = max(1, int(sr * frame_sec))
    n = len(x) // hop
    if n == 0:
        return np.zeros(0, np.float32)
    return np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(axis=1) + 1e-12)


def snap_cut(master: Path, t: float, window: float = 0.05) -> float:
    """Move a cut point to the quietest 5 ms frame within +-window seconds."""
    sr = sf.info(str(master)).samplerate
    lo = max(0.0, t - window)
    seg = read_mono(master, lo, t + window, sr)
    rms = frame_rms(seg, sr)
    if len(rms) == 0:
        return t
    hop = int(sr * 0.005)
    # Prefer frames closer to the original point when energies are similar.
    dist = np.abs((np.arange(len(rms)) * hop + hop / 2) / sr + lo - t)
    score = rms * (1 + dist / window)
    return round(lo + (int(score.argmin()) * hop + hop / 2) / sr, 4)


def active_rms(x: np.ndarray, sr: int) -> float:
    """RMS over voiced frames only (within 20 dB of the loudest 20 ms frame)."""
    rms = frame_rms(x, sr, 0.02)
    if len(rms) == 0:
        return 0.0
    voiced = rms[rms > rms.max() * 0.1]
    return float(np.sqrt((voiced ** 2).mean())) if len(voiced) else 0.0


def trim_silence(x: np.ndarray, sr: int, rel_db: float = -40.0, keep: float = 0.02) -> np.ndarray:
    rms = frame_rms(x, sr)
    if len(rms) == 0 or rms.max() <= 1e-6:
        return x
    hop = int(sr * 0.005)
    above = np.nonzero(rms > rms.max() * 10 ** (rel_db / 20))[0]
    a = max(0, above[0] * hop - int(keep * sr))
    b = min(len(x), (above[-1] + 1) * hop + int(keep * sr))
    return x[a:b]


def fade_edges(x: np.ndarray, sr: int, sec: float = 0.008) -> np.ndarray:
    n = min(len(x) // 2, int(sr * sec))
    if n > 0:
        ramp = np.linspace(0, 1, n, dtype=np.float32)
        x = x.copy()
        x[:n] *= ramp
        x[-n:] *= ramp[::-1]
    return x


def prepare_take(raw: np.ndarray, raw_sr: int, out_sr: int, target_dur: Optional[float],
                 reference: Optional[np.ndarray]) -> np.ndarray:
    """Trim, optionally fit to target_dur, loudness-match to the original, resample.

    `reference` is the original audio of the replaced region at `out_sr`.
    Returns mono float32 at `out_sr`.
    """
    x = trim_silence(raw.astype(np.float32), raw_sr)
    if target_dur and target_dur > 0.05 and len(x):
        cur = len(x) / raw_sr
        rate = cur / target_dur
        if abs(rate - 1) > 0.02:
            import librosa
            x = librosa.effects.time_stretch(x, rate=float(np.clip(rate, 0.6, 1.6)))
        n = int(round(target_dur * raw_sr))
        x = x[:n] if len(x) >= n else np.pad(x, (0, n - len(x)))
    x = resample(x, raw_sr, out_sr)
    if reference is not None and len(reference):
        ref_level, take_level = active_rms(reference, out_sr), active_rms(x, out_sr)
        if ref_level > 1e-4 and take_level > 1e-4:
            x = x * float(np.clip(ref_level / take_level, 0.1, 8.0))
    return fade_edges(x, out_sr)


@dataclass
class Placement:
    start: float              # where the take starts (seconds)
    mute_end: float           # original is muted from start to mute_end
    audio: np.ndarray         # mono float32 at the master sample rate
    gain: float = 1.0
    bleed: float = 0.0        # 0..1, how much original stays under the take


def mix_window(master: Path, placements: list[Placement], t0: float = 0.0,
               t1: Optional[float] = None) -> tuple[np.ndarray, int]:
    """Return (samples[T, C], sr) of the master between t0 and t1 with placements applied."""
    with sf.SoundFile(str(master)) as f:
        sr = f.samplerate
        a = max(0, int(t0 * sr))
        b = f.frames if t1 is None else min(f.frames, int(t1 * sr))
        f.seek(a)
        out = f.read(b - a, dtype="float32", always_2d=True)
    n_ch = out.shape[1]
    fade = max(1, int(FADE_SEC * sr))
    env = np.ones(len(out), np.float32)
    for p in placements:
        s = int(round(p.start * sr)) - a
        e = int(round(max(p.mute_end, p.start + len(p.audio) / sr) * sr)) - a
        if e <= 0 or s >= len(out):
            continue
        # Muting envelope with crossfades centred on the cut points.
        lo, hi = max(0, s - fade), min(len(out), e + fade)
        idx = np.arange(lo, hi)
        down = np.clip((idx - (s - fade // 2)) / fade, 0, 1)
        up = np.clip(((e + fade // 2) - idx) / fade, 0, 1)
        mute = np.minimum(down, up)
        env[lo:hi] = np.minimum(env[lo:hi], 1 - mute * (1 - p.bleed))
    out *= env[:, None]
    for p in placements:
        s = int(round(p.start * sr)) - a
        take = p.audio * p.gain
        lo, hi = max(0, s), min(len(out), s + len(take))
        if hi > lo:
            out[lo:hi] += take[lo - s: hi - s, None].repeat(n_ch, axis=1) if take.ndim == 1 \
                else take[lo - s: hi - s]
    np.clip(out, -1.0, 1.0, out=out)
    return out, sr


def wav_bytes(samples: np.ndarray, sr: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, samples, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def mux_video(video_src: Path, audio_wav: Path, dst: Path) -> None:
    acodec = ["-c:a", "libopus", "-b:a", "160k"] if dst.suffix == ".webm" \
        else ["-c:a", "aac", "-b:a", "192k"]
    run(["ffmpeg", "-y", "-v", "error", "-i", str(video_src), "-i", str(audio_wav),
         "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", *acodec, str(dst)])
