# Voice-Clone
> Easy voice cloner implementation for [OmniVoice](https://github.com/k2-fsa/OmniVoice)

---

# Contents
- `cli.py` - Main CLI interface for OmniVoice
- `whisper.py` & `whisper2.py` - Transcription with whisper model.
- `voices/*` - Voices i cloned for OmniVoice

---

# Setup
```bash
git clone https://github.com/k2-fsa/OmniVoice
git clone https://github.com/Szmelc-INC/Voice-Clone
mv Voice-Clone/* OmniVoice/ && rm -fr Voice-Clone && cd OmniVoice
```

---

# Usage

1. Start python env
2. Run `python cli.py` in terminal
3. Select 1 to clone voice (provide voice sample + transcript txt)
4. Select 2 to synthesize speech using cloned voice
