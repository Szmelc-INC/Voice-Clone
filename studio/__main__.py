"""Run the studio: python -m studio [--host 127.0.0.1] [--port 7860] [--preload]."""

import argparse
import logging
import os
import webbrowser


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m studio", description=__doc__)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=7860)
    ap.add_argument("--data", help="Studio data dir (default: ./studio_data)")
    ap.add_argument("--voices", help="Voice library dir (default: ./voices)")
    ap.add_argument("--outputs", help="Output dir (default: ./outputs)")
    ap.add_argument("--preload", action="store_true", help="Load Whisper and OmniVoice at startup")
    ap.add_argument("--open", action="store_true", help="Open the UI in a browser")
    args = ap.parse_args()

    # Paths are read by studio.config at import time, so set them first.
    for flag, env in (("data", "OMNIVOICE_STUDIO_DATA"), ("voices", "OMNIVOICE_VOICES_DIR"),
                      ("outputs", "OMNIVOICE_OUTPUT_DIR")):
        if getattr(args, flag):
            os.environ[env] = getattr(args, flag)

    import uvicorn

    from . import config, engine
    from .server import app

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s")
    config.ensure_dirs()
    if args.preload:
        engine.preload()
    url = f"http://{args.host}:{args.port}"
    print(f"\n  OmniVoice Voice Edit Studio → {url}\n")
    if args.open:
        webbrowser.open(url)
    # No reload: the worker threads and loaded models live in this process.
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
