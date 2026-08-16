import os

# Wymuszenie tarczy GFX dla gfx1200 (RDNA 4) przed załadowaniem PyTorcha
os.environ["HSA_OVERRIDE_GFX_VERSION"] = "12.0.0"

import torch
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

# Sprawdzenie dostępności GPU
device = "cuda:0" if torch.cuda.is_available() else "cpu"
torch_dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32

print(f"[*] Korzystam z urządzenia: {device} ({torch.cuda.get_device_name(0)})")

model_id = "openai/whisper-large-v3-turbo"

print(f"[*] Ładowanie modelu {model_id}...")

# Ładowanie modelu bezpośrednio do VRAM
model = AutoModelForSpeechSeq2Seq.from_pretrained(
    model_id, 
    torch_dtype=torch_dtype, 
    low_cpu_mem_usage=True, 
    use_safetensors=True
).to(device)

processor = AutoProcessor.from_pretrained(model_id)

# Inicjalizacja pipeline do transkrypcji
pipe = pipeline(
    "automatic-speech-recognition",
    model=model,
    tokenizer=processor.tokenizer,
    feature_extractor=processor.feature_extractor,
    torch_dtype=torch_dtype,
    device=device,
)

# Ścieżka do pliku audio
audio_file = "audio.mp3"  # podmień na własny plik

print(f"[*] Rozpoczynam transkrypcję: {audio_file}...")

# Transkrypcja z opcjami dla języka polskiego i zwracaniem timestampów
result = pipe(
    audio_file, 
    generate_kwargs={"language": "polish", "task": "transcribe"},
    return_timestamps=True,
    chunk_length_s=30,  # Dzielenie długich plików na 30-sekundowe okna
    batch_size=16       # Przy 32 GB VRAM batching 16 da ogromny wzrost prędkości
)

print("\n--- TEKST TRANSKRYPCJI ---")
print(result["text"])

print("\n--- TIMESTAMPY ---")
for chunk in result.get("chunks", []):
    ts = chunk["timestamp"]
    print(f"[{ts[0]:.2f}s -> {ts[1]:.2f}s] {chunk['text']}")
