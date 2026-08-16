#!/usr/bin/env python3
"""
OmniVoice Interactive CLI
- Loads the model once and keeps it in memory
- Option 1: Clone voice from reference audio and save as .pt
- Option 2: Generate speech using a previously saved voice
"""

import os
import sys
from pathlib import Path

import soundfile as sf
import torch
from omnivoice import OmniVoice, VoiceClonePrompt


# ====================== CONFIG ======================
MODEL_ID = "k2-fsa/OmniVoice"
DEVICE = "cuda:0"
DTYPE = torch.float16
VOICES_DIR = Path("voices")          # folder where .pt prompts are stored
OUTPUT_DIR = Path("outputs")         # folder for generated wav files
# ====================================================


def clear_screen():
    os.system("clear" if os.name != "nt" else "cls")


def ensure_dirs():
    VOICES_DIR.mkdir(exist_ok=True)
    OUTPUT_DIR.mkdir(exist_ok=True)


def load_model():
    print("=" * 60)
    print("Loading OmniVoice model... this will take several minutes.")
    print("=" * 60)
    model = OmniVoice.from_pretrained(
        MODEL_ID,
        device_map=DEVICE,
        dtype=DTYPE,
    )
    print("\nModel loaded successfully and is now resident in memory.\n")
    return model


def read_text_input(prompt: str) -> str:
    """Ask user for text. If they give a path to a .txt file, read its content."""
    value = input(prompt).strip()
    if not value:
        return ""
    path = Path(value)
    if path.is_file() and path.suffix.lower() == ".txt":
        print(f"  → Reading text from file: {path}")
        return path.read_text(encoding="utf-8").strip()
    return value


def clone_and_save_voice(model: OmniVoice):
    print("\n--- Clone & Save Voice ---")
    ref_audio = input("Path to reference audio (3-10 s recommended): ").strip()
    if not ref_audio or not Path(ref_audio).is_file():
        print("Error: reference audio file not found.")
        return

    ref_text = read_text_input(
        "Transcription of the reference audio (optional, press Enter to skip / or path to .txt): "
    )

    voice_name = input("Name for this voice (will be saved as voices/<name>.pt): ").strip()
    if not voice_name:
        print("Error: voice name cannot be empty.")
        return

    save_path = VOICES_DIR / f"{voice_name}.pt"

    print("\nCreating voice clone prompt...")
    try:
        prompt = model.create_voice_clone_prompt(
            ref_audio=ref_audio,
            ref_text=ref_text if ref_text else None,
        )
        prompt.save(str(save_path))
        print(f"Voice saved successfully → {save_path}")
    except Exception as e:
        print(f"Failed to create/save voice: {e}")


def generate_audio(model: OmniVoice):
    print("\n--- Generate Audio ---")

    # List available voices
    voices = sorted(VOICES_DIR.glob("*.pt"))
    if not voices:
        print("No saved voices found. Clone a voice first (option 1).")
        return

    print("Available voices:")
    for i, v in enumerate(voices, 1):
        print(f"  {i}. {v.stem}")

    choice = input("\nSelect voice number or type exact name: ").strip()
    if choice.isdigit() and 1 <= int(choice) <= len(voices):
        voice_path = voices[int(choice) - 1]
    else:
        voice_path = VOICES_DIR / f"{choice}.pt"
        if not voice_path.is_file():
            print(f"Voice not found: {voice_path}")
            return

    text = read_text_input("Text to synthesize (or path to .txt file): ")
    if not text:
        print("Error: text cannot be empty.")
        return

    output_name = input("Output filename (without extension, default: output): ").strip() or "output"
    output_path = OUTPUT_DIR / f"{output_name}.wav"

    print(f"\nLoading voice prompt: {voice_path.name}")
    try:
        prompt = VoiceClonePrompt.load(str(voice_path))
    except Exception as e:
        print(f"Failed to load voice prompt: {e}")
        return

    print("Generating audio... please wait.")
    try:
        audio = model.generate(
            text=text,
            voice_clone_prompt=prompt,
            num_step=16,          # faster; change to 32 for higher quality
        )
        sf.write(str(output_path), audio[0], 24000)
        print(f"Done → {output_path}")
    except Exception as e:
        print(f"Generation failed: {e}")


def main_menu(model: OmniVoice):
    while True:
        print("\n" + "=" * 50)
        print("  OmniVoice CLI  (model is loaded and ready)")
        print("=" * 50)
        print("  1. Clone voice and save")
        print("  2. Generate audio from saved voice")
        print("  3. Exit")
        print("-" * 50)

        choice = input("Select option [1-3]: ").strip()

        if choice == "1":
            clone_and_save_voice(model)
        elif choice == "2":
            generate_audio(model)
        elif choice == "3":
            print("Exiting. Model will be unloaded.")
            break
        else:
            print("Invalid option.")


if __name__ == "__main__":
    ensure_dirs()
    model = load_model()
    try:
        main_menu(model)
    except KeyboardInterrupt:
        print("\nInterrupted by user. Exiting.")
